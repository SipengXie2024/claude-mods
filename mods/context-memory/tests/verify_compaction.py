"""Check a real CLI run: no plugin model calls, no duplicated tool IDs, and each installed handoff carries the latest task note.

Usage: verify_compaction.py <debug.log> <session.jsonl>
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

NOTES_TOOL = 'mcp__context-memory__notes_write'
NOTES_BLOCK = re.compile(r'\[context-memory notes\]\n(.*?)\n\[/context-memory notes\]', re.S)


def text_of(message):
    content = message.get('content', [])
    if isinstance(content, str):
        return content
    return '\n'.join(b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text')


def handoff_notes(text):
    """None when the text is no compaction handoff; '' when it carries no note."""
    if '[context-memory checkpoint=' not in text or '上下文已压缩' not in text:
        return None
    match = NOTES_BLOCK.search(text)
    return match.group(1) if match else ''


def blob_hash(message):
    content = message.get('content', [])
    if isinstance(content, str):
        content = [{'type': 'text', 'text': content}]
    canonical = {'role': message['role'], 'content': content}
    return hashlib.sha256(json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def verify(debug_path, transcript_path):
    debug = Path(debug_path).read_text().split('\n')
    plugin_calls = [line for line in debug if '$.model.complete (context-memory)' in line]
    installed = [line for line in debug if re.search(r'session\.compact \((manual|auto)\): a hook\'s \d+ messages stand', line)]
    assert not plugin_calls, f'{len(plugin_calls)} plugin model requests; first: {plugin_calls[0][:200]}'
    assert installed, 'No compaction was installed'

    blobs, requests = {}, {}
    pending_calls = {}
    current = ''
    expected = []
    waiting = None
    checked = []
    for line in Path(transcript_path).open():
        row = json.loads(line)
        kind = row.get('type')
        if kind == 'api-request-blob':
            blobs[row['hash']] = row['message']
            continue
        message = row.get('message')
        if kind in ('user', 'assistant') and isinstance(message, dict):
            blobs[blob_hash(message)] = {'role': message['role'], 'content': message.get('content', [])}
            for block in message.get('content', []) if isinstance(message.get('content'), list) else []:
                if block.get('type') == 'tool_use' and block.get('name') == NOTES_TOOL:
                    pending_calls[block['id']] = block.get('input', {}).get('text')
                if block.get('type') == 'tool_result' and block.get('tool_use_id') in pending_calls:
                    note = pending_calls.pop(block['tool_use_id'])
                    if not block.get('is_error') and isinstance(note, str):
                        current = note
            embedded = handoff_notes(text_of(message)) if message.get('role') == 'user' else None
            if embedded:
                current = embedded
        if row.get('subtype') == 'compact_boundary':
            waiting = current
            expected.append(current)
        if kind == 'api-request':
            base = requests[row['base']] if row.get('base') else []
            hashes = base[:row['keep']] + row['tail']
            requests[row['id']] = hashes
            for h in hashes:
                content = blobs.get(h, {}).get('content', [])
                ids = [b['id'] for b in content if isinstance(content, list) and isinstance(b, dict) and b.get('type') in ('tool_use', 'server_tool_use')]
                assert len(ids) == len(set(ids)), 'Duplicate tool identifiers in one request message'
            if waiting is not None and row.get('querySource') in ('sdk', 'repl_main_thread'):
                found = [handoff_notes(text_of(blobs[h])) for h in hashes if h in blobs]
                found = [n for n in found if n is not None]
                assert found, 'First request after compaction carries no handoff'
                assert found[-1] == waiting, f'Handoff note differs from the latest note: {found[-1][:120]!r} vs {waiting[:120]!r}'
                checked.append(len(waiting))
                waiting = None
    assert checked, 'No post-compaction request was checked'
    return {'plugin_model_requests': 0, 'installed_compactions': len(installed), 'handoffs_checked': len(checked), 'note_chars': checked}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('debug')
    parser.add_argument('transcript')
    args = parser.parse_args()
    print(json.dumps(verify(args.debug, args.transcript), ensure_ascii=False))
