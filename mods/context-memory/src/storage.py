"""SQLite history archive helper for the context-memory mod.

Usage: python3 -I storage.py --db /abs/archive.sqlite  < request.json
Reads one JSON request object from stdin and writes one JSON result to stdout.
Any error propagates as an exception and a non-zero exit status.
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

READ_DEFAULT_LIMIT = 8000
READ_MAX_LIMIT = 20000
SEARCH_DEFAULT_LIMIT = 10
SEARCH_MAX_LIMIT = 20
SNIPPET_CHARS = 500
SNIPPET_LEAD = 200

HANDOFF_PREFIX = "[context-memory checkpoint="
HISTORY_TOOL_PREFIX = "mcp__context-memory__history_"

CHECKPOINT_RE = re.compile(r"^[0-9a-f]{32}$")
REF_RE = re.compile(r"^cm:([0-9a-f]{32}):(0|[1-9][0-9]*)$")
ROW_REF_RE = re.compile(r"^row:(.+)$")
HANDOFF_MARK_RE = re.compile(r"^\[context-memory checkpoint=([0-9a-f]{32})\]")
ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")

SCHEMA = """
CREATE TABLE IF NOT EXISTS checkpoints (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  session TEXT NOT NULL,
  agent TEXT NOT NULL,
  created_at REAL NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoint_parents (
  checkpoint TEXT NOT NULL REFERENCES checkpoints(id),
  parent TEXT NOT NULL REFERENCES checkpoints(id),
  PRIMARY KEY (checkpoint, parent)
);
-- Text is stored once: search_text is NULL when the searchable text equals the
-- rendered text, and set only for the rows that drop history-tool parts.
CREATE TABLE IF NOT EXISTS items (
  checkpoint TEXT NOT NULL REFERENCES checkpoints(id),
  idx INTEGER NOT NULL,
  role TEXT NOT NULL,
  source TEXT NOT NULL,
  searchable INTEGER NOT NULL,
  rendered TEXT NOT NULL,
  search_text TEXT,
  PRIMARY KEY (checkpoint, idx)
);
CREATE TABLE IF NOT EXISTS handoffs (
  checkpoint TEXT PRIMARY KEY REFERENCES checkpoints(id),
  session TEXT NOT NULL,
  agent TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at REAL NOT NULL
);
-- One cursor per indexed transcript: how far it has been read, a digest of the
-- bytes just before that point (a rewritten file no longer matches it), and the
-- newest conversation record the active chain was walked from.
CREATE TABLE IF NOT EXISTS transcript_cursor (
  session TEXT NOT NULL,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  line_no INTEGER NOT NULL,
  tail_hash TEXT NOT NULL,
  chain_tip TEXT,
  trailing_incomplete INTEGER NOT NULL,
  synced_at REAL NOT NULL,
  PRIMARY KEY (session, agent, path)
);
-- Conversation records, written once and never rewritten. Text is stored once,
-- as in items.
CREATE TABLE IF NOT EXISTS transcript_entries (
  session TEXT NOT NULL,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  uuid TEXT NOT NULL,
  role TEXT NOT NULL,
  searchable INTEGER NOT NULL,
  rendered TEXT NOT NULL,
  search_text TEXT,
  PRIMARY KEY (session, agent, path, line_no)
);
CREATE INDEX IF NOT EXISTS transcript_entries_uuid
  ON transcript_entries (session, agent, path, uuid, line_no);
-- Parent of every record that has a uuid; the active chain passes through
-- non-conversation records too.
CREATE TABLE IF NOT EXISTS transcript_links (
  session TEXT NOT NULL,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  uuid TEXT NOT NULL,
  parent TEXT,
  PRIMARY KEY (session, agent, path, uuid)
);
CREATE TABLE IF NOT EXISTS transcript_active (
  session TEXT NOT NULL,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  uuid TEXT NOT NULL,
  PRIMARY KEY (session, agent, path, uuid)
);
CREATE TABLE IF NOT EXISTS transcript_tools (
  session TEXT NOT NULL,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  PRIMARY KEY (session, agent, path, tool_use_id)
);
CREATE TABLE IF NOT EXISTS transcript_handoffs (
  session TEXT NOT NULL,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  uuid TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  PRIMARY KEY (session, agent, path, line_no)
);
"""

TRANSCRIPT_TABLES = ("transcript_entries", "transcript_links",
                     "transcript_active", "transcript_tools", "transcript_handoffs")
TAIL_BYTES = 4096


def require(cond, message):
    if not cond:
        raise ValueError(message)


def field(req, name, kind, optional=False):
    if name not in req or req[name] is None:
        require(optional, f"missing field: {name}")
        return None
    value = req[name]
    ok = isinstance(value, kind) and not (kind is int and isinstance(value, bool))
    require(ok, f"field {name} must be {kind.__name__}")
    return value


def checkpoint_id(value, name):
    require(isinstance(value, str) and CHECKPOINT_RE.match(value), f"invalid {name}: {value!r}")
    return value


def dumps(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


SCHEMA_VERSION = 1

# Archives written before SCHEMA_VERSION 1 kept every snapshot message twice more
# (raw JSON and an identical search copy), the transcript text in two tables,
# full message bodies of observed appends, snapshots of compactions that never
# installed, and two tables of an earlier transcript index.
LEGACY_MIGRATION = """
DROP TABLE IF EXISTS transcript_rows;
DROP TABLE IF EXISTS sync_state;
DROP TABLE IF EXISTS observed;
CREATE TEMP TABLE uninstalled AS
  SELECT id FROM checkpoints
  WHERE id NOT IN (SELECT checkpoint FROM handoffs)
    AND id NOT IN (SELECT parent FROM checkpoint_parents);
DELETE FROM items WHERE checkpoint IN (SELECT id FROM uninstalled);
DELETE FROM checkpoint_parents WHERE checkpoint IN (SELECT id FROM uninstalled);
DELETE FROM checkpoints WHERE id IN (SELECT id FROM uninstalled);
DROP TABLE uninstalled;
ALTER TABLE items RENAME TO legacy_items;
"""


def run_script(conn, script):
    """Run each statement of a script inside the caller's transaction.

    executescript would commit the open transaction first.
    """
    statement = ""
    for line in script.splitlines(keepends=True):
        statement += line
        if sqlite3.complete_statement(statement):
            conn.execute(statement)
            statement = ""
    require(not statement.strip(), "incomplete statement in schema script")


def table_exists(conn, name):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone() is not None


def migrate_legacy(conn):
    run_script(conn, LEGACY_MIGRATION)
    if table_exists(conn, "transcript_search"):
        conn.execute("ALTER TABLE transcript_entries RENAME TO legacy_entries")
        conn.execute("DROP INDEX IF EXISTS transcript_entries_uuid")
    run_script(conn, SCHEMA)
    conn.execute(
        "INSERT INTO items (checkpoint, idx, role, source, searchable, rendered, search_text)"
        " SELECT checkpoint, idx, role, source, searchable, rendered,"
        " CASE WHEN searchable = 0 OR search_text = rendered THEN NULL ELSE search_text END"
        " FROM legacy_items")
    conn.execute("DROP TABLE legacy_items")
    if table_exists(conn, "legacy_entries"):
        conn.execute(
            "INSERT INTO transcript_entries (session, agent, path, line_no, uuid, role, searchable,"
            " rendered, search_text)"
            " SELECT e.session, e.agent, e.path, e.line_no, e.uuid, e.role, s.body IS NOT NULL,"
            " e.rendered, CASE WHEN s.body IS NULL OR s.body = e.rendered THEN NULL ELSE s.body END"
            " FROM legacy_entries e LEFT JOIN transcript_search s ON s.session = e.session"
            " AND s.agent = e.agent AND s.path = e.path AND s.line_no = e.line_no")
        conn.execute("DROP TABLE legacy_entries")
        conn.execute("DROP TABLE transcript_search")


def connect(db_path):
    path = Path(db_path)
    require(path.is_absolute(), "--db must be an absolute path")
    if not path.parent.exists():
        path.parent.mkdir(mode=0o700, parents=True)
    conn = sqlite3.connect(str(path), isolation_level=None)
    conn.execute("PRAGMA foreign_keys = ON")
    # Other sessions share this archive; wait out their short transactions rather than failing.
    conn.execute("PRAGMA busy_timeout = 20000")
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    require(version <= SCHEMA_VERSION, f"archive schema {version} is newer than this helper")
    migrated = False
    if version < SCHEMA_VERSION:
        conn.execute("BEGIN IMMEDIATE")
        try:
            # Another process may have set the schema up while this one waited for the lock.
            if conn.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION:
                migrated = table_exists(conn, "items")
                if migrated:
                    migrate_legacy(conn)
                else:
                    run_script(conn, SCHEMA)
                conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    if migrated:
        # The legacy archive shrinks by most of its size; give the space back once.
        conn.execute("VACUUM")
    conn.isolation_level = ""
    return conn


# ---------------------------------------------------------------- snapshot


def history_tool_ids(messages):
    """Ids of this plugin's history tool calls anywhere in the snapshot."""
    return {
        use["tool_use_id"]
        for msg in messages
        for use in msg["toolUses"]
        if use["tool"].startswith(HISTORY_TOOL_PREFIX)
    }


def tool_output(part):
    """Readable output of a tool use or result: SDK text, else serialized result."""
    text = part.get("text")
    if isinstance(text, str) and text:
        return text
    if "result" in part:
        return dumps(part["result"])
    return ""


def result_ids(messages):
    """Ids that have a standalone toolResults entry anywhere in the snapshot."""
    return {r["tool_use_id"] for msg in messages for r in msg.get("toolResults") or []}


def render_message(msg, history_ids, standalone_ids):
    """Return (rendered, search_text, searchable) for one SDK SessionMessage.

    toolUses entries: {tool_use_id, tool, input, text?, result?, isError?}
    toolResults entries: {tool_use_id, text, isError?, result?}
    """
    text = msg["text"]
    if text.startswith(HANDOFF_PREFIX):
        # Handoff messages repeat archived evidence; keep them readable only.
        return text, "", False
    rendered, searched = [text], [text]
    for use in msg["toolUses"]:
        error = " error" if use.get("isError") else ""
        part = f"\n[tool_use {use['tool']} id={use['tool_use_id']}{error}]\n" + dumps(use.get("input"))
        # A result that also appears as a standalone toolResults entry is
        # rendered once, at that entry.
        output = "" if use["tool_use_id"] in standalone_ids else tool_output(use)
        if output:
            part += "\n[output]\n" + output
        rendered.append(part)
        if use["tool_use_id"] not in history_ids:
            searched.append(part)
    for result in msg.get("toolResults") or []:
        error = " error" if result.get("isError") else ""
        part = f"\n[tool_result id={result['tool_use_id']}{error}]\n" + tool_output(result)
        rendered.append(part)
        if result["tool_use_id"] not in history_ids:
            searched.append(part)
    return "".join(rendered), "".join(searched), True


def op_snapshot(conn, req, session, agent):
    """Store an installed compaction's input with its handoff, in one transaction.

    The caller chooses the checkpoint id because the handoff text names it.
    """
    cp = checkpoint_id(field(req, "checkpoint", str), "checkpoint")
    handoff = field(req, "handoff", str)
    messages = field(req, "messages", list)
    parents = field(req, "parents", list)
    for p in parents:
        checkpoint_id(p, "parent")
    for i, msg in enumerate(messages):
        require(isinstance(msg, dict), f"message {i} must be an object")
        field(msg, "role", str)
        field(msg, "text", str)
        field(msg, "toolUses", list)
        field(msg, "toolResults", list, optional=True)
        for use in msg["toolUses"]:
            require(isinstance(use, dict), f"message {i} toolUses entries must be objects")
            field(use, "tool_use_id", str)
            field(use, "tool", str)
        for result in msg.get("toolResults") or []:
            require(isinstance(result, dict), f"message {i} toolResults entries must be objects")
            field(result, "tool_use_id", str)
            field(result, "text", str)

    inherited = inherited_field(req)
    with conn:
        for p in set(parents):
            check_trusted(conn, p, "parent", session, agent, inherited)
        conn.execute(
            "INSERT INTO checkpoints (id, session, agent, created_at, count) VALUES (?, ?, ?, ?, ?)",
            (cp, session, agent, time.time(), len(messages)),
        )
        conn.executemany(
            "INSERT INTO checkpoint_parents (checkpoint, parent) VALUES (?, ?)",
            [(cp, p) for p in sorted(set(parents))],
        )
        rows = []
        history_ids = history_tool_ids(messages)
        standalone_ids = result_ids(messages)
        for i, msg in enumerate(messages):
            rendered, search_text, searchable = render_message(msg, history_ids, standalone_ids)
            searchable = searchable and (search_text != "" or rendered == "")
            rows.append((cp, i, msg["role"], "snapshot", int(searchable), rendered,
                         separate_search_text(searchable, rendered, search_text)))
        conn.executemany(
            "INSERT INTO items (checkpoint, idx, role, source, searchable, rendered, search_text)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        conn.execute(
            "INSERT INTO handoffs (checkpoint, session, agent, text, created_at) VALUES (?, ?, ?, ?, ?)",
            (cp, session, agent, handoff, time.time()),
        )
    return {"checkpoint": cp, "count": len(messages)}


def separate_search_text(searchable, rendered, search_text):
    """The search text to store beside rendered: NULL when it adds nothing."""
    return None if not searchable or search_text == rendered else search_text


# ---------------------------------------------------------------- scope


def inherited_field(req):
    value = field(req, "inherited", bool, optional=True)
    return bool(value)


def check_trusted(conn, cp, name, session, agent, inherited):
    """Validate a checkpoint the host supplied from the caller's current context.

    The same agent may use its checkpoints from any session (resume). A forked
    agent (inherited=true) may also use another agent's checkpoint from the
    same session.
    """
    checkpoint_id(cp, name)
    row = conn.execute("SELECT session, agent FROM checkpoints WHERE id = ?", (cp,)).fetchone()
    require(row is not None, f"unknown {name} checkpoint: {cp}")
    owner_session, owner_agent = row
    allowed = owner_agent == agent or (inherited and owner_session == session)
    require(allowed, f"{name} checkpoint {cp} belongs to another agent")


def scope_ids(conn, req, session, agent):
    """Return checkpoint ids reachable from trusted roots and their ancestors.

    Ancestors were validated when each child snapshot was written, so the
    recursion does not re-filter by agent.
    """
    roots = roots_field(req)
    inherited = inherited_field(req)
    for r in roots:
        check_trusted(conn, r, "root", session, agent, inherited)
    if not roots:
        return []
    marks = ",".join("?" * len(roots))
    rows = conn.execute(
        f"""WITH RECURSIVE scope(id) AS (
              SELECT id FROM checkpoints WHERE id IN ({marks})
              UNION
              SELECT p.parent FROM checkpoint_parents p JOIN scope s ON p.checkpoint = s.id
            )
            SELECT id FROM scope""",
        roots,
    ).fetchall()
    return [r[0] for r in rows]


def roots_field(req):
    roots = field(req, "roots", list)
    for r in roots:
        require(isinstance(r, str), "roots must be strings")
    return roots


# ---------------------------------------------------------------- read / search


def op_read(conn, req, session, agent):
    ref = field(req, "ref", str)
    offset = field(req, "offset", int, optional=True) or 0
    limit = field(req, "limit", int, optional=True)
    limit = READ_DEFAULT_LIMIT if limit is None else limit
    require(0 < limit <= READ_MAX_LIMIT, f"limit must be in 1..{READ_MAX_LIMIT}")
    require(offset >= 0, "offset must be non-negative")
    row_match = ROW_REF_RE.match(ref)
    if row_match:
        return read_row(conn, session, agent, ref, row_match.group(1), offset, limit)
    match = REF_RE.match(ref)
    require(match is not None, f"invalid ref: {ref!r}")
    cp, idx = match.group(1), int(match.group(2))
    require(cp in scope_ids(conn, req, session, agent), f"ref outside current context: {ref}")
    row = conn.execute(
        "SELECT role, rendered, source FROM items WHERE checkpoint = ? AND idx = ?", (cp, idx)
    ).fetchone()
    require(row is not None, f"missing item: {ref}")
    return page(ref, *row, offset, limit)


def latest_sync_path(conn, session, agent):
    row = conn.execute(
        "SELECT path FROM transcript_cursor WHERE session = ? AND agent = ?"
        " ORDER BY synced_at DESC LIMIT 1",
        (session, agent),
    ).fetchone()
    return None if row is None else row[0]


def read_row(conn, session, agent, ref, uuid, offset, limit):
    # Transcript rows are readable only from the caller's own session and agent,
    # and only on the active chain of the most recently synced transcript.
    path = latest_sync_path(conn, session, agent)
    require(path is not None, f"no synced transcript for this session/agent: {ref}")
    row = conn.execute(
        "SELECT e.role, e.rendered FROM transcript_entries e JOIN transcript_active a"
        " ON a.session = e.session AND a.agent = e.agent AND a.path = e.path AND a.uuid = e.uuid"
        " WHERE e.session = ? AND e.agent = ? AND e.path = ? AND e.uuid = ?"
        " ORDER BY e.line_no DESC LIMIT 1",
        (session, agent, path, uuid),
    ).fetchone()
    require(row is not None, f"ref not on the active transcript chain: {ref}")
    return page(ref, row[0], row[1], "transcript", offset, limit)


def page(ref, role, rendered, source, offset, limit):
    total = len(rendered)
    require(offset <= total, f"offset {offset} beyond total_chars {total}")
    end = min(total, offset + limit)
    return {
        "ref": ref,
        "role": role,
        "text": rendered[offset:end],
        "offset": offset,
        "next_offset": end if end < total else None,
        "total_chars": total,
        "source": source,
    }


def snippet(search_text, query):
    if not query:
        return search_text[:SNIPPET_CHARS]
    pos = search_text.translate(ASCII_LOWER).find(query.translate(ASCII_LOWER))
    require(pos >= 0, "search match vanished")
    start = max(0, min(pos - SNIPPET_LEAD, len(search_text) - SNIPPET_CHARS))
    return search_text[start:start + SNIPPET_CHARS]


def op_search(conn, req, session, agent):
    query = field(req, "query", str)
    offset = field(req, "offset", int, optional=True) or 0
    limit = field(req, "limit", int, optional=True)
    limit = SEARCH_DEFAULT_LIMIT if limit is None else limit
    require(0 < limit <= SEARCH_MAX_LIMIT, f"limit must be in 1..{SEARCH_MAX_LIMIT}")
    require(offset >= 0, "offset must be non-negative")
    ids = scope_ids(conn, req, session, agent)
    path = latest_sync_path(conn, session, agent)
    marks = ",".join("?" * len(ids))
    # Candidates: active rows of the latest synced transcript (one per uuid,
    # newest line first), then snapshot items (newest checkpoint, latest index
    # first). Matching is a literal, ASCII-case-insensitive substring test.
    candidates = f"""
        SELECT 0 AS kind, 0 AS k1, t.line_no AS k2, 'row:' || t.uuid AS ref, t.role AS role,
               'transcript' AS source, coalesce(t.search_text, t.rendered) AS search_text
        FROM transcript_entries t JOIN transcript_active a
          ON a.session = t.session AND a.agent = t.agent AND a.path = t.path AND a.uuid = t.uuid
        WHERE t.session = ? AND t.agent = ? AND t.path = ? AND t.searchable = 1
          AND t.line_no = (SELECT max(u.line_no) FROM transcript_entries u
                           WHERE u.session = t.session AND u.agent = t.agent AND u.path = t.path
                             AND u.uuid = t.uuid)
        UNION ALL
        SELECT 1, c.seq, i.idx, 'cm:' || i.checkpoint || ':' || i.idx, i.role, i.source,
               coalesce(i.search_text, i.rendered)
        FROM items i JOIN checkpoints c ON c.id = i.checkpoint
        WHERE i.checkpoint IN ({marks}) AND i.searchable = 1"""
    args = (session, agent, path if path is not None else "", *ids)
    where = "instr(lower(search_text), lower(?)) > 0"
    total = conn.execute(
        f"SELECT count(*) FROM ({candidates}) WHERE {where}", (*args, query)
    ).fetchone()[0]
    rows = conn.execute(
        f"""SELECT ref, role, source, search_text FROM ({candidates}) WHERE {where}
            ORDER BY kind ASC, k1 DESC, k2 DESC LIMIT ? OFFSET ?""",
        (*args, query, limit, offset),
    ).fetchall()
    items = [
        {"ref": ref, "role": role, "snippet": snippet(text, query), "source": source}
        for ref, role, source, text in rows
    ]
    end = offset + len(items)
    return {"items": items, "next_offset": end if end < total else None, "total": total}


# ---------------------------------------------------------------- handoff


def op_get_handoff(conn, req, session, agent):
    cp = checkpoint_id(field(req, "checkpoint", str), "checkpoint")
    require(cp in scope_ids(conn, req, session, agent), f"checkpoint outside current context: {cp}")
    row = conn.execute("SELECT text FROM handoffs WHERE checkpoint = ?", (cp,)).fetchone()
    require(row is not None, f"no handoff saved for checkpoint: {cp}")
    return {"checkpoint": cp, "text": row[0]}


# ---------------------------------------------------------------- sync


def is_conversation(rec):
    kind = rec.get("type")
    if kind in ("user", "assistant"):
        return True
    return kind == "system" and rec.get("subtype") == "compact_boundary"


def render_record(rec, history_ids):
    """Return (role, rendered, search_text, searchable) for one transcript record."""
    message = rec.get("message")
    if not isinstance(message, dict):
        content = rec.get("content")
        text = content if isinstance(content, str) else dumps(content)
        return rec["type"], text, text, True
    role = message.get("role") if isinstance(message.get("role"), str) else rec["type"]
    content = message.get("content")
    if isinstance(content, str):
        if content.startswith(HANDOFF_PREFIX):
            return role, content, "", False
        return role, content, content, True
    rendered, searched = [], []
    for block in content or []:
        kind = block.get("type") if isinstance(block, dict) else None
        if kind == "text":
            part, history = block["text"], block["text"].startswith(HANDOFF_PREFIX)
        elif kind == "thinking":
            part, history = block["thinking"], False
        elif kind == "tool_use":
            use = {"id": block.get("id"), "name": block.get("name"), "input": block.get("input")}
            part = "\n[tool_use]\n" + dumps(use)
            history = str(block.get("name")).startswith(HISTORY_TOOL_PREFIX)
        elif kind == "tool_result":
            body = block.get("content")
            body = body if isinstance(body, str) else dumps(body)
            part = "\n[tool_result " + dumps({"toolUseId": block.get("tool_use_id")}) + "]\n" + body
            history = block.get("tool_use_id") in history_ids
        else:
            part, history = "\n[" + str(kind) + "]\n" + dumps(block), False
        rendered.append(part)
        if not history:
            searched.append(part)
    rendered, searched = "".join(rendered), "".join(searched)
    return role, rendered, searched, searched != "" or rendered == ""


def transcript_history_ids(records):
    ids = set()
    for rec in records:
        message = rec.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, list):
            for block in content:
                if (isinstance(block, dict) and block.get("type") == "tool_use"
                        and str(block.get("name")).startswith(HISTORY_TOOL_PREFIX)):
                    ids.add(block.get("id"))
    return ids


