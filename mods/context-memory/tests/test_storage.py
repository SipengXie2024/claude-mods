"""CLI tests for the context-memory SQLite storage helper.

All conversation content is real, opened read-only, and each test uses its
own temporary database. Inputs (absolute paths, overridable by environment):

  CONTEXT_MEMORY_TRANSCRIPT       a long real Claude Code transcript
  CONTEXT_MEMORY_LIVE_DB          archive written by the real host during a
                                  live compaction/resume session (a private
                                  sqlite3 backup, kept out of git)
  CONTEXT_MEMORY_LIVE_TRANSCRIPT  transcript of that same live session
  CONTEXT_MEMORY_LEGACY_DB        rows copied from a real archive written before
                                  schema version 1: an installed fork snapshot,
                                  a snapshot whose compaction never installed,
                                  one transcript index and legacy tables

A missing input is an error, never a skipped test.
"""

import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

STORAGE = Path(__file__).resolve().parent.parent / "src" / "storage.py"


def input_path(env, default):
    path = Path(os.environ.get(env, default))
    if not path.is_file():
        raise FileNotFoundError(f"{env}: real test input not found: {path}")
    return path


TRANSCRIPT = input_path(
    "CONTEXT_MEMORY_TRANSCRIPT",
    "/home/ubuntu/.claude/projects/-home-ubuntu-sipeng-re-test/"
    "e84c9c29-5d2e-444c-b954-11c546adedaa.jsonl",
)
LIVE_DB = input_path(
    "CONTEXT_MEMORY_LIVE_DB",
    Path.home() / ".local/share/claude-context-memory-verification/live.sqlite",
)
LEGACY_DB = input_path(
    "CONTEXT_MEMORY_LEGACY_DB",
    Path.home() / ".local/share/claude-context-memory-verification/legacy-archive.sqlite",
)
LIVE_TRANSCRIPT = input_path(
    "CONTEXT_MEMORY_LIVE_TRANSCRIPT",
    "/home/ubuntu/.claude/projects/-tmp-context-memory-live-YTcD9B/"
    "0c055331-edae-4a23-95a5-a40ffcf5d5e0.jsonl",
)


# The transcript may still be growing; freeze complete lines once at import.
with TRANSCRIPT.open("rb") as _f:
    _raw = _f.read()
DATA = _raw[: _raw.rindex(b"\n") + 1]


def load_records():
    return [json.loads(line) for line in DATA.decode("utf-8").split("\n") if line]


def result_text(content):
    if isinstance(content, str):
        return content
    return "\n".join(b["text"] for b in content if b.get("type") == "text")


def to_message(rec):
    """Project one real transcript record into the SDK SessionMessage shape."""
    content = rec["message"]["content"]
    if isinstance(content, str):
        return {"role": rec["type"], "text": content, "toolUses": []}
    texts, uses, results = [], [], []
    for block in content:
        kind = block["type"]
        if kind == "text":
            texts.append(block["text"])
        elif kind == "thinking":
            texts.append(block["thinking"])
        elif kind == "tool_use":
            uses.append({"tool_use_id": block["id"], "tool": block["name"],
                         "input": block["input"]})
        elif kind == "tool_result":
            results.append({"tool_use_id": block["tool_use_id"],
                            "text": result_text(block["content"]),
                            "isError": bool(block.get("is_error"))})
    msg = {"role": rec["type"], "text": "\n".join(texts), "toolUses": uses}
    if results:
        msg["toolResults"] = results
    return msg


def load_live():
    """Read-only extraction of the host-produced snapshots, oldest first."""
    conn = sqlite3.connect(f"file:{LIVE_DB}?mode=ro", uri=True)
    try:
        cps = conn.execute("SELECT id, session, agent FROM checkpoints ORDER BY seq").fetchall()
        out = []
        for cp, session, agent in cps:
            msgs = [json.loads(m) for (m,) in conn.execute(
                "SELECT message FROM items WHERE checkpoint = ? ORDER BY idx", (cp,))]
            parents = [p for (p,) in conn.execute(
                "SELECT parent FROM checkpoint_parents WHERE checkpoint = ?", (cp,))]
            out.append({"id": cp, "session": session, "agent": agent,
                        "messages": msgs, "parents": parents})
        return out
    finally:
        conn.close()


RECORDS = load_records()
SESSION = next(r["sessionId"] for r in RECORDS if r.get("sessionId"))
# Real text standing in for a handoff: the store keeps it opaque.
HANDOFF = next(r["content"] for r in RECORDS if r.get("subtype") == "away_summary")
MESSAGES = [to_message(r) for r in RECORDS if r.get("type") in ("user", "assistant")]
LIVE = load_live()


