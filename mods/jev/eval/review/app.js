// Label review page: one row per prompt, kind and start level per row,
// saved one row at a time through the review server.
const KIND_ORDER = ['chat', 'explain', 'operate', 'write', 'design', 'code', 'research'];
const KIND_NAMES = { chat: '闲聊', explain: '讲解', operate: '操作', write: '写作', design: '设计', code: '代码', research: '调研' };
const KIND_DEFS = {
  chat: '纯客套，没有任务内容：谢谢、好的、打招呼、只要求回一段固定文字。任何提问或请求，再短也不算。',
  explain: '解释已经存在、查一下或读一下就能确定的东西：事实、概念、命令、API、现有代码怎么工作；只给材料不提要求的消息。评判、比较、改进、检查你的推理不算（算调研）。',
  operate: '操作环境，不改程序逻辑：跑命令、装依赖、部署、启停服务、同步文件、git 提交推送、改配置或 CLAUDE.md。改源代码逻辑不算（算代码）。',
  write: '产出或修改给人读的文字：论文、rebuttal、README、邮件、总结、翻译、网页上的文字。幻灯片、视频、页面或图表长什么样不算（算设计）；只审不写不算（算调研）。',
  design: '产出或修改“看起来怎样”就是交付物、要渲染出来看着检查的东西：幻灯片、讲解或动画视频（画面、配音、配乐）、页面或界面的视觉设计、图表、海报；排版、配色、字体、样式。只改文字不算（算写作）；程序逻辑或交互应用的行为不算（算代码）；只评判不改不算（算调研）。',
  code: '写、改、修、调试、测试、重构源代码或脚本逻辑，包括图表背后的数据处理和交互式应用。只跑命令或改配置不算（算操作）；页面、幻灯片、图表长什么样不算（算设计）。',
  research: '查一下解决不了的问题：调研、对比、设计、架构取舍、证明、只审不改的审查、对结果的质疑、检查你的推理、原因未知的失败。',
};
const LEVELS = ['low', 'medium', 'high', 'xhigh'];
const LEVEL_KEYS = { a: 'low', s: 'medium', d: 'high', f: 'xhigh' };

const params = new URLSearchParams(location.search);
const state = { rows: [], filter: 'todo', current: null, set: params.get('set') || 'batch2' };
const list = document.getElementById('list');
const tpl = document.getElementById('row-tpl');

const MODEL_LABELERS = new Set(['claude-draft', 'opus+sonnet']);
const isDone = (r) => !!r.by && !MODEL_LABELERS.has(r.by);
// Rows that need a person: drafts (batch 1), disagreements, audits and challenges; agreed and kept labels do not.
const inQueue = (r) => (r.status ? ['disputed', 'audit', 'challenged', 'reviewed'].includes(r.status) : true);
const STATUS_TEXT = {
  disputed: '两个模型意见不同，请你裁决',
  audit: '抽查：两个模型一致，请你确认',
  challenged: '两个模型一致，但和你原来的不同',
};
const opinionText = (o) => `${KIND_NAMES[o.kind] ?? o.kind} / ${o.effort}${o.note ? `（${o.note}）` : ''}`;

function api(path, init) {
  return fetch(path, init).then(async (res) => {
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    return res.json();
  });
}

function renderLegend() {
  const dl = document.getElementById('kind-defs');
  for (const [i, k] of KIND_ORDER.entries()) {
    const dt = document.createElement('dt');
    dt.textContent = `${i + 1} ${KIND_NAMES[k]} ${k}`;
    const dd = document.createElement('dd');
    dd.textContent = KIND_DEFS[k];
    dl.append(dt, dd);
  }
  const toggle = document.getElementById('legend-toggle');
  const legend = document.getElementById('legend');
  toggle.addEventListener('click', () => {
    legend.hidden = !legend.hidden;
    toggle.setAttribute('aria-expanded', String(!legend.hidden));
  });
}

