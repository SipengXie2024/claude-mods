## session-switch
artifacts: Probe dir: /tmp/magpie-probe-recheck-i5Q1 (P below).
- Mod: P/mod/.claude-plugin/plugin.json, P/mod/hooks/hooks.json, P/mod/hooks/register.ts.
- Prompt markers: RCK-ASK, RCK-ASKOBJ, RCK-DROP, RCK-BG.
- Every hook logs 'RCK …' with $.ui.log(…, {to:'debug'}).
- Validate: `claude plugin validate P/mod` (passes with warnings).
- Isolated config dir: P/cfg. Work dir: P/work (git init).

Headless run (p1):
cd P/work && env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID CLAUDE_CONFIG_DIR=P/cfg claude-magpie -p --model claude/claude-haiku-5-5 --plugin-dir P/mod --debug-file P/runs/p1/debug.log --output-forma

### [partial] (a) Can a mod switch the main conversation's model from a hook, does it stick, and what does the status show?
CONSEQUENCE: Unchanged from the earlier report: §3/§4 still need a decision on the launcher-settings side effect of /model. In addition, the drop-then-resubmit flow must handle the original text that stays in the composer (I did not test whether $.prompt.submit clears it).
EVIDENCE: NOT RE-CHECKED. The verdict is 'partial', so it falls outside the re-check scope (only 'works' and 'does-not-work' items were re-checked). I also left it alone on purpose, because reproducing it needs an interactive /model or $.config.set, and the earlier agent showed that changes ~/.config/magpie/claude-launch/settings.json through the claude-magpie wrapper. The rules forbid changing settings files. The earlier agent's evidence stands as they reported it:

1. $.command.run from prompt.submit is rejected with 'command.run: called from a prompt.submit hook, it would wait on the turn this hook is holding; run it from a later event (turn.complete) (host check)'.
2. Fire-and-forget /model from turn.complete works. After a cached turn it opens a 'Switch model?' modal that someone must answer.
3. ask in prompt.submit, then {drop}, then $.clock.after: /model <id> followed by $.prompt.submit switches with no modal.
4. Interactive /model writes a user-settings model, and the magpie wrapper moves it into the launcher settings on exit.
5. $.config.set takes aliases only.
6. A turn.step model rewrite is per request and is not a session switch.

One related observation from my run: {drop} re-fills the composer. The dropped text 'RCK-DROP reply ok' appeared back in the input box after 'Prompt dropped by a hook: ...'. The drop-then-resubmit route should therefore expect the dropped text to remain in the person's input box. Whether a $.prompt.submit resubmission clears it was not tested.

### [works] (b) Can a mod move the foreground interactive session to a background session so that closing the terminal keeps it running and `claude attach` reconnects?
CONSEQUENCE: Confirmed: design §4 step 4 (fire /bg from turn.complete, not awaited) is feasible.
- The session id changes on /bg (fork plus a new --session-id), so the task registry has to re-key to the new id. That id is in the 'backgrounded · <id>' output, in `claude agents --json`, or comes from the background process's own session.start.
- In-memory mod state is lost (new process), so pending state needs $.store or a file.
- CLAUDE_CODE_SESSION_KIND=bg together with CLAUDE_BG_SOURCE=slash marks the background copy, so the mod can skip the first-prompt flow there.
- `background` is absent in -p, so the mod must branch for headless runs.
EVIDENCE: AGREES. I reproduced it in my own run /tmp/magpie-probe-recheck-i5Q1, runs/i1.

Command list:
- session.start in the interactive session logged 'ncmds=92 hasBackground=true hasBg=false'. 'bg' is not a listed name; it is an alias.
- The headless -p run (runs/p1) logged 'ncmds=49 hasBackground=false'.

Firing /bg:
- The prompt 'RCK-BG ...' set a flag. turn.complete fired `$.command.run({command:'bg'})` without awaiting it. Log: 'RCK bg resolved {} after 265ms' (08:54:00.656).
- The pane showed '› Prompt from the recheck-probe plugin / ❯ /bg / Backgrounding… / backgrounded · e21efae8 / claude attach e21efae8 / claude logs e21efae8 / claude stop e21efae8', then my wrapper's 'EXITED'. No claude-magpie process for the probe remained.

The background session:
- Two processes: pid 594719 'claude bg-pty-host --bg-pty-host /tmp/cc-daemon-1000/<id>/pty/e21efae8.sock 200 50 -- …', and pid 594733 '2.1.319 --session-id e21efae8-7435-… --fork-session --resume $P/cfg/projects/-tmp-magpie-probe-recheck-i5Q1-work/848d1919-….jsonl --settings /home/ubuntu/.config/magpie/claude-launch/settings.json --plugin-dir $P/mod --model claude/claude-haiku-5-5 --permission-mode bypassPermissions'.
- Its environment had CLAUDE_CODE_SESSION_KIND=bg, CLAUDE_BG_SOURCE=slash, CLAUDE_BG_BACKEND=daemon and CLAUDE_CONFIG_DIR=$P/cfg.
- --debug-file was not carried over.
- The session id changed from 848d1919 to e21efae8.
- `claude agents --json` (same CLAUDE_CONFIG_DIR) listed id e21efae8 with kind background and status idle. Its name came from the session's first prompt ('RCK-ASKOBJ response').
- The default config's `claude agents --json` did not list it (0 matches), so the registry is per CLAUDE_CONFIG_DIR.

Reattach:
- After killing the original tmux, `CLAUDE_CONFIG_DIR=$P/cfg claude attach e21efae8` in a 

### [works] (c) Can a mod show the user a confirmation choice before the first prompt is processed in an interactive session, and hold the prompt until answered?
CONSEQUENCE: Confirmed: design §4 step 2 is feasible in prompt.submit.
- Esc and -p both reject (Esc after the dialog; -p at once with a 'no tool named AskUserQuestion' error), so the mod must catch the rejection and choose drop or continue.
- Options must be plain strings; put the explanation in the question text.
- Compare the answer exactly with the labels, because 'Type something' returns free text.
- After {drop}, the original prompt text is back in the composer.
EVIDENCE: AGREES, with added detail.

First prompt of a fresh session (runs/i2, session c4e25d22):
- prompt.submit called `$.ui.ask('Which model should this task use?', {options:['Haiku','Sonnet','Cancel'], header:'Probe'})`.
- The pane drew '☐ Probe / Which model should this task use? / 1. Haiku / 2. Sonnet / 3. Cancel / 4. Type something. / 5. Chat about this / Enter to select · ↑/↓ to navigate · Esc to cancel'.
- Log: prompt.submit at 08:55:06.244, 'RCK ask answered "Cancel" after 19257ms' at 08:55:25.515, then the first turn.start at 08:55:25.542.
- The first magpie usage row for c4e25d22 is 08:55:25, so nothing reached the model while the dialog was open.

