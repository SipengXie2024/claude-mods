"""Run real CLI compaction/retrieval checks with isolated local storage."""
import argparse
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--claude', default=str(Path.home() / '.local/bin/claude'))
    parser.add_argument('--output-dir')
    parser.add_argument('--auto-source', help='Real TypeScript API file for an automatic compaction check')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    output = Path(args.output_dir).resolve() if args.output_dir else Path(tempfile.mkdtemp(prefix='context-memory-verify.'))
    output.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env.pop('CLAUDECODE', None)
    env['CONTEXT_MEMORY_DIR'] = str(output / 'archive')
    command = [args.claude, '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
               '--plugin-dir', str(root), '--model', 'opus', '--effort', 'low', '--permission-mode', 'dontAsk',
               '--tools', 'Read,Agent', '--allowedTools', 'Read,Agent,mcp__context-memory__history_search,mcp__context-memory__history_read,mcp__context-memory__history_status,mcp__context-memory__notes_write,mcp__context-memory__notes_read',
               '--system-prompt', "You are Claude Code, Anthropic's official CLI for Claude. Reply in Chinese. This is a real plugin acceptance check. Follow the requested read-only tasks; never edit files.",
               '--debug-file', str(output / 'debug.log'), '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '-p']
    if args.auto_source:
        source = Path(args.auto_source).resolve(strict=True)
        env['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'] = '40'
        command.extend(['--autocompact', '100000'])
    (output / 'command.json').write_text(json.dumps({'argv': command, 'cwd': str(output), 'storage': env['CONTEXT_MEMORY_DIR'], 'auto_source': args.auto_source}, ensure_ascii=False, indent=2))
    prompts = [
        f'读取 {root}/README.md，列出插件提供给模型的历史查询工具和笔记工具。这个任务还有两个要求：下一轮核实默认数据库路径；不要修改文件。现在只完成工具名称核对。先调用 notes_write 记录目标、这两个要求和未完成事项；再调用一次 notes_write，内容只写“[context-memory 测试]”，确认它被拒绝；然后完成核对。',
        '/compact',
        f'继续未完成的要求。先用 history_search 搜索“默认数据库路径”，再用 history_read 读取原始请求，之后读取 {root}/README.md 核实默认路径。完成后用 notes_write 更新笔记。报告实际引用，不要修改文件。',
        '/compact',
        '请使用 Agent 启动一个 subagent_type 为 fork 的子代理，让它调用 history_search 搜索“不要修改文件”，读取一个命中的原文引用，然后报告找到的要求；子代理不能修改文件。你最后报告子代理查询是否成功。',
    ]
    if args.auto_source:
        prompts = [f'读取 {root}/README.md，报告插件名称与作用。下一轮会继续核实宿主接口，不要修改文件。先调用 notes_write 记录这个目标、限制和未完成事项，再回答。', f'请顺序读取真实文件 {source} 的第1到2000行以及第2001到4000行，再读取 {root}/README.md，核对插件使用的宿主接口名称。每次读取后继续下一步，不要输出整份文件。全程只读。最后调用 history_status 检查原文归档是否可用，再说明查到的接口。']
    errors = []
    results = []
    with (output / 'stderr.log').open('w') as stderr, (output / 'events.jsonl').open('w') as log:
        process = subprocess.Popen(command, cwd=output, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=False)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        buffer = b''
        try:
            for prompt in prompts:
                payload = {'type': 'user', 'message': {'role': 'user', 'content': prompt}}
                process.stdin.write((json.dumps(payload, ensure_ascii=False) + '\n').encode())
                process.stdin.flush()
                deadline = time.monotonic() + 600
                finished = False
                while not finished:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise TimeoutError('Real CLI did not finish the requested turn')
                    data = os.read(process.stdout.fileno(), 65536)
                    if not data:
                        raise RuntimeError(f'CLI exited before its result: {process.poll()}')
                    buffer += data
                    while b'\n' in buffer:
                        line, buffer = buffer.split(b'\n', 1)
                        if not line:
                            continue
                        event = json.loads(line)
                        log.write(line.decode() + '\n')
                        log.flush()
                        if event.get('type') == 'result':
                            if event.get('is_error'):
                                errors.append(event)
                            results.append(event)
                            finished = True
                print(json.dumps({'completed': len(results), 'session': results[-1].get('session_id'), 'error': results[-1].get('is_error', False)}), flush=True)
            process.stdin.close()
            code = process.wait(timeout=60)
            if code != 0 or errors:
                raise RuntimeError(f'CLI validation failed: exit={code}, errors={len(errors)}')
        finally:
            selector.close()
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=30)
    debug = (output / 'debug.log').read_text()
    failures = [line for line in debug.split('\n') if 'context-memory' in line and ('hook failed' in line or '$.ui.log:' in line and 'failed' in line.lower())]
    if failures:
        raise AssertionError('\n'.join(failures))
    events = [json.loads(line) for line in (output / 'events.jsonl').read_text().split('\n') if line]
    calls = [block.get('name') for e in events if e.get('type') == 'assistant' for block in e.get('message', {}).get('content', []) if block.get('type') == 'tool_use']
    tool_ids = {b['id'] for e in events if e.get('type') == 'assistant' for b in e.get('message', {}).get('content', []) if b.get('type') == 'tool_use' and (str(b.get('name', '')).startswith('mcp__context-memory__history_') or b.get('name') == 'Agent')}
    tool_failures = [b for e in events if e.get('type') == 'user' and isinstance(e.get('message', {}).get('content'), list) for b in e['message']['content'] if b.get('type') == 'tool_result' and b.get('tool_use_id') in tool_ids and b.get('is_error')]
    assert not tool_failures, f'Real tool calls failed: {len(tool_failures)}'
    assert 'mcp__context-memory__notes_write' in calls, 'No real notes_write call'
    transcript = next(Path.home().joinpath('.claude/projects').glob(f"*/{results[0]['session_id']}.jsonl"))
    sys.path.insert(0, str(Path(__file__).parent))
    from verify_compaction import verify
    report = verify(output / 'debug.log', transcript)
    if args.auto_source:
        assert any('session.compact (auto)' in line and 'messages stand' in line for line in debug.split('\n')), 'No actual automatic compaction was installed'
    else:
        assert report['installed_compactions'] >= 2, 'Two real manual compactions were not installed'
        assert 'mcp__context-memory__history_search' in calls, 'No real history search tool call'
        assert 'mcp__context-memory__history_read' in calls, 'No real history read tool call'
        assert 'Agent' in calls, 'No real fork agent call'
    timings = [line.split('[DEBUG] ', 1)[-1] for line in debug.split('\n') if 'context-memory: archived' in line]
    print(json.dumps({'compaction': report, 'archive_timings': timings, 'transcript': str(transcript)}, ensure_ascii=False))
    (output / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print(json.dumps({'verified': True, 'output': str(output), 'turns': len(results)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