function progress() {
  const queue = state.rows.filter(inQueue);
  const done = queue.filter(isDone).length;
  document.getElementById('count').textContent = `已复核 ${done} / ${queue.length}（共 ${state.rows.length} 条）`;
  document.getElementById('bar-fill').style.width = `${queue.length ? (100 * done) / queue.length : 0}%`;
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function modelName(m) {
  if (!m) return '';
  const id = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?/i.exec(m);
  return id ? `${id[1][0].toUpperCase()}${id[1].slice(1)} ${id[2]}${id[3] ? `.${id[3]}` : ''}` : m;
}

function setPick(el, row) {
  for (const b of el.querySelectorAll('.seg button')) b.setAttribute('aria-checked', String(b.dataset.kind === row.pick.kind));
  const at = LEVELS.indexOf(row.pick.effort);
  for (const [i, b] of [...el.querySelectorAll('.ladder button')].entries()) {
    b.setAttribute('aria-checked', String(i === at));
    b.classList.toggle('lit', i <= at);
  }
}

function buildRow(row) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  el.dataset.id = row.id;
  el.querySelector('.num').textContent = `#${row.n}`;
  el.querySelector('.when').textContent = fmtTime(row.at);
  el.querySelector('.model').textContent = modelName(row.model);

  const before = el.querySelector('.before');
  if (row.before && (row.before.user || row.before.agent)) {
    before.hidden = false;
    const fill = (sel, value) => {
      const box = el.querySelector(sel);
      if (value) box.querySelector('p').textContent = value; else box.hidden = true;
    };
    fill('.before-user', row.before.user);
    fill('.before-agent', row.before.agent && `…${row.before.agent}`);
    // The reply's last lines hold what it proposed or asked: show them first.
    const agentBox = el.querySelector('.before-agent p');
    const toEnd = () => { if (before.open) agentBox.scrollTop = agentBox.scrollHeight; };
    before.addEventListener('toggle', toEnd);
    // Short prompts lean on what came before: open it for them.
    before.open = row.text.trim().length <= 40;
    requestAnimationFrame(toEnd);
  }

  const opinions = el.querySelector('.opinions');
  if (row.a || row.person) {
    opinions.hidden = false;
    const line = (who, o) => {
      const p = document.createElement('p');
      const b = document.createElement('b');
      b.textContent = `${who}：`;
      p.append(b, opinionText(o));
      return p;
    };
    if (row.a) opinions.append(line('Opus', row.a));
    if (row.b) opinions.append(line('Sonnet', row.b));
    if (row.person) opinions.append(line('你原来', row.person));
  }
  const after = el.querySelector('.after');
  if (row.after) {
    after.hidden = false;
    const a = row.after;
    const tools = Object.entries(a.tools).map(([k, v]) => `${k} ×${v}`).join('，') || '没有调用工具';
    const facts = [
      ['工具', tools],
      ['改的文件', a.files.join('，') || '无'],
      ['命令', `${a.bash} 条，失败 ${a.bashFailed} 条`],
      ['耗时与输出', `${a.durationS} 秒，${a.outputTokens} 个输出 token`],
      ['最后回复的开头', a.replyStart || '（无文字）'],
      ['最后回复的结尾', a.replyEnd || '（同上）'],
      ['你的下一句', a.next || '（没有下一句）'],
    ];
    const dl = el.querySelector('.after-body');
    for (const [k, v] of facts) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    after.open = inQueue(row) && !isDone(row);
  }

  const text = el.querySelector('.text');
  text.textContent = row.text + (row.clipped ? '\n…（后面省略）' : '');
  text.classList.add('clamped');
  const more = el.querySelector('.more');
  requestAnimationFrame(() => { more.hidden = text.scrollHeight <= text.clientHeight + 1; });
  more.addEventListener('click', () => {
    const open = text.classList.toggle('clamped');
    more.textContent = open ? '展开全文' : '收起';
  });

  const seg = el.querySelector('.seg');
  seg.setAttribute('role', 'radiogroup');
  for (const [i, k] of KIND_ORDER.entries()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.kind = k;
    b.title = `${i + 1} · ${KIND_DEFS[k]}`;
    b.textContent = KIND_NAMES[k];
    b.addEventListener('click', () => { row.pick.kind = k; setPick(el, row); focusRow(el); });
    seg.append(b);
  }
  const ladder = el.querySelector('.ladder');
  ladder.setAttribute('role', 'radiogroup');
  for (const lv of LEVELS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', lv);
    const step = document.createElement('span');
    step.className = 'step';
    const name = document.createElement('span');
    name.textContent = lv;
    b.append(step, name);
    b.addEventListener('click', () => { row.pick.effort = lv; setPick(el, row); focusRow(el); });
    ladder.append(b);
  }

  const note = el.querySelector('.note');
  // A draft's note is the model's reason, shown apart; the input holds only the person's own note.
  note.value = isDone(row) ? row.note : '';
  el.querySelector('.draft-why').textContent = !isDone(row) && row.note ? `草稿理由：${row.note}` : '';
  note.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); confirmRow(el, row); }
  });
  el.querySelector('.confirm').addEventListener('click', () => confirmRow(el, row));
  el.addEventListener('click', () => focusRow(el, false));

  paintStatus(el, row);
  setPick(el, row);
  return el;
}