class Archive:
    def __init__(self, db):
        self.db = db

    def run(self, request, check=True):
        proc = subprocess.run(
            [sys.executable, "-I", str(STORAGE), "--db", str(self.db)],
            input=json.dumps(request),
            capture_output=True,
            text=True,
        )
        if check:
            if proc.returncode != 0:
                raise AssertionError(f"helper failed: {proc.stderr}")
            return json.loads(proc.stdout)
        return proc

    def call(self, op, agent="main", session=SESSION, **fields):
        return self.run({"op": op, "session": session, "agent": agent, **fields})

    def fails(self, op, agent="main", session=SESSION, **fields):
        proc = self.run({"op": op, "session": session, "agent": agent, **fields}, check=False)
        assert proc.returncode != 0, f"expected failure, got {proc.stdout}"
        assert proc.stdout == "", proc.stdout
        return proc.stderr


class StorageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dbdir = Path(self.tmp.name) / "archive"
        self.db = self.dbdir / "archive.sqlite"
        self.a = Archive(self.db)

    def tearDown(self):
        for p in Path(self.tmp.name).rglob("*"):
            os.chmod(p, 0o700)
        self.tmp.cleanup()

    def snap(self, messages, parents=(), agent="main", session=SESSION, **fields):
        return self.a.call("snapshot", agent=agent, session=session, checkpoint=secrets.token_hex(16),
                           handoff=HANDOFF, messages=list(messages), parents=list(parents), **fields)

    def test_snapshot_paging_and_restart(self):
        res = self.snap(MESSAGES)
        cp = res["checkpoint"]
        self.assertRegex(cp, r"^[0-9a-f]{32}$")
        self.assertEqual(res["count"], len(MESSAGES))
        self.assertEqual(stat.S_IMODE(self.dbdir.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.db.stat().st_mode), 0o600)

        # The first user prompt is read back verbatim (each call is a new process).
        first = self.a.call("read", roots=[cp], ref=f"cm:{cp}:0")
        self.assertEqual(first["text"], MESSAGES[0]["text"])
        self.assertEqual(first["role"], "user")
        self.assertEqual(first["source"], "snapshot")
        self.assertIsNone(first["next_offset"])

        # Largest item is paged and reassembles to the full rendered text.
        idx = max(range(len(MESSAGES)),
                  key=lambda i: len(json.dumps(MESSAGES[i], ensure_ascii=False)))
        ref = f"cm:{cp}:{idx}"
        page = self.a.call("read", roots=[cp], ref=ref, limit=3000)
        total = page["total_chars"]
        self.assertGreater(total, 3000)
        parts, offset = [], 0
        while offset is not None:
            page = self.a.call("read", roots=[cp], ref=ref, offset=offset, limit=3000)
            self.assertEqual(page["offset"], offset)
            self.assertLessEqual(len(json.dumps(page, ensure_ascii=False)), 3000 + 1000)
            parts.append(page["text"])
            offset = page["next_offset"]
        full = "".join(parts)
        self.assertEqual(len(full), total)
        for use in MESSAGES[idx]["toolUses"]:
            self.assertIn(f"[tool_use {use['tool']} id={use['tool_use_id']}", full)
        for result in MESSAGES[idx].get("toolResults", []):
            # Result text is stored verbatim, not JSON-escaped.
            self.assertIn(result["text"], full)
        self.assertEqual(MESSAGES[idx]["text"][:200], full[: len(MESSAGES[idx]["text"][:200])])

        # Default and maximum page sizes.
        self.assertLessEqual(len(self.a.call("read", roots=[cp], ref=ref)["text"]), 8000)
        self.a.fails("read", roots=[cp], ref=ref, limit=20001)
        self.a.fails("read", roots=[cp], ref=ref, offset=total + 1)

    def test_search_literal_chinese_and_paging(self):
        cp = self.snap(MESSAGES)["checkpoint"]
        query = "优化对话"
        expected = [i for i, m in enumerate(MESSAGES)
                    if query in json.dumps(m, ensure_ascii=False)]
        self.assertTrue(expected)
        res = self.a.call("search", roots=[cp], query=query, limit=20)
        self.assertEqual(res["total"], len(expected))
        for item in res["items"]:
            self.assertIn(query, item["snippet"])
            self.assertLessEqual(len(item["snippet"]), 500)
            self.assertEqual(item["source"], "snapshot")
        # Pages cover every match exactly once, newest first.
        refs, offset = [], 0
        while offset is not None:
            res = self.a.call("search", roots=[cp], query=query, offset=offset, limit=3)
            refs += [i["ref"] for i in res["items"]]
            offset = res["next_offset"]
        self.assertEqual(refs, [f"cm:{cp}:{i}" for i in reversed(expected)])
        # FTS syntax is matched literally.
        syntax = '"NEAR" OR *'
        res = self.a.call("search", roots=[cp], query=syntax, limit=20)
        conn = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True)
        try:
            texts = [t for (t,) in conn.execute(
                "SELECT coalesce(search_text, rendered) FROM items WHERE searchable = 1")]
        finally:
            conn.close()
        self.assertEqual(res["total"], sum(syntax in t for t in texts))
        self.assertTrue(all(syntax in i["snippet"] for i in res["items"]))
        # Empty query lists recent items.
        recent = self.a.call("search", roots=[cp], query="")
        self.assertEqual(recent["total"], len(MESSAGES))
        self.assertEqual(recent["items"][0]["ref"], f"cm:{cp}:{len(MESSAGES) - 1}")
        self.assertEqual(len(recent["items"]), 10)
        self.a.fails("search", roots=[cp], query="", limit=21)

    def replay_live(self):
        """Store the host's real snapshots in the test archive, keeping lineage."""
        ids = {}
        for cp in LIVE:
            res = self.snap(cp["messages"], parents=[ids[p] for p in cp["parents"]],
                            agent=cp["agent"], session=cp["session"])
            ids[cp["id"]] = res["checkpoint"]
        return ids

    def test_live_history_tools_filtered_but_readable(self):
        ids = self.replay_live()
        child = LIVE[-1]
        root = ids[child["id"]]
        msgs = child["messages"]
        history = {u["tool_use_id"] for m in msgs for u in m["toolUses"]
                   if u["tool"].startswith("mcp__context-memory__history_")}
        self.assertTrue(history)
        hist_items = [i for i, m in enumerate(msgs)
                      if any(u["tool_use_id"] in history for u in m["toolUses"])
                      or any(r["tool_use_id"] in history for r in m.get("toolResults") or [])]
        handoff_items = [i for i, m in enumerate(msgs)
                         if m["text"].startswith("[context-memory checkpoint=")]
        self.assertTrue(handoff_items)
        excluded = {f"cm:{root}:{i}" for i in hist_items + handoff_items}
        listed = []
        offset = 0
        while offset is not None:
            res = self.a.call("search", session=child["session"], roots=[root], query="",
                              offset=offset, limit=20)
            listed += [i["ref"] for i in res["items"]]
            offset = res["next_offset"]
        self.assertFalse(excluded & set(listed))
        total_items = sum(len(cp["messages"]) for cp in LIVE)
        self.assertEqual(len(listed), total_items - len(excluded))
        # Results of history tools are still readable verbatim.
        for i in hist_items:
            got = self.a.call("read", session=child["session"], roots=[root],
                              ref=f"cm:{root}:{i}", limit=20000)
            for r in msgs[i].get("toolResults") or []:
                self.assertIn(r["text"][:2000], got["text"])
            for u in msgs[i]["toolUses"]:
                self.assertIn(f"[tool_use {u['tool']} id={u['tool_use_id']}", got["text"])

    def test_live_tool_text_not_duplicated(self):
        ids = self.replay_live()
        first = LIVE[0]
        root = ids[first["id"]]
        msgs = first["messages"]
        standalone = {r["tool_use_id"] for m in msgs for r in m.get("toolResults") or []}
        pages = [self.a.call("read", session=first["session"], roots=[root],
                             ref=f"cm:{root}:{i}", limit=20000)["text"] for i in range(len(msgs))]
        whole = "".join(pages)
        checked = 0
        for m, got in zip(msgs, pages):
            self.assertTrue(got.startswith(m["text"]))
            for u in m["toolUses"]:
                self.assertIn(f"[tool_use {u['tool']} id={u['tool_use_id']}", got)
                self.assertNotIn(json.dumps(u.get("result"), ensure_ascii=False, sort_keys=True),
                                 got)
                if u.get("text") and u["tool_use_id"] in standalone:
                    # Rendered once in the whole snapshot, at the standalone result.
                    self.assertNotIn(u["text"], got)
                    self.assertEqual(whole.count(u["text"]), 1)
                    checked += 1
        self.assertGreater(checked, 0)
        for m, got in zip(msgs, pages):
            for r in m.get("toolResults") or []:
                self.assertIn(r["text"], got)
                self.assertNotIn(json.dumps(r["text"], ensure_ascii=False), got)

    def test_live_fork_inheritance(self):
        ids = self.replay_live()
        main = LIVE[-1]
        root = ids[main["id"]]
        session = main["session"]
        oldest = ids[LIVE[0]["id"]]
        ref = f"cm:{oldest}:0"
        # A forked child agent reads the parent's context only when inherited.
        self.a.fails("read", session=session, agent="agent-fork", roots=[root], ref=ref)
        got = self.a.call("read", session=session, agent="agent-fork", inherited=True,
                          roots=[root], ref=ref)
        self.assertEqual(got["text"], LIVE[0]["messages"][0]["text"])
        self.assertEqual(self.a.call("status", session=session, agent="agent-fork",
                                     inherited=True, roots=[root])["checkpoints"], len(LIVE))
        self.a.fails("search", session=session, agent="agent-fork", roots=[root], query="")
        self.a.fails("get_handoff", session=session, agent="agent-fork", roots=[root],
                     checkpoint=oldest)
        fork_snapshot = dict(checkpoint=secrets.token_hex(16), handoff=HANDOFF,
                             messages=MESSAGES[:2], parents=[root])
        # Inheritance never crosses sessions.
        self.a.fails("read", session="other-session", agent="agent-fork", inherited=True,
                     roots=[root], ref=ref)
        # A child snapshot keeps the main ancestors through its own root.
        self.a.fails("snapshot", session=session, agent="agent-fork", **fork_snapshot)
        child = self.a.call("snapshot", session=session, agent="agent-fork", inherited=True,
                            **fork_snapshot)["checkpoint"]
        got = self.a.call("read", session=session, agent="agent-fork", roots=[child], ref=ref)
        self.assertEqual(got["text"], LIVE[0]["messages"][0]["text"])
        res = self.a.call("search", session=session, agent="agent-fork", roots=[child],
                          query="", limit=20)
        self.assertEqual(res["total"], 2 + self.a.call(
            "search", session=session, roots=[root], query="")["total"])
        # The main agent cannot read the child's snapshot.
        self.a.fails("read", session=session, roots=[child], ref=f"cm:{child}:0")

    def test_roots_scope_parents_and_agents(self):
        cp1 = self.snap(MESSAGES[:10])["checkpoint"]
        cp2 = self.snap(MESSAGES[10:20], parents=[cp1])["checkpoint"]
        orphan = self.snap(MESSAGES[20:30])["checkpoint"]
        # Inheritance across sessions is allowed for the same agent.
        cp3 = self.snap(MESSAGES[30:40], parents=[cp2], session="other-session")["checkpoint"]
        sub = self.snap(MESSAGES[40:50], agent="agent-x")["checkpoint"]

        self.assertEqual(self.a.call("read", session="other-session", roots=[cp3],
                                     ref=f"cm:{cp1}:0")["text"], MESSAGES[0]["text"])
        # An orphan of the same session is not readable without being a root.
        self.a.fails("read", roots=[cp2], ref=f"cm:{orphan}:0")
        self.assertEqual(self.a.call("search", roots=[cp2], query="")["total"], 20)
        self.assertEqual(self.a.call("status", roots=[cp3])["items"], 30)
        # Agent isolation.
        self.a.fails("read", agent="agent-x", roots=[cp1], ref=f"cm:{cp1}:0")
        self.a.fails("read", roots=[sub], ref=f"cm:{sub}:0")
        self.assertRaises(AssertionError, self.snap, MESSAGES[:1], parents=[sub])
        self.assertRaises(AssertionError, self.snap, MESSAGES[:1], parents=[cp1], agent="agent-x")
        got = self.a.call("read", agent="agent-x", roots=[sub], ref=f"cm:{sub}:0", limit=20000)
        self.assertTrue(got["text"].startswith(MESSAGES[40]["text"]))
        self.assertEqual(got["role"], MESSAGES[40]["role"])

    def test_unknown_and_invalid_references_fail(self):
        cp = self.snap(MESSAGES[:5])["checkpoint"]
        missing = "0" * 32
        self.assertRaises(AssertionError, self.snap, MESSAGES[:1], parents=[missing])
        self.a.fails("read", roots=[missing], ref=f"cm:{missing}:0")
        self.a.fails("read", roots=[cp], ref=f"cm:{cp}:5")
        self.a.fails("read", roots=[cp], ref="row:abc")
        self.a.fails("read", roots=[cp], ref=f"cm:{cp}:-1")
        self.a.fails("search", roots=[missing], query="")
        self.a.fails("bogus")
        self.assertRaises(AssertionError, self.snap, [{"role": "user"}])
        self.assertRaises(AssertionError, self.snap, [{"role": "assistant", "text": "", "toolUses": [
            {"name": "Read", "id": "x", "input": {}}]}])
        # The caller names the checkpoint; a malformed or reused id and a missing handoff fail.
        good = dict(handoff=HANDOFF, messages=MESSAGES[:1], parents=[])
        self.a.fails("snapshot", checkpoint="X" * 32, **good)
        self.a.fails("snapshot", checkpoint=cp, **good)
        self.a.fails("snapshot", checkpoint=secrets.token_hex(16), messages=MESSAGES[:1], parents=[])
        self.assertEqual(self.a.call("status", roots=[cp])["items"], 5)
        self.a.fails("read", roots=[cp], ref=f"cm:{cp}:0", inherited="yes")

    def test_snapshot_writes_its_handoff(self):
        cp = secrets.token_hex(16)
        self.assertEqual(self.a.call("snapshot", checkpoint=cp, handoff=HANDOFF,
                                     messages=MESSAGES[:5], parents=[]),
                         {"checkpoint": cp, "count": 5})
        self.assertEqual(self.a.call("get_handoff", roots=[cp], checkpoint=cp),
                         {"checkpoint": cp, "text": HANDOFF})
        # Text is stored once per item unless its searchable text differs.
        conn = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True)
        try:
            columns = [r[1] for r in conn.execute("PRAGMA table_info(items)")]
            separate = conn.execute(
                "SELECT count(*) FROM items WHERE search_text IS NOT NULL").fetchone()[0]
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        finally:
            conn.close()
        self.assertNotIn("message", columns)
        self.assertEqual(separate, 0)
        self.assertFalse(tables & {"observed", "transcript_search", "transcript_rows", "sync_state"})

    def test_sync_original_transcript_read_only(self):
        mtime_before = TRANSCRIPT.stat().st_mtime_ns
        res = self.a.call("sync", path=str(TRANSCRIPT))
        self.assertGreaterEqual(res["coverage"]["bytes"], len(DATA))
        self.assertGreater(res["count"], 0)
        # The live file may only have grown from appends; its frozen prefix is intact.
        with TRANSCRIPT.open("rb") as f:
            self.assertEqual(f.read(len(DATA)), DATA)
        self.assertGreaterEqual(TRANSCRIPT.stat().st_mtime_ns, mtime_before)
        self.assertEqual(stat.S_IMODE(TRANSCRIPT.stat().st_mode), 0o600)

    def test_sync_frozen_transcript_history(self):
        frozen = Path(self.tmp.name) / "frozen.jsonl"
        frozen.write_bytes(DATA)
        os.chmod(frozen, 0o400)
        res = self.a.call("sync", path=str(frozen))
        conv = [r for r in RECORDS if r.get("type") in ("user", "assistant")
                or (r.get("type") == "system" and r.get("subtype") == "compact_boundary")]
        self.assertEqual(res["count"], len(conv))
        # Active chain: walk parents from the last conversational record.
        by_uuid = {r["uuid"]: r for r in RECORDS if r.get("uuid")}
        conv_ids = {r["uuid"] for r in conv}
        cur, chain = conv[-1], 0
        while cur is not None:
            chain += cur["uuid"] in conv_ids
            parent = cur.get("parentUuid") or cur.get("logicalParentUuid")
            cur = by_uuid.get(parent) if parent else None
        self.assertEqual(res["active_count"], chain)
        self.assertLess(chain, len(conv))
        self.assertEqual(res["coverage"], {"path": str(frozen), "bytes": len(DATA),
                                           "trailing_incomplete": False})
        self.assertEqual(frozen.read_bytes(), DATA)
        status = self.a.call("status", roots=[])
        self.assertEqual(status["coverage"], [res["coverage"]])
        self.assertEqual(status.get("transcript_path"), str(frozen))
        expected_roots = [m.group(1) for r in RECORDS if r.get("type") == "user"
                          and isinstance(r["message"]["content"], str)
                          for m in [re.match(r"^\[context-memory checkpoint=([0-9a-f]{32})\]",
                                             r["message"]["content"])] if m]
        self.assertEqual(res["roots"], expected_roots)
        # Re-sync is idempotent.
        self.assertEqual(self.a.call("sync", path=str(frozen)), res)

    def test_sync_trailing_incomplete_and_corruption(self):
        data = DATA
        cut = data.index(b"\n", len(data) // 2) + 1
        partial = Path(self.tmp.name) / "partial.jsonl"
        partial.write_bytes(data[: cut + 50])
        res = self.a.call("sync", path=str(partial))
        self.assertEqual(res["coverage"]["bytes"], cut)
        self.assertTrue(res["coverage"]["trailing_incomplete"])
        partial.write_bytes(data)
        res = self.a.call("sync", path=str(partial))
        self.assertFalse(res["coverage"]["trailing_incomplete"])
        self.assertEqual(res["coverage"]["bytes"], len(data))
        # A damaged line that is not the last one is an error.
        broken = Path(self.tmp.name) / "broken.jsonl"
        broken.write_bytes(data[: cut + 50] + b"\n" + data[cut:])
        self.a.fails("sync", path=str(broken))

    def test_get_handoff_scope(self):
        cp1 = self.snap(MESSAGES[:5])["checkpoint"]
        self.assertEqual(self.a.call("get_handoff", roots=[cp1], checkpoint=cp1),
                         {"checkpoint": cp1, "text": HANDOFF})
        # A child in another session inherits the parent's handoff for the same agent.
        cp2 = self.snap(MESSAGES[5:8], parents=[cp1], session="other-session")["checkpoint"]
        self.assertEqual(self.a.call("get_handoff", session="other-session", roots=[cp2],
                                     checkpoint=cp1)["text"], HANDOFF)
        orphan = self.snap(MESSAGES[8:9])["checkpoint"]
        self.a.fails("get_handoff", roots=[orphan], checkpoint=cp1)
        self.a.fails("get_handoff", agent="agent-x", roots=[cp1], checkpoint=cp1)

    def test_legacy_archive_migrates_in_place(self):
        self.dbdir.mkdir(mode=0o700)
        shutil.copyfile(LEGACY_DB, self.db)
        old = sqlite3.connect(f"file:{LEGACY_DB}?mode=ro", uri=True)
        try:
            installed = [r[0] for r in old.execute(
                "SELECT id FROM checkpoints WHERE id IN (SELECT checkpoint FROM handoffs)")]
            dropped = [r[0] for r in old.execute(
                "SELECT id FROM checkpoints WHERE id NOT IN (SELECT checkpoint FROM handoffs)")]
            self.assertTrue(installed and dropped)
            session, agent = old.execute(
                "SELECT session, agent FROM checkpoints WHERE id = ?", installed[:1]).fetchone()
            items = old.execute(
                "SELECT idx, rendered FROM items WHERE checkpoint = ? ORDER BY idx", installed[:1]).fetchall()
            (path,) = old.execute("SELECT path FROM transcript_cursor").fetchone()
            t_session, t_agent = old.execute("SELECT session, agent FROM transcript_cursor").fetchone()
            active = old.execute(
                "SELECT e.uuid, e.rendered FROM transcript_entries e JOIN transcript_active a"
                " USING (session, agent, path, uuid) ORDER BY e.line_no DESC LIMIT 5").fetchall()
            query = "优化对话"
            searched = old.execute(
                "SELECT count(*) FROM transcript_search WHERE instr(body, ?) > 0", (query,)).fetchone()[0]
        finally:
            old.close()
        size = self.db.stat().st_size
        cp = installed[0]
        self.assertEqual(self.a.call("status", session=session, agent=agent, inherited=True,
                                     roots=[cp])["items"], len(items))
        for idx, rendered in items[:: max(1, len(items) // 10)]:
            got = self.a.call("read", session=session, agent=agent, inherited=True, roots=[cp],
                              ref=f"cm:{cp}:{idx}", limit=20000)
            self.assertEqual(got["text"], rendered[:20000])
        self.a.fails("read", session=session, agent=agent, inherited=True, roots=[cp],
                     ref=f"cm:{dropped[0]}:0")
        for uuid, rendered in active:
            got = self.a.call("read", session=t_session, agent=t_agent, roots=[],
                              ref=f"row:{uuid}", limit=20000)
            self.assertEqual(got["text"], rendered[:20000])
        self.assertTrue(searched)
        self.assertGreaterEqual(self.a.call("search", session=t_session, agent=t_agent, roots=[],
                                            query=query)["total"], 1)
        conn = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True)
        try:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], 1)
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            self.assertEqual(conn.execute(
                "SELECT count(*) FROM checkpoints WHERE id IN (%s)" % ",".join("?" * len(dropped)),
                dropped).fetchone()[0], 0)
        finally:
            conn.close()
        self.assertFalse(tables & {"observed", "transcript_search", "transcript_rows", "sync_state",
                                   "legacy_items", "legacy_entries"})
        self.assertLess(self.db.stat().st_size, size // 2)
        # The migrated archive keeps indexing the same transcript from its cursor.
        if Path(path).is_file():
            self.assertGreaterEqual(self.a.call("sync", session=t_session, agent=t_agent,
                                                path=path)["count"], len(active))

    def test_transcript_rows_read_and_search(self):
        frozen = Path(self.tmp.name) / "frozen.jsonl"
        frozen.write_bytes(DATA)
        self.a.fails("read", roots=[], ref=f"row:{RECORDS[0].get('uuid')}")
        self.a.call("sync", path=str(frozen))
        conv = [r for r in RECORDS if r.get("type") in ("user", "assistant")]
        by_uuid = {r["uuid"]: r for r in RECORDS if r.get("uuid")}
        active, cur = [], conv[-1]
        while cur is not None:
            active.append(cur)
            parent = cur.get("parentUuid") or cur.get("logicalParentUuid")
            cur = by_uuid.get(parent) if parent else None
        active_conv = [r for r in active if r.get("type") in ("user", "assistant")]
        active_ids = {r["uuid"] for r in active_conv}
        inactive = next(r for r in conv if r["uuid"] not in active_ids)

        first_user = next(r for r in reversed(active_conv)
                          if isinstance(r["message"]["content"], str))
        got = self.a.call("read", roots=[], ref=f"row:{first_user['uuid']}")
        self.assertEqual(got["text"], first_user["message"]["content"])
        self.assertEqual(got["source"], "transcript")
        self.a.fails("read", roots=[], ref=f"row:{inactive['uuid']}")
        self.a.fails("read", roots=[], ref="row:no-such-uuid")
        self.a.fails("read", agent="agent-x", roots=[], ref=f"row:{first_user['uuid']}")
        self.a.fails("read", session="other-session", roots=[], ref=f"row:{first_user['uuid']}")

        query = "优化对话"
        expected = {f"row:{r['uuid']}" for r in active_conv
                    if query in json.dumps(r["message"], ensure_ascii=False)}
        self.assertTrue(expected)
        cp = self.snap(MESSAGES[:4])["checkpoint"]
        refs, sources, offset = [], set(), 0
        while offset is not None:
            res = self.a.call("search", roots=[cp], query=query, offset=offset, limit=20)
            for item in res["items"]:
                refs.append(item["ref"])
                sources.add(item["source"])
                self.assertLessEqual(len(item["snippet"]), 500)
            offset = res["next_offset"]
        row_refs = [r for r in refs if r.startswith("row:")]
        self.assertEqual(len(row_refs), len(set(row_refs)))
        self.assertEqual(set(row_refs), expected)
        self.assertEqual(sources, {"transcript", "snapshot"})
        self.assertTrue(all(r.startswith("row:") for r in refs[: len(row_refs)]))
        # Without a sync, another agent sees no transcript rows.
        self.assertEqual(self.a.call("search", agent="agent-x", roots=[], query="")["total"], 0)

    def test_sync_live_compact_boundary_and_roots(self):
        raw = LIVE_TRANSCRIPT.read_bytes()
        recs = [json.loads(l) for l in raw.decode("utf-8").split("\n") if l]
        session = next(r["sessionId"] for r in recs if r.get("sessionId"))
        boundary = next(r for r in recs if r.get("subtype") == "compact_boundary")
        self.assertIsNone(boundary["parentUuid"])
        self.assertTrue(boundary["logicalParentUuid"])
        res = self.a.call("sync", session=session, path=str(LIVE_TRANSCRIPT))
        self.assertEqual(LIVE_TRANSCRIPT.read_bytes(), raw)
        conv = [r for r in recs if r.get("type") in ("user", "assistant")
                or r.get("subtype") == "compact_boundary"]
        self.assertEqual(res["count"], len(conv))
        # The handoff written by the host names the pre-compaction checkpoint.
        handoff = next(r for r in recs if r.get("type") == "user"
                       and isinstance(r["message"]["content"], str)
                       and r["message"]["content"].startswith("[context-memory checkpoint="))
        self.assertEqual(res["roots"], [LIVE[0]["id"]])
        self.assertIn(LIVE[0]["id"], handoff["message"]["content"][:80])
        # The active chain crosses the boundary through logicalParentUuid.
        first = conv[0]
        got = self.a.call("read", session=session, roots=[], ref=f"row:{first['uuid']}")
        self.assertEqual(got["text"], first["message"]["content"])
        got = self.a.call("read", session=session, roots=[], ref=f"row:{boundary['uuid']}")
        self.assertEqual(got["text"], boundary["content"])
        self.assertEqual(got["role"], "system")
        got = self.a.call("read", session=session, roots=[], ref=f"row:{handoff['uuid']}")
        self.assertEqual(got["text"], handoff["message"]["content"])
        # Handoff text and history tool excerpts are not search candidates.
        res = self.a.call("search", session=session, roots=[],
                          query="[context-memory checkpoint=", limit=20)
        self.assertEqual(res["total"], 0)
        hist = {b["id"] for r in recs if r.get("type") == "assistant"
                for b in r["message"]["content"]
                if b.get("type") == "tool_use" and b["name"].startswith("mcp__context-memory__history_")}
        self.assertTrue(hist)
        hist_rows = {f"row:{r['uuid']}" for r in recs if r.get("type") in ("user", "assistant")
                     and isinstance(r["message"]["content"], list)
                     and any(b.get("id") in hist or b.get("tool_use_id") in hist
                             for b in r["message"]["content"])}
        listed, offset = set(), 0
        while offset is not None:
            page = self.a.call("search", session=session, roots=[], query="", offset=offset, limit=20)
            listed |= {i["ref"] for i in page["items"]}
            offset = page["next_offset"]
        self.assertFalse(hist_rows & listed)
        self.assertIn(f"row:{first['uuid']}", listed)

    def index_state(self, archive, path):
        """What a caller can observe of an indexed transcript: counts, roots, listing, reads."""
        res = archive.call("sync", path=str(path))
        listing, offset = [], 0
        while offset is not None:
            page = archive.call("search", roots=[], query="", offset=offset, limit=20)
            listing.extend((i["ref"], i["role"], i["snippet"]) for i in page["items"])
            offset = page["next_offset"]
        step = max(1, len(listing) // 15)
        reads = [archive.call("read", roots=[], ref=ref, limit=20000)["text"]
                 for ref, _, _ in listing[::step]]
        return res, listing, reads

    def test_incremental_sync_matches_full_sync(self):
        conv = [r for r in RECORDS if r.get("uuid") and (r.get("type") in ("user", "assistant") or (
            r.get("type") == "system" and r.get("subtype") == "compact_boundary"))]
        by_uuid = {r["uuid"]: r for r in RECORDS if r.get("uuid")}
        final_chain, cur = set(), conv[-1]
        while cur is not None and cur["uuid"] not in final_chain:
            final_chain.add(cur["uuid"])
            parent = cur.get("parentUuid") or cur.get("logicalParentUuid")
            cur = by_uuid.get(parent) if parent else None
        ends, pos = {}, 0
        for line in DATA.split(b"\n")[:-1]:
            pos += len(line) + 1
            if line:
                rec = json.loads(line)
                if isinstance(rec, dict) and rec.get("uuid"):
                    ends[rec["uuid"]] = pos
        # A prefix that ends on an abandoned branch makes the next sync move the chain back.
        abandoned = next(ends[r["uuid"]] for r in conv if r["uuid"] not in final_chain)
        quarter = DATA.index(b"\n", len(DATA) // 4) + 1
        cuts = sorted({quarter, abandoned, len(DATA) // 2 + 37, DATA.index(b"\n", 3 * len(DATA) // 4) + 1, len(DATA)})
        path = Path(self.tmp.name) / "growing.jsonl"
        for cut in cuts:
            path.write_bytes(DATA[:cut])
            self.a.call("sync", path=str(path))
        full = Archive(Path(self.tmp.name) / "full" / "archive.sqlite")
        self.assertEqual(self.index_state(self.a, path), self.index_state(full, path))

    def test_cursor_reads_only_new_bytes(self):
        path = Path(self.tmp.name) / "growing.jsonl"
        cut = DATA.index(b"\n", len(DATA) // 2) + 1
        path.write_bytes(DATA[:cut])
        self.a.call("sync", path=str(path))
        # Join two early lines, far before the cursor's tail window; a full parse rejects it.
        joint = DATA.index(b"\n", len(DATA) // 8)
        self.assertLess(joint, cut - 4096)
        path.write_bytes(DATA[:joint] + b" " + DATA[joint + 1:])
        res = self.a.call("sync", path=str(path))
        self.assertEqual(res["coverage"]["bytes"], len(DATA))
        Archive(Path(self.tmp.name) / "fresh" / "archive.sqlite").fails("sync", path=str(path))

    def test_rewritten_transcript_is_reindexed(self):
        path = Path(self.tmp.name) / "session.jsonl"
        path.write_bytes(DATA)
        self.a.call("sync", path=str(path))
        live = LIVE_TRANSCRIPT.read_bytes()
        path.write_bytes(live[: live.rindex(b"\n") + 1])
        fresh = Archive(Path(self.tmp.name) / "fresh" / "archive.sqlite")
        self.assertEqual(self.index_state(self.a, path), self.index_state(fresh, path))

    def test_read_only_database_fails(self):
        self.snap(MESSAGES[:2])
        os.chmod(self.db, 0o400)
        os.chmod(self.dbdir, 0o500)
        err = self.a.fails("snapshot", checkpoint=secrets.token_hex(16), handoff=HANDOFF,
                           messages=MESSAGES[:2], parents=[])
        self.assertRegex(err, re.compile("readonly|read-only|permission", re.I))


if __name__ == "__main__":
    unittest.main()
