# claude-magpie JEV: Astra and GPT-6.1 Sol

## Agreed scope

Only GPT-6 Astra and GPT-6.1 Sol gain routing. Preserve existing Opus/Mythos behavior. User selected independent policies based on public benchmarks, direct max for difficult research, and high defaults for Sol explanations, writing, and visual design.

## Policy

| Task | Astra base / deep | Sol 6.1 base / deep |
| --- | --- | --- |
| chat | low / low | low / low |
| operate | low / medium | low / medium |
| explain | medium / high | high / xhigh |
| write | medium / high | high / xhigh |
| design | medium / high | high / xhigh |
| code | medium / xhigh | medium / xhigh |
| research | high / max | high / max |

Keep configured bounds, prompt tags, manual effort pins, once-per-prompt decisions, follow-up escalation and subagent inheritance. The engine's hook supports low..max; ultra is outside this interface. Public measurements justify direction; mapping benchmarks to the task taxonomy remains a design judgment, not a measured optimum.

## Implementation

1. Centralize supported OpenAI model identity and admission, including Magpie provider prefixes, while excluding jev/ double routing.
2. Add the Sol table, update Astra deep research and policy version. Retain Astra's existing -900k identifier used by the Hermes port.
3. Record reproducible benchmark links and exact values in a repository document; update plugin metadata and README.
4. Verify pure policy/model behavior and real prompt routing on both models, including main request effort. Validate and type-check the plugin.
5. Ensure claude-magpie loads the current local JEV implementation. Installed cache inspected on 2026-11-06 is policy.v8, while this repository is policy.v13; launcher does not pass --plugin-dir. Use the supported local plugin update mechanism after verification.

## Evidence

Full comparison fetch saved in /tmp/jev-magpie-aa-comparisons.txt. Sources: Artificial Analysis comparisons for Astra high/low, high/medium, max/xhigh and Sol 6.1 medium/low, high/medium, max/xhigh; OpenAI GPT-6.1 Sol launch page.
