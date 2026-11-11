# Leaderboard refresh, 2026-11-10 (non-Artificial-Analysis)

Previous snapshot: `/home/ubuntu/sipeng/claude-mods/.planning/research/model-routing-2026-11-07/evidence.csv`.
Every number below was read on a page saved in `sources/`; rows are in `rows.json` (329 rows), built by `build_rows.py`.
Arena, DesignArena full lists and Zapier AutomationBench were read through the Mac's Chrome (the server gets a Cloudflare challenge or a tracker redirect); the rest by curl or r.jina.ai.

## New models since 2026-11-07

- **Claude Fable 5.2 and Claude Mythos 5.2**, released Nov 9, 2026 (https://www.anthropic.com/claude-fable-and-mythos-5-2, `sources/anthropic-fable-mythos-5-2.txt`). Same underlying model; Fable carries cyber and biology safeguards, Mythos is limited to the Cyber and Life Sciences Verification Programs. API id `claude-fable-5-2`. Price $8 / $40 per million input/output tokens; fast mode $16 / $80. Anthropic's model overview lists Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5 (`sources/claude-models.txt`). The launch page recommends starting with Opus 5.5 for most coding and knowledge work and moving up to Fable/Mythos for the most ambitious open-ended technical work.
- **No other Anthropic model** after Nov 7 (`sources/anthropic-news.txt`; no Sonnet or Haiku update).
- **OpenAI: no new text or Codex model after Nov 7.** The API models page lists gpt-6-astra, gpt-6.1-sol, gpt-6.1-terra, gpt-6-luna, gpt-6-cyber and gpt-5.6-cyber (`sources/openai-models.txt`). The API changelog's November entries are GPT-6-Cyber (Nov 5, restricted access), GPT-Image-2.6 Sunburst/Flare (Nov 4) and GPT-Live SIP calling (Nov 2) (`sources/openai-changelog.txt`, published 10 Nov 2026 02:29 GMT). The Codex changelog's newest entries are Codex CLI 0.167.0 (2026-11-06; its release notes change no default model) and the GPT-6.1 Terra rollout to Codex (2026-10-26) (`sources/codex-changelog.txt`, `sources/codex-0.167.0.txt`). OpenAI news through Nov 9 has no model launch (`sources/openai-news.txt`). A Nov 5 ProPakistani article citing The Information said updated Astra and Sol models could ship "as early as Friday, November 6" (`sources/propakistani-openai-rumor.txt`); as of these pages nothing has shipped.

## Boards that list Fable 5.2

Mythos 5.2 is on no independent board; its only numbers are in Anthropic's launch table.

### Cognition FrontierCode 2.0 (`sources/frontiercode.txt`; changelog "Nov 9, 2026: Added Fable 5.2")

| Rank | Model (best effort) | Score |
|---|---|---|
| 1 | Fable 5.2 xhigh | 49.1% |
| 2 | Opus 5.5 max | 45.5% |
| 3 | GPT-6 Astra max | 42.8% |
| 4 | Sonnet 5.5 max | 41.0% |
| 6 | GPT-6.1 Sol max | 39.0% |
| 8 | Fable 5.1 xhigh | 32.4% |

132 tasks, best-scoring effort per model. The page publishes no interval; the further numeric columns (a second score column, flag rate, cost per rollout, tokens) have no labels in the extracted text. Fable 5.2 costs $17.73 per rollout against Opus 5.5's $12.82. All other rows are unchanged from Nov 7. Anthropic's launch page states that Fable 5.2 at High effort scored about level with Opus 5.5 at Max for roughly half the cost per task (vendor statement; the leaderboard shows only the best effort).
Against the code rule (Opus 5.5): Fable 5.2 leads by 3.6 points; with no published interval, the page does not show whether the gap exceeds noise.

### LiveBench 2.0, release 2026-11-06, "last updated 9 November 2026" (`sources/livebench.txt`, `sources/lb-20261106.csv`)

Fable 5.2 is labelled "(xhigh)"; other rows give no effort. No intervals or sample counts are shown.

| Suite | Fable 5.2 | Opus 5.5 | GPT-6.1 Sol | GPT-6 Astra | Sonnet 5.5 | GPT-6.1 Terra | Fable 5.1 |
|---|---|---|---|---|---|---|---|
| Overall | **84.9** (1st) | 83.4 | 81.4 | 84.5 | 77.0 | 78.8 | 84.0 |
| Long agentic | **82.9** (1st) | 72.8 | 65.6 | 75.6 | 63.4 | 56.2 | 74.2 |
| Design | **85.1** (1st) | 83.3 | 79.6 | 80.0 | 81.3 | 79.7 | 81.6 |
| Coding | 79.2 | 87.1 | 82.1 | 87.5 | 77.2 | 89.2 | 89.7 |
| Browser use | 86.9 | 88.4 | **93.3** | 91.3 | 89.3 | 93.1 | 89.8 |
| Data analysis | 81.5 | 80.3 | 82.7 | 83.0 | 59.5 | 82.3 | 80.3 |
| Research | **94.5** (1st) | 88.9 | 90.0 | 90.6 | 88.0 | 79.1 | 88.5 |
| Reasoning | 88.8 | 92.2 | 92.6 | 92.7 | 91.6 | 88.7 | 91.7 |
| Cost per successful task | $9.850 | $6.723 | $0.823 | $5.318 | $5.803 | $0.673 | $8.364 |
| Inference time per task | 63 min | 50 min | 21 min | 27 min | 90 min | 21 min | 27 min |

Against the rules: Fable 5.2 beats Opus 5.5 on long agentic (+10.1) and design (+1.8) and trails it on coding (-7.9); it trails Sol 6.1 and Terra 6.1 on browser use (-6.4 / -6.2); it leads research (+3.9 over Astra). No intervals are published, so none of these gaps can be tested against uncertainty.
Changes from the 2026-10-25 release used on Nov 7: coding scores changed for every listed model and all fell (Opus 96.3 to 87.1, Sol 96.0 to 82.1, Sonnet 94.7 to 77.2, Fable 5.1 97.7 to 89.7, Astra 93.7 to 87.5, Terra 94.3 to 89.2); research rose (Opus 85.0 to 88.9, Sol 83.5 to 90.0); design fell 2-4 points; long agentic moved for Fable 5.1 (77.9 to 74.2), Astra (77.5 to 75.6), Sol (68.7 to 65.6), Terra (48.6 to 56.2), Haiku (40.0 to 47.9). Browser use, data analysis and reasoning are unchanged. Coding now ranks Fable 5.1 (89.7) and Terra 6.1 (89.2) above Opus 5.5 (87.1).

### Zapier AutomationBench v1.0.6 (`sources/automationbench-zapier.txt`, full list expanded)

Business workflows across 47 tools, deterministic end-state scoring, no interval shown. Anthropic models ran with Anthropic's default refusal fallbacks.

| Rank | Model | Score | Cost / task |
|---|---|---|---|
| 1 | Gemini 4 Carbon (High) | 53.88% | $2.12 |
| 3 | Fable 5.2 (Max) | 51.45% | $4.64 |
| 6 | Fable 5.2 (XHigh) | 47.95% | $2.29 |
| 7 | Sonnet 5.5 (Max) | 44.75% | $1.14 |
| 8 | Fable 5.2 (High) | 44.29% | $1.69 |
| 9 | Opus 5.5 (Max) | 42.47% | $1.44 |
| 10 | GPT-6 Astra (Max) | 41.40% | $1.73 |
| 20 | GPT-6 Sol (Max) | 32.0% | $0.34 |
| 42 | Fable 5.1 (Max) | 22.37% | $2.45 |
| 45 | GPT-6 Luna (Max) | 20.7% | $0.04 |
| 75 | Haiku 5.5 (Max) | 12.02% | $0.10 |

GPT-6.1 Sol and GPT-6.1 Terra are not on the board. Against the knowledge-deliverable rule (Sonnet 5.5): Fable 5.2 Max is 6.7 points higher at 4 times the cost per task; Fable 5.2 High (44.29%) is level with Sonnet 5.5 Max. Anthropic's launch table quotes the same 51.4% for Fable 5.2.

### Arena (arena.ai)

- **Code / WebDev** (`sources/arena-code-webdev.txt`, board date Nov 8, 2026): Fable 5.2 (xHigh) **1832 +18/-18, AutoEval**, no human votes and no rank; Opus 5.5 (Max) 1818 +12/-12 (rank 1, 4,009 votes); Sonnet 5.5 (xHigh) 1774; GPT-6 Astra (Max) 1767; Fable 5.1 (Max) 1745; GPT-6.1 Sol (Max) 1743; GPT-6.1 Terra (Max) 1679. AutoEval is Arena's reward-model proxy-vote score, replaced once enough human votes arrive (https://arena.ai/blog/autoeval-scores/, `sources/autoeval.txt`). The 14-point gap to Opus 5.5 is inside the overlapping intervals.
- **Text Overall / Expert / Coding / Chinese and Agent Arena**: Fable 5.2 and Mythos 5.2 are absent (only the site banner "Claude Fable 5.2 (xHigh)'s AutoEval score is now on Arena"). GPT-6.1 Terra is absent from all four Text boards (only GPT-5.6 Terra appears). Text boards dated Nov 10, 2026; Agent board Nov 8, 2026.
  - Text Overall: Opus 5.5 1506±6 (rank 4), Fable 5.1 1503±6, Sol 6.1 1482±6, Astra 1474±6, Sonnet 5.5 1472±6, Luna 1441±4, Haiku 1422±6; every listed model moved by at most 1 point from Nov 7.
  - Expert: Opus 5.5 1544±16, Fable 5.1 1533±15, Sol 6.1 1524±18, Astra 1518±15, Sonnet 5.5 1513±17, Luna 1487±7, Haiku 1463±17 (was 1472). The top five overlap.
  - Coding: Astra 1548±10, Opus 5.5 1546±11, Sol 6.1 1540±12, Fable 5.1 1533±10, Sonnet 5.5 1516±11.
  - Chinese: Opus 5.5 1567±17, Fable 5.1 1563±16, Sonnet 5.5 1540±18, Sol 6.1 1530±18, Astra 1521±16.
  - Agent Arena, Net Improvement: Opus 5.5 (Max) 19.96%±2.05 rank 1; Sonnet 5.5 (Max) 15.99%±2.84; Fable 5.1 14.34%±1.98; Astra 14.24%±2.03; Sol 6.1 12.53%±1.12; Terra 6.1 12.10%±1.36; Luna 1.52%; Haiku 0.43%. Terra 6.1 has the lowest cost per task among the top seven ($0.82).

## Boards that do not list Fable 5.2 or Mythos 5.2

### MathArena (`sources/matharena-*.txt`, from the site's `/competition_tables/<id>` JSON; Nov 9 update added the October ArXivMath and BrokenArXiv; 4 runs per problem)

| Board | GPT-6.1 Sol (max) | Opus 5.5 (high) |
|---|---|---|
| ArXivMath 10/2026 (47 problems) | 90.43 ± 5.95 | 79.79 ± 8.12 |
| BrokenArXiv 10/2026 (54 problems) | 80.25 ± 7.51 | 77.78 ± 7.84 |
| ArXivMath Overall | 92.81 ± 3.10 | 82.61 ± 4.72 |
| BrokenArXiv Overall | 83.09 ± 4.59 | 77.30 ± 5.23 |
| ArXivLean 09/2026 (53 problems, still the latest) | 35.85 ± 12.91 | 47.17 ± 13.44 |
| LeanLean 10/2026 (32 repositories) | 50.45% token reduction | 47.34% |

The Overall tables now carry only the 08, 09 and 10/2026 columns, and the values equal the mean of those three months (Sol BrokenArXiv: 86.31, 82.70, 80.25, mean 83.09; Sol ArXivMath: 96.49, 91.51, 90.43, mean 92.81). The Nov 7 Overall values (Sol 94.15 / 89.67, Opus 83.79 / 84.70) also averaged the May and June tables (Sol 95.00 / 94.44 ArXivMath and 90.00 / 100.00 BrokenArXiv; Opus 81.67 / 83.33 and 95.00 / 100.00). For BrokenArXiv most of the drop comes from leaving May and June out of the window; the October tables are the lowest month for Sol on both and for Opus on ArXivMath.
GPT-6 Astra, GPT-6 Sol and Fable 5.1 were not run on September or October; their latest rows are August (57 ArXivMath problems, 56 BrokenArXiv): ArXivMath Sol 6.1 96.49±4.78, GPT-6 Sol 92.98±6.63, Astra (max) 88.60±5.83, Fable 5.1 (high) 87.72±6.03, Opus 5.5 85.96±9.02; BrokenArXiv Sol 6.1 86.31±9.00, Astra 81.94±5.82, Fable 5.1 79.76±10.52, GPT-6 Sol 78.57±10.75, Opus 5.5 77.38±10.96. ArXivLean: Astra (max) 37.74±13.05 on 09/2026, 65.22±13.76 on 06/2026. No Sonnet, Haiku, Terra, Luna, Fable 5.2 or Mythos rows anywhere.
Math rule (Sol 6.1): its ArXivMath lead over Opus 5.5 holds on October (10.6 points; intervals 84.5-96.4 and 71.7-87.9 overlap by about 3 points) and on the Overall (10.2 points; intervals do not overlap). The BrokenArXiv October gap (2.5) is well inside the intervals. ArXivLean and LeanLean are unchanged from Nov 7: Opus leads ArXivLean by 11.3 inside ±13 intervals; Sol leads LeanLean by 3.1 with no interval shown.

### CodePanel (`sources/codepanel.txt`, `sources/codepanel-range-table.txt`; "Scores updated Nov 4, 2026"; 47 bug PRs + 15 clean PRs)

Unchanged from Nov 7; Fable 5.2 not listed (Fable 5.1 and Astra still unscored). Bugs caught (95% range): Opus 5.5 90% (81-97), Sol 6.1 89% (80-97), Sonnet 5.5 77% (64-89), Luna 67% (53-80), Haiku 5.5 64% (50-78); all share rank 1=. False alarms per clean PR: Opus 1.7, Sol 0.9, Sonnet 2.0, Luna 0.7, Haiku 1.4. The review rule (Opus 5.5) is statistically tied with Sol 6.1 on recall; Sol has fewer false alarms and costs $0.0401 per review against $0.1525.

### DesignArena (updated Nov 10, 2026 02:06-02:15 UTC)

Fable 5.2 and Mythos 5.2 are absent from the site's model registry and from the full lists. Margins are shown in win-rate percentage units, so they cannot be compared directly with Elo gaps.
- Overall Agentic, all 73 rows (`sources/designarena-overall-full.txt`): Opus 5.5 (high) 1462, ±2.1%, 1,667 battles (was 1450); Sol 6.1 (max) 1426, ±3.2%, 848 (was 1422); Astra (max) 1394, ±2.0%, 2,146; Fable 5.1 1332; Sonnet 5.5 1283; GPT-6 Sol 1212; GPT-6.1 Terra 1189 (rank 31); GPT-6 Luna 1148 (rank 45). Haiku 5.5 is not listed.
- Python-PPTX Slides, all 36 rows (`sources/designarena-slides-full.txt`): Opus 5.5 (high) 1473, ±2.8%, 804 (was 1471); Astra (max) 1411, ±4.7%, 406 (was 1414); Sol 6.1 (max) 1396, ±5.0%, 361 (was 1401); Fable 5.1 1316. Sonnet 5.5, Haiku 5.5, Terra 6.1, Luna and GPT-6 Sol are not listed.
- Website, top 15 of 183 rows only (`sources/designarena-website.txt`): Muse Wonder (max) 1368 rank 1; Astra (max) 1333 (4th); Opus 5.5 1325 (7th); Sonnet 5.5 1315; Sol 6.1 1310; Fable 5.1 1306. Rows below 15 (Haiku, Terra, Luna) were not captured.
Design rule (Opus 5.5) still leads Overall Agentic and Python-PPTX; on the Website board it sits 8 Elo below Astra.

### Epoch FrontierSWE v2 (`sources/frontierswe-epoch.txt`; last updated Oct 28, 2026; 34 tasks x 5 runs, up to 20 hours each)

No Fable 5.2, Sol 6.1 or Terra rows. Astra (max) 65.5%, Opus 5.5 (max) 62.3%, Sonnet 5.5 (max) 61.9%, Fable 5.1 (max) 56.3%, Haiku 5.5 (max) 43.8%; no interval shown. Anthropic's launch table reports Fable 5.2 at 69.9%; its Astra, Opus 5.5 and Fable 5.1 entries equal the values on this page.

### Terminal-Bench and Terminal-Bench-Science (`sources/tbench.txt`, `sources/tbench-science.txt`)

Neither lists Fable 5.2. Terminal-Bench: Opus 5.5 65.8±3.1, Sonnet 5.5 63.9±3.0, Sol 6.1 60.9±3.0, Astra 60.3±2.8, Fable 5.1 57.6±3.3. TB-Science 0.1 (70 tasks): Astra 68.1±3.2, Opus 5.5 63.3±3.3, Fable 5.1 40.0±3.4.
Anthropic's launch table reports TB-Science 74.6% for Fable 5.2 and 75.3% for Mythos 5.2, but its own runs differ from the public board for the same models (Opus 5.5 58.7 vendor vs 63.3 public; Fable 5.1 52.6 vs 40.0), so the vendor 74.6 cannot be set against Astra's public 68.1±3.2. Inside the vendor table Astra's entry, 68.1, equals the public board value.

### Computer use and other long-horizon boards

- OSWorld (`sources/osworld.txt`): the public page lists no Fable 5.2; its newest entries are dated Aug 1, 2026. The only computer-use number for Fable 5.2 is Anthropic's OSWorld 2.1 (offline set, partial): Fable 5.2 89.3%, Opus 5.5 87.2%, Fable 5.1 83.5%, GPT-6 Astra 79.5%; Sol 6.1 and Terra 6.1 are not in that table. LiveBench browser use is the only independent computer-use signal and puts Fable 5.2 below Sol 6.1 and Terra 6.1.
- Remote Labor Index (Scale, `sources/rli-scale.txt`): the extracted page shows methodology but no model rows. Anthropic reports Fable 5.2 41.3% at High effort (Opus 5.5 21.3, Astra 20.8).
- METR time horizons (`sources/metr.txt`): "no longer actively updated" since Sep 8, 2026; newest addition Claude Mythos Preview (May 8, 2026).
- RoboDojo (`sources/robodojo.txt`): lists GPT-6 Astra (28.97 / 22.48%) and no Claude model.

## Anthropic launch table (vendor-reported, `sources/anthropic-fable-mythos-5-2.txt`)

Highest effort unless noted, safeguards on: FrontierSWE v2 69.9 (Opus 5.5 62.3, Astra 65.5); AutomationBench 51.4 (Opus 42.5, Astra 41.4); WANDR 82.1 (Opus 72.3); Remote Labor Index 41.3 at High effort; Humanity's Last Exam with tools 74.2 (Opus 67.7, Astra 57.2); Chartography 73.4 (Opus 64.4, Astra 71.0); RoboDojo Sim 64.9 (Opus 39.4, Astra 29.8). Mythos 5.2: CyScenarioBench 76.3, CVE Rediscovery 89.6, de novo binder design 85.1. No intervals given. AA-Briefcase rows are left out because they are Artificial Analysis numbers.

## Summary against the current rule choices

| Rule | Evidence on Fable 5.2 / Mythos 5.2 |
|---|---|
| Code: Opus 5.5 | FrontierCode: Fable 5.2 49.1 vs 45.5, no interval. LiveBench coding: 79.2 vs Opus 87.1. Arena WebDev: AutoEval 1832±18 vs 1818±12, overlapping. Mixed. |
| Review: Opus 5.5 | No review board lists Fable 5.2. |
| Lean prove: Opus 5.5 | Not on MathArena. |
| Design: Opus 5.5 | DesignArena: absent. LiveBench design: 85.1 vs Opus 83.3, no interval. |
| Writing: Opus 5.5 | Not on Arena Text, Expert or Chinese. |
| Math, Lean simplify: Sol 6.1 | Not on MathArena. |
| Docs / computer use: Sol 6.1; bounded computer work: Terra 6.1 | LiveBench browser use: Fable 5.2 86.9 vs Sol 93.3 and Terra 93.1. Vendor OSWorld 2.1 omits Sol and Terra. |
| Science: Astra | Not on the public TB-Science board. LiveBench research: Fable 5.2 94.5 vs Astra 90.6, no interval. |
| Terminal / knowledge deliverables: Sonnet 5.5 | Not on Terminal-Bench. AutomationBench: Fable 5.2 Max 51.45 vs Sonnet 5.5 Max 44.75 (cost $4.64 vs $1.14); Fable 5.2 High 44.29 level with Sonnet. LiveBench long agentic: 82.9 vs Sonnet 63.4 and Opus 72.8, at 63 min and $9.85 per successful task. |