def handoff_root(rec):
    """Checkpoint id named by a handoff marker in a user record, if any."""
    message = rec.get("message")
    if rec.get("type") != "user" or not isinstance(message, dict):
        return None
    content = message.get("content")
    texts = [content] if isinstance(content, str) else [
        b.get("text") for b in content or []
        if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str)
    ]
    for text in texts:
        match = HANDOFF_MARK_RE.match(text)
        if match:
            return match.group(1)
    return None


def tail_digest(f, end):
    start = max(0, end - TAIL_BYTES)
    f.seek(start)
    chunk = f.read(end - start)
    require(len(chunk) == end - start, "transcript shrank while it was read")
    return hashlib.sha256(chunk).hexdigest()


def parse_lines(path, data, line_no):
    """Yield (line_no, record) for each complete line of data, numbering from line_no + 1."""
    pos = 0
    while pos < len(data):
        nl = data.index(b"\n", pos)
        line = data[pos:nl]
        line_no += 1
        if line:
            try:
                rec = json.loads(line.decode("utf-8"))
            except ValueError as exc:
                raise ValueError(f"{path}: corrupt JSON on line {line_no}") from exc
            yield line_no, rec
        pos = nl + 1


def walk_chain(tip, parents):
    chain, cur = [], tip
    seen = set()
    while cur is not None and cur not in seen:
        seen.add(cur)
        chain.append(cur)
        cur = parents.get(cur)
    return chain