function paintStatus(el, row) {
  const done = isDone(row);
  el.classList.toggle('done', done);
  el.classList.toggle('draft', !done);
  const s = el.querySelector('.status');
  s.className = 'status';
  s.textContent = done ? `已复核（${row.by}）` : row.by === 'opus+sonnet' ? '两个模型一致，已采用' : STATUS_TEXT[row.status] ?? '草稿，未确认';
}

async function confirmRow(el, row) {
  const btn = el.querySelector('.confirm');
  const s = el.querySelector('.status');
  if (!row.pick.kind || !row.pick.effort) {
    s.className = 'status err';
    s.textContent = '先选类型和档位';
    return;
  }
  btn.disabled = true;
  s.className = 'status';
  s.textContent = '保存中';
  try {
    const saved = await api(`api/rows/${encodeURIComponent(row.id)}?set=${state.set}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: row.pick.kind, effort: row.pick.effort, note: el.querySelector('.note').value.trim() }),
    });
    Object.assign(row, saved);
    paintStatus(el, row);
    s.classList.add('ok');
    progress();
    moveFocus(el, 1);
  } catch (err) {
    s.className = 'status err';
    s.textContent = `没有保存：${err.message}。再点一次确认重试`;
  } finally {
    btn.disabled = false;
  }
}

function visibleRows() {
  return [...list.querySelectorAll('.row')];
}

function focusRow(el, scroll = true) {
  for (const r of list.querySelectorAll('.row.current')) r.classList.remove('current');
  el.classList.add('current');
  state.current = el.dataset.id;
  if (scroll) el.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function moveFocus(from, delta) {
  const rows = visibleRows();
  const i = from ? rows.indexOf(from) : -1;
  const next = rows[Math.min(rows.length - 1, Math.max(0, i + delta))];
  if (next) focusRow(next);
}

function render() {
  list.textContent = '';
  const shown = state.rows.filter((r) => state.filter === 'all' || (state.filter === 'done' ? inQueue(r) && isDone(r) : inQueue(r) && !isDone(r)));
  for (const r of shown) list.append(buildRow(r));
  document.getElementById('empty').hidden = shown.length > 0;
  const first = list.querySelector('.row');
  if (first) focusRow(first, false);
}

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  state.filter = b.dataset.filter;
  document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  render();
}));

document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement) return;
  const el = list.querySelector('.row.current');
  if (e.key === 'j') { moveFocus(el, 1); e.preventDefault(); return; }
  if (e.key === 'k') { moveFocus(el, -1); e.preventDefault(); return; }
  if (!el) return;
  const row = state.rows.find((r) => r.id === el.dataset.id);
  const k = Number(e.key);
  if (k >= 1 && k <= KIND_ORDER.length) { row.pick.kind = KIND_ORDER[k - 1]; setPick(el, row); e.preventDefault(); }
  else if (LEVEL_KEYS[e.key]) { row.pick.effort = LEVEL_KEYS[e.key]; setPick(el, row); e.preventDefault(); }
  else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { confirmRow(el, row); e.preventDefault(); }
});

function load() {
  document.getElementById('count').textContent = '载入中';
  return api(`api/rows?set=${state.set}`).then((data) => {
    state.rows = data.rows.map((r) => ({ ...r, pick: { kind: r.kind, effort: r.effort } }));
    progress();
    render();
  }).catch((err) => {
    document.getElementById('count').textContent = `载入失败：${err.message}`;
  });
}

const setSelect = document.getElementById('set');
setSelect.value = state.set;
setSelect.addEventListener('change', () => {
  state.set = setSelect.value;
  history.replaceState(null, '', `?set=${state.set}`);
  load();
});

renderLegend();
load();