Hold time:
- In runs/i1 the dialog held for 23203 ms ('RCK ask answered "Sonnet" after 23203ms'), past a 10 s hook budget, with no turn.start until the answer arrived.
- turn.start then logged model=claude/claude-haiku-5-5, because the answer alone switches nothing.

Object-form options are refused:
- `options:[{label,description}]` produced '$.tool.call (recheck-probe): AskUserQuestion (questions) / AskUserQuestion tool input error: issues=custom', then 'RCK askobj rejected after 25ms: HooksError: recheck-probe: $.ui.ask: no answer (<\tool_use_error>InputValidationError: … "message": "Question texts must be…'.
- My hook then called next(e) and the prompt went through.

Drop:
- Returning {drop} after the answer showed '● Prompt dropped by a hook: recheck probe dropped (answer Haiku)'.
- No magpie usage row exists for that prompt (08:53:33).
- The dropped text was put back in the composer.

Esc (newly tested):
- 'RCK ask rejected after 3051ms: HooksError: recheck-probe: $.ui.ask: no answer (The user doesn't want to proceed with this tool use. The tool use was rejected …'.

-p (newly tested, runs/p1):
- ask rejects in 2 ms: 

## env-and-bg
artifacts: Probe dir: /tmp/magpie-probe-recheck-jAoV (new; the earlier run dir was not reused).
Mod: /tmp/magpie-probe-recheck-jAoV/mod/{.claude-plugin/plugin.json, hooks/hooks.json, hooks/register.ts}. A session.start hook records $.session.id, e.isInteractive, e.surface, $.session.surfaces(), and $.env.get for ANTHROPIC_BASE_URL, MAGPIE_TASKS_ROLE, MAGPIE_TASKS_ID, CLAUDE_JOB_DIR and CLAUDE_CODE_ENTRYPOINT. It also records typeof process, the flag-layer env names from $.settings.read({source:'flag'}), the merged model, $.session.authorize().kind, and `$.process.run(['sh','-c','echo BASE=... ROLE=... TI

### [works] (a) Can a mod's hooks read ANTHROPIC_BASE_URL injected by claude-magpie, and through which API? Plain claude compared with claude-magpie.
CONSEQUENCE: Unchanged. Activate on `(await $.env.get('ANTHROPIC_BASE_URL')) === 'http://127.0.0.1:3425'`. As a second signal, check for `env.ANTHROPIC_BASE_URL` in the flag layer; checking whether the flag layer is non-null does not work. Do not use process.env.
EVIDENCE: AGREES on the main claim, with one correction. In my own mod, `await $.env.get('ANTHROPIC_BASE_URL')` in session.start returned 'http://127.0.0.1:3425' under claude-magpie -p (1d483688-de8b-4b0b-a95c-a16a7dd0c888), claude-magpie interactive in tmux (30c1f0d4-8e3c-4ed7-b097-23672c255f98) and claude-magpie --bg (9c0bfc0e). It returned undefined under plain claude -p (df6ffa63-a51e-4311-b610-851ec23a630a) and plain interactive (e500e3e7-9905-4117-948f-1cc01d9b42b7). `typeof globalThis.process` was 'undefined' in every run. Under magpie, `$.settings.read({source:'flag'})` had the same 18 env names as reported, and merged `model` was 'codex/gpt-6-astra'. `$.session.authorize()` gave kind 'bearer' under plain claude and null under magpie. A child started with `$.process.run` printed BASE=http://127.0.0.1:3425 under magpie and nothing under plain claude. CORRECTION: the plain-claude flag layer is not null. It was `{"advisorModel":"fable"}` in -p (launched from inside this Claude session) and `{}` in interactive tmux (parent CLAUDE_* vars unset). Neither had an `env` key. I did not re-read the user layer (CLAUDE_CODE_ATTRIBUTION_HEADER).

### [partial] (b) Can a mod tell a non-interactive -p run from an interactive one?
CONSEQUENCE: Unchanged. Use isInteractive===false to skip -p runs. Use `$.env.get('CLAUDE_JOB_DIR') !== undefined` to recognise background sessions.
EVIDENCE: Not fully re-run, but every observation agrees. Both -p runs gave isInteractive=false, surface=null, surfaces=[] and ENTRYPOINT 'sdk-cli'. Interactive tmux runs gave isInteractive=true, surface 'terminal' and ENTRYPOINT 'cli'. The --bg sessions 9c0bfc0e and 2d248fb8 gave the same isInteractive=true and surfaces=['terminal'] as the interactive runs. `$.env.get('CLAUDE_JOB_DIR')` returned '/home/ubuntu/.claude/jobs/<shortid>' only in --bg sessions. The child-env names CLAUDE_JOB_DIR and CLAUDE_CODE_HOST_SHORT_TEMP_DIRS appeared in both bg sessions and in none of the six foreground runs.

### [works] (c1) Do custom env vars (MAGPIE_TASKS_ROLE=router, MAGPIE_TASKS_ID=t123) set when launching claude-magpie reach the mod?
CONSEQUENCE: Unchanged. A foreground Router started as `MAGPIE_TASKS_ROLE=router claude-magpie` can be recognised from the environment.
EVIDENCE: AGREES (foreground only). With `env MAGPIE_TASKS_ROLE=router MAGPIE_TASKS_ID=t123 claude-magpie ...`, the -p run (1d483688) and the interactive tmux run (30c1f0d4) both returned 'router' and 't123' from $.env.get. The child process printed ROLE=router TID=t123. Debug line: `RECHECK {"BASE":"http://127.0.0.1:3425","ROLE":"router","TID":"t123","isInteractive":true}`.

### [works] (c2) Does a `claude-magpie --bg "<prompt>"` background session still go through the Magpie gateway, and does the mod see ANTHROPIC_BASE_URL?
CONSEQUENCE: Unchanged. Background sessions started through claude-magpie reach the gateway because magpie's --settings path is saved and replayed.
EVIDENCE: AGREES. In background session 9c0bfc0e-0b69-4110-8ef7-f1c6ae54e901, the hook got BASE 'http://127.0.0.1:3425' and JOBDIR '/home/ubuntu/.claude/jobs/9c0bfc0e'. The flag-layer env names matched the foreground magpie runs. In `magpie usage --csv --last 10m`, session 9c0bfc0e has a 08:44:43Z row (claude/claude-haiku-5-5 served as claude-haiku-5-5, effort medium, status 200) and three codex/gpt-6-astra rows with status 200. ~/.claude/jobs/9c0bfc0e/state.json respawnFlags = ['--settings','/home/ubuntu/.config/magpie/claude-launch/settings.json','--plugin-dir',...,'--debug-file',...,'--model','claude/claude-haiku-5-5']. The spare process's own /proc environ has no ANTHROPIC_BASE_URL. The URL arrives only through the saved --settings file.

### [does-not-work] (c3) Does the background session see the custom env vars from the launching shell?
CONSEQUENCE: Section 4's 'set MAGPIE_TASKS_ID in the environment when starting the background architect' does not work. Route (1) works: a per-task merged settings file passed as `claude --bg --settings <file>`. The file must stay in place, mode 0600, for the session's whole lifetime, because every wake or respawn re-reads it from that path. Delete it only after the task's session is finally removed. It also holds a copy of the gateway credential, which goes stale if magpie rotates it. Route (2) still works: look the session up by the CLAUDE_JOB_DIR basename or the session id in a registry. Background sessions also lack shell-only variables such as TRUE_OAI_KEY.
EVIDENCE: AGREES on the outcome. The cause needs one correction, and I found one new constraint. For 9c0bfc0e, launched with ROLE=router and TID=t123, $.env.get returned undefined for both, and the child printed `ROLE= TID=`. The child env also lacked TRUE_OAI_KEY, SSH_CONNECTION and CHROME_PATH, which the launching shell has. daemon.log: '[2026-11-09T08:44:39.845Z] [bg] bg claimed-spare 9c0bfc0e (shell)'. CAUSE CORRECTION: the claiming spare (pid 550477, 'claude bg-spare --bg-spare .../spare/b328afab.claim.sock') was only 12:55 old. Its parent is 'claude bg-pty-host' (550467), whose parent is the daemon 2544385 ('claude daemon run ...', elapsed 3-03:35:55). The daemon's environ has SSH_CONNECTION but the spare's does not, so the spare's env is a filtered copy built on the daemon side, and the launching shell's env never reaches it. The report's 'spare keeps the daemon's environment from three days ago' is inaccurate. Workaround 1 re-checked in both orders. `claude -p --settings <magpie> --settings extra.json` (00c71792) gave ROLE=router and TID=t123 with no BASE, and failed with "There's an issue with the selected model (claude/claude-haiku-5-5)". The reversed order (9c09e433) gave BASE with no ROLE. The last --settings applies and the files are not merged. Workaround 2 re-checked: a merged file (magpie settings plus env ROLE=architect and TID=t456, mode 0600) used with `claude --bg --settings merged.json` (2d248fb8-203d-4d0b-9539-99d20ddc82a5). The hook got BASE, 'architect' and 't456'. magpie usage has a claude/claude-haiku-5-5 row (medium, status 200) and three gpt-6-astra rows (status 200). NEW: respawnFlags hold the merged file's path, not its contents. After `claude stop 2d248fb8`, I deleted the file and ran `claude --bg --resume 2d248fb8-...`. The job failed: "failed exit

### [partial] (c4) `claude-magpie --bg --resume <id>` on a finished background session: same session id or a new one?
CONSEQUENCE: Same id requires two things: the session's process is stopped (pid null in `claude agents --json --all`, or `claude stop <shortid>` first), and the plugin runs plain `claude --bg --resume <full id> "<msg>"` with no flags. Resuming a session that is still idle-alive forks a copy, and a plain copy has no saved options and fails. Any claude-magpie --bg --resume always forks a copy, which then needs every flag again. Section 8 should state the stop-then-plain-resume rule. Sending a message to a still-running idle session needs another channel ('claude attach' is interactive); I did not test one.
EVIDENCE: AGREES once the session is stopped. I found a precondition the report missed. NEW: after its first turn, a --bg session keeps its process alive. `claude agents --json --all` showed 9c0bfc0e as state 'done', status 'idle', pid 550477. In that state, both plain `claude --bg --resume 9c0bfc0e-... "SAMEID"` and `claude-magpie --bg --resume ...` printed "note: session 9c0bfc0e is already running in the background, so this started a copy as 0fdb636b" (plain) or "as 1f7c226f" (magpie). The plain copy 0fdb636b had respawnFlags [] and failed with "There's an issue with the selected model (claude/claude-haiku-5-5)" (no gateway). The magpie copy 1f7c226f had respawnFlags ['--settings',<magpie>,'--model','codex/gpt-6-astra'] and no --plugin-dir. Its gateway rows are codex/gpt-6-astra, and its transcript carries BGOK. After `claude stop 9c0bfc0e` (pid None), plain `claude --bg --resume 9c0bfc0e-... "SAMEID"` printed "note: woke session 9c0bfc0e with its saved options (--settings, --plugin-dir, --debug-file, --model)" and "backgrounded · 9c0bfc0e". The mod fired again with BASE set: debug line 08:46:58 `RECHECK {"BASE":"http://127.0.0.1:3425","JOBDIR":"/home/ubuntu/.claude/jobs/9c0bfc0e",...}`, with no ROLE key even though MAGPIE_TASKS_ROLE=wrong was set. magpie usage has 08:46:59Z claude/claude-haiku-5-5, medium, status 200 for 9c0bfc0e. With the session stopped, `claude-magpie --bg --resume 9c0bfc0e-...` still printed "note: background session 9c0bfc0e keeps its own saved options, so the flags you passed started a copy as d9405878. Without flags, the same command continues 9c0bfc0e itself." d9405878's respawnFlags were ['--settings',<magpie>,'--model','codex/gpt-6-astra'], its requests went to codex/gpt-6-astra, it had no plugin-dir, and its transcript carries BGOK.

## hook-order
artifacts: Probe root: /tmp/magpie-probe-reverify-IotI (created with `mktemp -d /tmp/magpie-probe-reverify-XXXX`). The repository, ~/.claude/settings.json, ~/.claude/plugins/installed_plugins.json and ~/.claude/plugins/known_marketplaces.json were not changed: grep for probe-mkt/probe-p/probe-q in those three files returned 0 hits each. No --bg sessions were started and no tmux sessions were created; the three tmux sessions listed (main, octopus-paper, recorder) already existed, created Oct 12. `ps -eo pid,etime,args | grep -E "magpie-probe-reverify|claude-magpie -p"` is empty.

Scratch repo and worktree

### [works] (a) 两个插件的 agent.spawn 钩子谁先运行，第二个能否看到第一个改写后的 model/cwd/prompt，顺序由什么决定
CONSEQUENCE: 外层插件先运行，内层插件收到外层改写后的输入，最内层的改写到达引擎，所以同一字段由更靠内的插件决定。

用 --plugin-dir 开发时，magpie-tasks 位于 subagent-opus 和 jev 之外。用 `claude plugin install` 安装后情况相反：新插件追加在 enabledPlugins 末尾，成为 user 层最内层，排在 advisor-guard 之后，因此它在 agent.spawn 中写的 model 和 cwd、在 turn.step 中写的 effort 会覆盖 subagent-opus 和 jev 的值。由此得到两条推论：
- 开发时观察到的“subagent-opus 会把模型改成 opus”和“jev 决定最终强度”只适用于 --plugin-dir 开发方式。
- 安装后，magpie-tasks 需要自己判断哪些请求不该改写（例如父会话为 Fable/Mythos 时尊重 subagent-opus 的意图，jev 管理的主对话不要覆盖强度），不能依赖其他插件在内层兜底。

手工编辑 settings 或在界面中启用的插件，位置取决于它在 enabledPlugins 中的键位置。
EVIDENCE: 复核结论：原报告关于链的嵌套方式和 --plugin-dir 顺序的观察全部成立；“安装后位置无法确定”这一点已由本次测量确定，结论需要更正。

1. --plugin-dir 顺序。插件名特意设为字母序与命令行顺序相反。
- r1-PQ（--plugin-dir yy-probe-p 在前）：`$ built for yy-probe-p,bb-probe-q,subagent-opus,no-bg-poll,workflow-opus-guard,mode,jev,math-render,reply-language,context-memory,advisor-guard,...`。bb-probe-q 收到的输入是 `spawn.enter origin=engine/core model=claude/claude-haiku-4-5 cwd=.../wt-p prompt="... [yy-probe-p]"`，也就是 yy-probe-p 改写后的结果。yy-probe-p 的 trace 依次为 `{"i":1,"p":"bb-probe-q","model":"claude/claude-haiku-4-5","cwd":".../wt-p"}`、`{"i":2,"p":"subagent-opus","model":"claude/claude-haiku-5-5","cwd":".../wt-q"}`、`{"i":3,"p":"engine","tier":"core","model":"claude/claude-haiku-5-5","cwd":".../wt-q","ptail":"... [yy-probe-p] [bb-probe-q]"}`。
- r2-QP（交换顺序）：`$ built for bb-probe-q,yy-probe-p,...`，engine 收到 `claude/claude-haiku-4-5` 和 `.../wt-p`，CSV 中子代理两行为 `claude/claude-haiku-4-5,claude-haiku-4-5-20251001`。

2. 已安装插件的顺序由 enabledPlugins 的键顺序决定，与 installed_plugins.json 和插件名无关。
- x-order：命令为 `--setting-sources project,local --settings '{"enabledPlugins":{"jev@sipeng-mods":true,"advisor-guard@sipeng-mods":true,"subagent-opus@sipeng-mods":true}}'`，得到 `$ built for jev,advisor-guard,subagent-opus,...`，三个 `hooks module ... loaded` 行也按这个顺序出现。installed_plugins.json 中这三者的顺序是 subagent-opus、jev、advisor-guard。这次运行因为额外传了 --settings，以模型错误退出（exit 1），但链在 engine.create 时已经建好，排序证据有效。
- 临时 CLAUDE_CONFIG_DIR（$RUN/cfg）：`claude plugin install` 把每个新插件追加到 enabledPlugins 的末尾，依次为 `...,mm-one,aa-two,kk-three,cc-four`。会话 x-installed-1 的链为 `$ built for kk-three,cc-four,...`。随后只把 cc-four 移到 enabledPlugins 最前面（installed_plugins.json 保持 `mm-one,aa-two,kk-three,cc-four` 不变），再加上 `--plugin-dir bb-probe-q` 运行，得到 `$ built for bb-probe-q,cc-four,kk-three,...`。bb-probe-q 的 trace 为 `[{"i":1,"p":"cc-four"},{"i":2,

### [works] (b) 两个插件在 turn.step 中改写 effort，哪一个到达请求（magpie usage --csv 的 effort 列）
CONSEQUENCE: 最内层插件的强度值到达 Magpie。开发方式（--plugin-dir）下 jev 位于 magpie-tasks 之内，会决定最终强度。安装后 magpie-tasks 位于 jev 之内（见 (a)），由 magpie-tasks 决定最终强度，因此它对 jev 管理的模型（Opus、Astra、Sol）必须只改写带任务标记的子代理请求，其余请求原样传递。jev 在这些高价模型上是否覆盖强度本次没有测，任务要求只用低价模型。haiku-4-5 这类不支持强度的模型，Magpie 的 effort 列（显示 xhigh）不能用来核对插件设置的强度。
EVIDENCE: 复核结论：与原报告一致。
- r1-PQ：yy-probe-p 设 low、bb-probe-q 设 high。bb-probe-q 的 step.enter 显示 `effort=low`，说明它看到了外层的改写。yy-probe-p 的 trace 为 `{"i":1,"p":"bb-probe-q","effort":"low"},{"i":2,"p":"jev","effort":"high"},{"i":3,"p":"engine","tier":"core","effort":"high"}`。会话 37f76706 的 4 行 CSV 全为 `claude/claude-haiku-5-5,claude-haiku-5-5,high`。
- r2-QP：交换顺序后 engine 收到 low，会话 c740b36a 中主对话 2 行 CSV 为 `low`。
- 主对话改写前的初始值为 `effort=medium`；haiku-5-5 子代理的初始值也是 medium。
- jev 在 haiku-5-5 上原样传递，收到 high 发出 high，收到 low 发出 low。
- haiku-4-5 子代理（r2、r5）：外层插件的 step.enter 显示 `effort=undefined`，trace 中 engine 收到钩子设的值（r2 为 low，r5 为 high），CSV 却记录为 `claude/claude-haiku-4-5,claude-haiku-4-5-20251001,xhigh`。原因未查明。
- x-installed-2 补充：已安装的内层插件 kk-three 设的 low 覆盖了 --plugin-dir 外层插件设的 high，CSV 为 `low`。

### [works] (c) 插件 A 在自己的钩子中调用 $.agent.spawn：B 的 agent.spawn 是否触发、能否改写模型；B 和 A 的 turn.step 是否能看到该子代理的请求
CONSEQUENCE: magpie-tasks 自己调用 $.agent.spawn 时会再次进入自己的 agent.spawn 钩子，需要用 next.origin.plugin 识别并避免重复做路由判断；其他插件（subagent-opus、tg-router）也会看到这次启动，并按链中位置可能改写它。

如果在 turn.step 钩子中启动子代理，同一插件的 turn.step 无法设置该子代理的强度；在 tool.call 中启动，则同一插件看不到子代理的工具调用。所以应在 prompt.submit、命令或其他事件中启动。

jev 可以用请求的 origin 识别由插件启动的子代理，但模型通过 Agent 工具发起、由 magpie-tasks 改写的子代理 origin 仍是 engine/core，所以仍需要委派说明中的任务标记。

-p 模式下钩子启动的子代理会运行完毕，但它的回答只出现在它自己的 turn.complete 中，-p 结果里没有。magpie-tasks 要取回结果，必须在 turn.complete 钩子中按 agentId 收集。
EVIDENCE: 复核结论：与原报告一致；原报告留下的“-p 是否等待钩子启动的子代理”已确定，见第 4 点。

1. agent.spawn 两个插件都会触发，包括调用者自己的。
- r3（prompt.submit 中启动）先出现 `yy-probe-p spawn.enter origin=yy-probe-p/user model=undefined ... bg=true`，再出现 `bb-probe-q spawn.enter origin=yy-probe-p/user model=claude/claude-haiku-4-5 ... [yy-probe-p]`。
- B 的模型改写生效：engine 收到 `claude/claude-haiku-5-5`，`$.agent.spawn` 返回 `{"model":"claude/claude-haiku-5-5","agentId":"ac0e494cab5a99cf7"}`。
- r5（Q 外层、P 内层）中内层 P 设的 haiku-4-5 生效，CSV 子代理为 `claude/claude-haiku-4-5,claude-haiku-4-5-20251001`，主对话为 haiku-5-5。
- 钩子启动子代理时还会触发一次 Agent 的 tool.call，结果为 `tool=Agent result={..."isAsync":true,"status":"async_launched",...}`，origin 是启动它的插件。

2. turn.step 的跳过只针对发起启动的那个钩子。
- r3：两个插件都看到子代理的 turn.step（`yy-probe-p step.enter origin=yy-probe-p/user agent=ac0e494cab5a99cf7`）。
- r4（P 外层，在 P 的 turn.step 中启动）：只有 Q 看到子代理的 step，Q 的 trace 为 `[{"i":1,"p":"jev"},{"i":2,"p":"engine","effort":"high"}]`，CSV 全为 high；P 的 tool.call 钩子仍记录到子代理的 Bash。
- r5（Q 外层、P 内层，在 P 的 turn.step 中启动）：Q 仍看到子代理的 step，P 被跳过。
- r6（在 P 的 tool.call 中启动）：子代理的 Bash tool.call 和这次启动产生的 Agent tool.call 都只有 Q 记录到，P 的 turn.step 和 turn.complete 仍看到这个子代理。这与类型文档 claude-code.d.ts 中 TurnStepInput.agentId 的说明一致：“A subagent a hook spawned through `$.agent.spawn` steps past that hook, as its tool calls do; every other hook sees its steps.”

3. origin：钩子启动的子代理请求的 next.origin 为启动它的插件（`origin=yy-probe-p/user`）；模型通过 Agent 工具启动的子代理为 `origin=engine/core`（r1、r2，这两次为前台启动，`bg=false`）。

4. -p 会等待钩子启动的子代理结束才退出，但不会把子代理的回答交回主对话。
- r6：主对话 turn.complete 在 08:54:28.2，子代理的 Bash 在 30.3，子代理 complete 在 31.7，session.end 在 31.76，result.json 的修改时间为 31.749。
- r7-slowchild（子代理要求做 4 次 Bash，主对话不用工具）：主对话 complete 在 08:56:05.4，子代理的 4 次 Bash 在 05.5 到 10.4 之间，子代理 complete 在 11.7，session.end 在 11.8。result.json 为 `num_turns 1, duration_ms 4198, resu

### [works] (d) agent.spawn 钩子能否把 cwd 设为另一个已存在的目录（/tmp 下的 git 工作副本），子代理的 Bash 是否在那里运行
CONSEQUENCE: magpie-tasks 可以在 agent.spawn 中把子代理指向任务的工作副本，即使它在主项目目录之外。cwd 和 model 一样由最内层插件决定；安装后 magpie-tasks 位于最内层（见 (a)），它设的 cwd 会生效，除非之后安装的插件也改写 cwd。目录不存在、或在非 bypass 权限模式下的行为本次没有测试。
EVIDENCE: 复核结论：与原报告一致。
- r1-PQ：Agent 调用没有设置 cwd（`cwd=undefined`）。外层改为 wt-p，内层改为 wt-q 后，engine 收到 `cwd=/tmp/magpie-probe-reverify-IotI/wt-q`。子代理 Bash 输出 `{"stdout":"/tmp/magpie-probe-reverify-IotI/wt-q"}`，最终回答以 `/tmp/magpie-probe-reverify-IotI/wt-q` 开头。
- r2-QP：内层 yy-probe-p 改写，结果为 `/tmp/magpie-probe-reverify-IotI/wt-p`。
- 主会话 cwd 为 `/tmp/magpie-probe-reverify-IotI/work`；钩子启动且没有改写 cwd 的子代理（r3 到 r6）pwd 都输出这个路径。
- 工作副本由 `git worktree add` 创建，位于主会话目录之外。
- 运行时传了 `--permission-mode bypassPermissions`，没有权限提示。

## api-messages
artifacts: 运行目录：/tmp/magpie-probe-recheck-JQE9（新建，没有复用上次的目录）
探测 mod：/tmp/magpie-probe-recheck-JQE9/mod（.claude-plugin/plugin.json；hooks/hooks.json {"modules":["./register.ts"]}；hooks/register.ts）。它在每个 turn.step index 0 和每个 turn.complete 把 $.session.messages({as:'api'}) 和 $.session.messages() 写到 out/NNN-{main|sub-<agentId>}-{step0|complete}.json；对子代理使用 {agentId}；把每次 session.append 的 door/origin/agentId/type/name/role/isMeta/head 记录到 out/appends.json；通过 prompt.submit、classic.UserPromptSubmit、classic.PostToolUse、classic.SessionStart 注入标记；prompt 中含 APPENDNOTE 时调用 $.session.append 追加一条插件笔记。
项目内测试命令和技能：/tmp/ma

### [works] Overall shape of $.session.messages({as:'api'}) for the main loop and for a subagent
CONSEQUENCE: JEV 可以从 {as:'api'} 视图重建对话，但要按块拆分每条 user 消息，不能假设每条消息只有一块，也不能假设 user/assistant 严格交替。子代理视图里的 task-notification 要按 task-id 加 summary 去重，turn 起点也不能用“消息最后一块”来判定。这个视图不是线上请求的逐字节副本，设计中如果要计算缓存或 token，不能把它当作请求原文。压缩后只能用 api 形式。
EVIDENCE: 复核结论：大体一致，有三处更正。一致的部分：主循环在 turn.step index 0 读到的是 {role, content: Block[]} 数组，第一条是 user 消息。连续的 user 侧行合并成一条 user 消息，typed prompt 是最后一个 text 块。冒烟运行 out/001-main-step0.json：messageCount=22，api 长度 1，块 0 是 'SessionStart hook additional context: RECHECK-SESSIONSTART marker'，块 1-16 是引擎提醒，块 17 是 'Reply with the single word: kiwi'。appends.json 里 prompt 行（door 'prompt'）先于 attachment 行写入，api 形式把 prompt 放到最后。子代理用 $.session.messages({agentId, as:'api'}) 能读到：out/006-sub-a4923915573cfbe20-step0.json 的 msg0 依次是 deferred tools、environment、model、skills、instructions、date、attribution、advisor 八个提醒，后面跟委派 prompt 'Run the Bash command `echo chk-sub-321` ...'。turn.complete 对子代理带 agentId 和 answer（008）。更正 1：子代理的 api 视图会把后来到达的通知并进 msg0。044（通知到达前）的 msg0 有 9 块；047-step0 和 048-complete 的 msg0 多出块 [0.9]，即 bbg7p4hzs 的 task-notification，排在委派 prompt 之后；同一条通知又作为 msg4 出现一次。session.append 只记录了一行（row 286），磁盘转录里实际发出的请求（agent-a83b0057bf058d018.jsonl 的 row 31，tail 引用的 blob）只在末尾带它一次。因此“typed prompt 一定是最后一块”在子代理视图里不成立，通知也会被数两次。更正 2：{as:'api'} 是规范化后的视图，与线上请求不同。主会话转录 793c22bb-...jsonl 里的 api-request / api-request-blob 行显示，真实请求带 role:'system' 消息，SessionStart 上下文、environment、PostToolUse 上下文等提醒去掉 <\system-reminder> 包装后放在里面，同时带 tool_addition 块；user 消息里只留下 prompt.submit 上下文、instructions、attribution 和 prompt。更正 3：压缩后 plain 形式不随压缩缩短。037-step0 中 api=4、plain=66；050 中 api=17、plain=82。

### [works] How system reminders and hook additionalContext appear
CONSEQUENCE: 在 api 视图里丢掉提醒块时，要用 /^<\system-reminder(\s[^>]*)?>/ 匹配，不能只认 '<\system-reminder>\n'。处理 tool_result 时，字符串和数组两种 content 都要支持，不能按工具名推断。其他插件追加的笔记在 api 视图里与用户文本无法区分，JEV 需要自己挂 session.append，记录 door 'note' 加 origin kind 'plugin' 的文本，再从对话中减去。
EVIDENCE: 复核结论：大体一致，有一处更正和一处补充。一致的部分：在 api 视图里，引擎提醒是 user 消息中的 text 块，开头为 '<\system-reminder>\n'，前缀与报告相同（# Environment、You are powered by the model、# Output Style、# Language、deferred tools、Available agent types、# MCP Server Instructions、skills、<\total_tokens>、Plain output style is active、Codebase and user instructions、Today's date、Attribution、# Advisor Tool）。钩子上下文同样是提醒块：'SessionStart hook additional context: RECHECK-SESSIONSTART marker'、'UserPromptSubmit hook additional context: RECHECK-CLASSIC-UPS marker'、'prompt.submit hook additional context: RECHECK-PROMPTSUBMIT-CTX marker\n用中文回复用户。...'（reply-language 的上下文并在同一块里）。PostToolUse 上下文在 tool_result 里面，例如 034 msg4 的 Bash 结果字符串为 'chk-tool-out-555\n\n<\system-reminder>\nPostToolUse:Bash hook additional context: RECHECK-POSTTOOL marker\n<\/system-reminder>\n\n<\system-reminder>\n<\total_tokens>...'。ToolSearch 的结果消息是 tool_result（内容为 ['tool_reference']）加上并列的 'Tool loaded.' 和若干提醒块（034 msg44）。appends.json 的 door/origin 与报告一致：hook-context 加 hook_additional_context，origin 为 {kind:'hook', event:'SessionStart'|'UserPromptSubmit'|'PostToolUse'} 或 {kind:'plugin', event:'prompt.submit'}；引擎提醒为 door 'attachment'、origin {kind:'engine'}，name 有 environment、model、output_style_instructions、language、deferred_tools_delta、agent_listing_delta、mcp_instructions_delta、skill_listing、total_tokens_reminder、output_style、instructions、date、remote_session_change、advisor_tool。context-memory 的压缩后笔记是不带标签的 text 块 '[context-memory checkpoint=15342783080143fea94e610e32e57989 items=59]\n上下文已压缩。...'（050 块 3.22）。更正：Read 读取文本文件时，tool_result.content 是字符串（034 msg18 和 msg36 都是 str）；数组形式只出现在 Agent（034 msg8）和 SendMessage（msg46）。补充：提醒块的开始标签可能带属性。运行中的子代理收到的协调者消息包在 '<\system-reminder id="288098db9f65b525">\n...\n<\/system-reminder id="288098db9f65b525">' 里（048 msg2）。插件自己的 $.session.app

### [works] How a background-task / subagent completion notification appears
CONSEQUENCE: 规则成立：'<\system-reminder>' 块中同时含有 '[SYSTEM NOTIFICATION - NOT USER INPUT]' 和 '<\task-notification>' 时，保留为 turn 起点，只取 <summary> 和 <result>。同一个 task-id 可能先发中间结果再发最终结果，JEV 不能假设一个 task-id 只对应一条通知。子代理视图里同一条通知可能出现两次（见第一项），需要去重。
EVIDENCE: 复核结论：一致，另有三点补充。主循环中通知开启一个新 turn：一条 user 消息，先是每个 prompt 都有的钩子提醒，再是一个块 '<\system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n...\n<\task-notification>\n<task-id>…</task-id>\n<tool-use-id>…</tool-use-id>\n<output-file>…</output-file>\n<status>completed</status>\n<summary>…</summary>\n…<\/task-notification>\n<\/system-reminder>'（034 msg10/16/34/48）。子代理完成时还有 <note>、<result>、<usage>（050 msg13/15）。磁盘转录行是裸字符串 '<\task-notification>\n<task-id>…'，origin 为 {kind:'task-notification', producer:'session-task', runId:…}。session.append 行为 door 'prompt'、origin {kind:'task-notification'}，前面还有一行 door 'queue'。补充 1：通知不一定表示完成。050 msg13 是 <status>completed</status> 加 <summary>Agent "Run slow echo probe" is waiting on its own background work</summary>，<note> 写明 'the result below may be interim'；同一个 task-id 随后又通知一次（msg15，带 'finished'）。补充 2：第二次通知没有 <tool-use-id>。补充 3：子代理自己的后台任务通知，append 行（row 286）的文本已经以 '[SYSTEM NOTIFICATION - NOT USER INPUT]' 开头，isMeta 为 true；主循环的对应行是裸 '<\task-notification>'，isMeta 不存在。

### [works] How a slash-command / skill expansion appears
CONSEQUENCE: 保留紧跟在 '<\command-message>' 块后面的展开正文作为 turn 起点，可以另存命令名。丢掉 '<\local-command-caveat>'、'<\command-name>'、'<\local-command-stdout>' 和 '<\local-command-stderr>' 块。plain 形式会丢失展开正文，不能使用。
EVIDENCE: 复核结论：一致。'/chkcmd argQ'（034 msg20）在钩子提醒之后是两个块：'<\command-message>chkcmd<\/command-message>\n<\command-name>/chkcmd<\/command-name>\n<\command-args>argQ<\/command-args>\n'（append door 'command'、origin composer）和展开正文 'CHKCMD-BODY-MARKER. Reply with exactly: chkcmd got argQ\n'（door 'note'、origin engine、isMeta true）。'/chkskill'（msg22）是 '<\command-message>chkskill<\/command-message>\n<\command-name>/chkskill<\/command-name>\n' 加 'Base directory for this skill: /tmp/magpie-probe-recheck-JQE9/work/.claude/skills/chkskill\n\nCHKSKILL-BODY-MARKER. ...'。内置 /compact 在下一条 user 消息里留下 '<\local-command-caveat>The command below was run directly in Claude Code, ...'、'<\command-name>/compact<\/command-name>\n            <\command-message>compact<\/command-message>\n            <\command-args><\/command-args>\n'（command-name 在前，后续行有前导空格）和 '<\local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m<\/local-command-stdout>\n'（050 块 3.23-3.25）。plain 形式（036）里有 '<\command-message>chkcmd' 那一行，但没有 'CHKCMD-BODY'。

### [works] How the compaction summary appears
CONSEQUENCE: msgs[0] 块 0 的前缀 'This session is being continued from a previous conversation' 是唯一可用的压缩标记；保留这个块作为摘要，可以去掉其中嵌入的 tools-used 提醒。摘要之后保留的助手消息按“上一 turn 的上下文”处理。turn 检测要允许相邻的 user 消息，并且不能把 msgs[2]/msgs[3] 中恢复的提醒算作 turn。
EVIDENCE: 复核结论：一致。/compact 之后（050），msgs[0] 是只有一个 text 块的 user 消息，共 4345 个字符。开头为 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n<\system-reminder>\n<tools-used-before-summary>Agent, Bash, Read, SendMessage, ToolSearch, mcp__chkchan__channel</tools-used-before-summary>\n<\/system-reminder>\nSummary:\n1. Primary Request and Intent:'，结尾为 '...The messages after this summary are the most recent messages from before compaction, kept verbatim. The summary was written without seeing them, ...'。msgs[1] 是压缩前最后一条助手回答（thinking 加 'cherry'），原样保留。msgs[2] 和 msgs[3] 是两条相邻的 user 消息：先是 'Called the Read tool...' / 'Result of calling the Read tool' 提醒，然后是 'The following skills were invoked EARLIER'、整套提醒，SessionStart 钩子上下文再次出现（块 3.13）。之后是 context-memory 检查点块（3.22）、/compact 命令块（3.23-3.25），新 prompt 在最后（3.26）。转录行带 isCompactSummary:true，api 视图里没有这个标记。session.append 只记录了 door 'note' 的文本 '/compact'（row 215），没有出现 door 'compaction' 的行。补充：线上请求里摘要是字符串 content 的 user 消息，后面跟一条 role:'system' 消息。另外，'<tools-used-before-summary>mcp__chkchan__channel' 提醒在压缩之前就出现过：第一条 channel 消息前面有它（036 块 50.2，append row 208，door 'note'），所以这个标记不只在压缩时出现。

### [partial] How mid-turn user messages and subagent follow-ups appear
CONSEQUENCE: tool_result 中的中途输入有两种包装，都要提取：(a) '<\system-reminder>\nThe user sent a new message while you were working:\n' 到 '\n\nThis is how Claude Code surfaces' 之间的文本；(b) '<\system-reminder id="…">\nThe coordinator sent a message while you were working:\n' 到 '\n\nAddress this before completing your current task.' 之间的文本。开始标签必须允许带属性。对已完成后被续发的子代理，丢掉 'The coordinator sent a message while you were working:' 包装块，保留并列的原文块。
EVIDENCE: 复核结论：主循环部分一致，子代理部分缺少一种形式。一致的部分：工具在前台运行时输入的 prompt 不会开启新 turn，而是出现在下一个 tool_result 字符串里。034 msg40 为 'chk-slow2-ok\n\n<\system-reminder>\nPostToolUse:Bash ...\n<\/system-reminder>\n\n<\system-reminder>\nThe user sent a new message while you were working:\nCHK-QUEUED-MID2: also append the word mango at the end of your answer.\n\nThis is how Claude Code surfaces messages the user sends mid-turn ...\n<\/system-reminder>\n\n<\system-reminder>\nUserPromptSubmit hook additional context ...'。对应 append 行：door 'delivery'、type attachment、name 'queued_command'、origin composer，前面有一行 door 'queue'。补充：如果输入时 turn 已经结束（第一次尝试中 'sleep 25' 被拦截，turn 提前结束），排队的文本会成为普通的 composer turn（034 msg32 'CHK-QUEUED-MID: ...'）。子代理已完成时用 SendMessage 续发，与报告一致：032 msg4 是两个 text 块，'The coordinator sent a message while you were working:\nCHK-FOLLOWUP-888: ...\n\nAddress this before completing your current task.\n' 和原文 'CHK-FOLLOWUP-888: now run echo chk-sub-follow-999 and report what it printed.'，append 行为 door 'prompt'、origin {kind:'coordinator'}、isMeta true；主循环的 SendMessage 结果是 'Resuming agent a492391'。缺少的形式：子代理仍在运行时收到 SendMessage，结果不同。引擎把子代理正在前台运行的命令转到后台（tool_result 为 'Command was moved to the background (ID: bbg7p4hzs) so that a message that arrived while it was running can reach you; it was not interrupted. ...'），并把消息放进这个 tool_result 字符串：'<\system-reminder id="288098db9f65b525">\nThe coordinator sent a message while you were working:\nCHK-FOLLOWUP-WORKING: after that, also run echo chk-sub2-extra and report it.\n\nAddress this before completing your current task.\n<\/system-reminder id="288098db9f65b525">'（048 msg2）。append 行为 door 'delivery'、name 'queued_command'、origin {kind:'coordinator'}（row 273）。这种形式没有并列的原文块。主循环的 SendMessage 结果是 'Message queued for delivery to a83b0057bf058d018 at its next tool round.'。

### [works] How Telegram-style <channel> messages appear
CONSEQUENCE: 规则成立：匹配 /^<channel\s[^>]*>\n?([\s\S]*?)\n?<\/channel>$/ 的 text 块是 turn 起点，保留正文；需要时单独取 reply_to_message_id 和 image_path。不能假设一定有 ts 等属性。JEV 必须使用 api 形式，因为 plain 形式会丢掉 channel 行。
EVIDENCE: 复核结论：一致，有两点补充。我另写了一个 MCP stdio 服务 scripts/chanserver.py（source 为 chkchan，meta 中有 chat_id、message_id、user、user_id、reply_to_message_id，没有 ts），通过 --dangerously-load-development-channels server:chkchan 加载。api 视图中 channel 消息是钩子提醒之后一个不带包装的 text 块：'<\channel source="chkchan" chat_id="900" message_id="501" user="chkuser" user_id="11" reply_to_message_id="499">\nCHK-CHANNEL-BODY-1: reply with the single word cherry.\n</channel>'（036 块 50.3；压缩后的第二条在 050 块 5.2）。append 行为 door 'prompt'、origin {kind:'channel', server:'chkchan'}、isMeta true；转录行相同。plain 形式（036）不含任何 channel 内容，只有助手回答。补充 1：标签属性就是服务端 meta 的原样映射，引擎不会添加 ts。补充 2：第一条 channel 消息前面多了一个提醒块 '<\system-reminder>\n<tools-used-before-summary>mcp__chkchan__channel</tools-used-before-summary>\n<\/system-reminder>\n'，丢弃提醒的规则会把它去掉。转录中的存储形式（scripts/chanshape.py 统计 126 个含 '<channel source' 的转录，其中包括本次和上次探测的运行）：source 为 tg-channel 105 次，plugin:telegram:telegram 27 次；直接写入的行是字符串 content、isMeta true、origin kind 'channel'，属性集合为 source/chat_id/message_id/[reply_to_message_id]/user/user_id/ts/[image_path]。转发给 worker 的形式是 origin kind 'coordinator'，以 'The coordinator sent a message while you were working:\nTel' 开头，共 48 次。

### [works] How to identify the final assistant text of a turn, and whether thinking blocks appear
CONSEQUENCE: 最终文本取该 turn 最后一条不含 tool_use 的 assistant 消息，把其中 text 块拼接起来；跳过 thinking 块，它们在这里没有文本。含 tool_use 的 assistant 消息都是中间消息。含 tool_result 的 user 消息属于 turn 中间（包括其中的 'Tool loaded.'），只从中提取中途输入。
EVIDENCE: 复核结论：一致。每个 API 响应对应一条 assistant 消息；中间文本和 tool_use 在同一条消息里，例如 034 msg7 为 [text 'Delegating now.', tool_use Agent]，msg29 为 [thinking, text '前台 `sleep` 被环境拦截...', tool_use Bash]。scripts/rules.py 取每个 turn 最后一条不含 tool_use 的 assistant 消息的 text，与 turn.complete 的 e.answer 对比，25 个 complete 转储（主循环和子代理）全部一致。thinking 块：Haiku 5.5 经 Magpie 返回 {type:'thinking', thinking:'', signature:…}，文本为空、带签名（034 msg17/29/39/41/43，050 msg1/4/8/14/16，子代理 048 msg1/3）。线上请求参数为 thinking {type:'adaptive', display:'summarized'}。

### [partial] Concrete filtering rule set
CONSEQUENCE: 修正后的规则：(2) 用 /^<\system-reminder(\s[^>]*)?>/ 识别提醒块；(7) 在 tool_result 内容中同时提取 'The user sent a new message while you were working:' 和 'The coordinator sent a message while you were working:' 两种包装，后者以 '\n\nAddress this before completing your current task.' 结束，开始标签可能带 id；(8) 取消“最后一块”的假设，typed prompt 只按“去掉其他各类块之后剩下的文本”判定，并用 JEV 自己的 session.append 记录（door 'note'，origin kind 'plugin'）减去插件笔记；另外增加一条：task-notification 按 task-id 加 summary 去重。这套规则针对的是 {as:'api'} 视图，与线上请求的字节布局不同。
EVIDENCE: 我把报告的 8 条规则实现为 scripts/rules.py，在 034、050、032、048 上运行。主循环 034 和 050 的 turn 起点、通知、命令正文、channel、摘要、中途输入和最终答案全部识别正确，只有一个例外：插件追加的笔记 'RECHECK-PLUGIN-APPENDED-NOTE xyz\n' 被归为 typed，而且不是消息最后一块（输出为 'typed[NOT-LAST 4/5] msg24'）。这推翻了第 (8) 条中“剩下的裸 text 块是消息最后一块”的说法。typed prompt 本身仍在最后。子代理 048 有两处失败：(a) 第 (7) 条的正则只匹配 'The user sent a new message'，运行中子代理收到的 '<\system-reminder id="…">\nThe coordinator sent a message while you were working:' 没有被提取，CHK-FOLLOWUP-WORKING 完全丢失（输出中没有 midturn 行）；(b) 同一条通知被识别两次（msg0 和 msg4），委派 prompt 在 msg0 中被标为 'typed[NOT-LAST 8/9]'。032（续发已完成的子代理）的结果正确。