def op_sync(conn, req, session, agent):
    """Index a transcript from where the previous sync stopped.

    Only the bytes appended since the cursor are parsed and inserted, so the cost
    follows the new material. A file that no longer matches the cursor (shorter,
    or rewritten before it) is indexed again from the start.
    """
    path = field(req, "path", str)
    require(os.path.isabs(path), "path must be absolute")
    key = (session, agent, path)
    cursor = conn.execute(
        "SELECT bytes, line_no, tail_hash, chain_tip FROM transcript_cursor"
        " WHERE session = ? AND agent = ? AND path = ?", key).fetchone()
    with open(path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        resume = cursor is not None and size >= cursor[0] and tail_digest(f, cursor[0]) == cursor[2]
        start, line0 = (cursor[0], cursor[1]) if resume else (0, 0)
        f.seek(start)
        data = f.read()
        complete = data.rfind(b"\n") + 1
        end = start + complete
        tail_hash = tail_digest(f, end)
    trailing = complete < len(data)

    records = list(parse_lines(path, data[:complete], line0))
    line_no = line0 + data[:complete].count(b"\n")
    links =[(rec["uuid"], rec.get("parentUuid") or rec.get("logicalParentUuid"))
             for _, rec in records if isinstance(rec, dict) and rec.get("uuid") is not None]
    entries = [(ln, rec) for ln, rec in records
               if isinstance(rec, dict) and rec.get("uuid") is not None and is_conversation(rec)]

    with conn:
        if not resume:
            for table in TRANSCRIPT_TABLES:
                conn.execute(f"DELETE FROM {table} WHERE session = ? AND agent = ? AND path = ?", key)
        conn.executemany(
            "INSERT OR IGNORE INTO transcript_tools (session, agent, path, tool_use_id)"
            " VALUES (?, ?, ?, ?)",
            [(*key, i) for i in transcript_history_ids([rec for _, rec in entries]) if i is not None])
        history_ids = {r[0] for r in conn.execute(
            "SELECT tool_use_id FROM transcript_tools WHERE session = ? AND agent = ? AND path = ?",
            key)}
        parents = dict(conn.execute(
            "SELECT uuid, parent FROM transcript_links WHERE session = ? AND agent = ? AND path = ?",
            key).fetchall())
        relinked = any(u in parents and parents[u] != p for u, p in links)
        parents.update(links)
        conn.executemany(
            "INSERT INTO transcript_links (session, agent, path, uuid, parent) VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT (session, agent, path, uuid) DO UPDATE SET parent = excluded.parent",
            [(*key, u, p) for u, p in links])
        entry_rows, handoff_rows = [], []
        for ln, rec in entries:
            role, rendered, search_text, searchable = render_record(rec, history_ids)
            entry_rows.append((*key, ln, rec["uuid"], role, int(searchable), rendered,
                               separate_search_text(searchable, rendered, search_text)))
            checkpoint = handoff_root(rec)
            if checkpoint is not None:
                handoff_rows.append((*key, ln, rec["uuid"], checkpoint))
        conn.executemany(
            "INSERT INTO transcript_entries (session, agent, path, line_no, uuid, role, searchable,"
            " rendered, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", entry_rows)
        conn.executemany(
            "INSERT INTO transcript_handoffs (session, agent, path, line_no, uuid, checkpoint)"
            " VALUES (?, ?, ?, ?, ?, ?)", handoff_rows)

        old_tip = cursor[3] if resume else None
        tip = entries[-1][1]["uuid"] if entries else old_tip
        chain = walk_chain(tip, parents)
        if old_tip is not None and not relinked and old_tip in chain:
            # The chain only grew: everything already active stays active.
            added = chain[:chain.index(old_tip)]
        else:
            conn.execute("DELETE FROM transcript_active WHERE session = ? AND agent = ? AND path = ?", key)
            added = chain
        conn.executemany(
            "INSERT OR IGNORE INTO transcript_active (session, agent, path, uuid) VALUES (?, ?, ?, ?)",
            [(*key, u) for u in added])
        conn.execute(
            "INSERT OR REPLACE INTO transcript_cursor (session, agent, path, bytes, line_no,"
            " tail_hash, chain_tip, trailing_incomplete, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (*key, end, line_no, tail_hash, tip, int(trailing), time.time()))

    roots = []
    for (checkpoint,) in conn.execute(
            "SELECT h.checkpoint FROM transcript_handoffs h JOIN transcript_active a"
            " ON a.session = h.session AND a.agent = h.agent AND a.path = h.path AND a.uuid = h.uuid"
            " WHERE h.session = ? AND h.agent = ? AND h.path = ? ORDER BY h.line_no", key):
        if checkpoint not in roots:
            roots.append(checkpoint)
    count = conn.execute(
        "SELECT count(*) FROM transcript_entries WHERE session = ? AND agent = ? AND path = ?",
        key).fetchone()[0]
    active_count = conn.execute(
        "SELECT count(*) FROM transcript_entries e JOIN transcript_active a"
        " ON a.session = e.session AND a.agent = e.agent AND a.path = e.path AND a.uuid = e.uuid"
        " WHERE e.session = ? AND e.agent = ? AND e.path = ?", key).fetchone()[0]
    return {
        "count": count,
        "active_count": active_count,
        "coverage": {"path": path, "bytes": end, "trailing_incomplete": trailing},
        "roots": roots,
    }


# ---------------------------------------------------------------- status


def op_status(conn, req, session, agent):
    ids = scope_ids(conn, req, session, agent)
    items = 0
    if ids:
        marks = ",".join("?" * len(ids))
        items = conn.execute(
            f"SELECT count(*) FROM items WHERE checkpoint IN ({marks})", ids
        ).fetchone()[0]
    coverage = [
        {"path": p, "bytes": b, "trailing_incomplete": bool(t)}
        for p, b, t in conn.execute(
            "SELECT path, bytes, trailing_incomplete FROM transcript_cursor"
            " WHERE session = ? AND agent = ? ORDER BY path",
            (session, agent),
        )
    ]
    return {"checkpoints": len(ids), "items": items, "coverage": coverage,
            "transcript_path": latest_sync_path(conn, session, agent)}


OPS = {
    "snapshot": op_snapshot,
    "get_handoff": op_get_handoff,
    "read": op_read,
    "search": op_search,
    "sync": op_sync,
    "status": op_status,
}


def main():
    parser = argparse.ArgumentParser(description="context-memory SQLite archive helper")
    parser.add_argument("--db", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    req = json.loads(sys.stdin.read())
    require(isinstance(req, dict), "request must be a JSON object")
    op = field(req, "op", str)
    require(op in OPS, f"unknown op: {op}")
    session = field(req, "session", str)
    agent = field(req, "agent", str)
    require(session and agent, "session and agent must be non-empty")
    conn = connect(args.db)
    try:
        result = OPS[op](conn, req, session, agent)
    finally:
        conn.close()
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
