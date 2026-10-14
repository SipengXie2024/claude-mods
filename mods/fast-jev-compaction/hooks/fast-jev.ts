import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 90,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
  // A self-hosted Jev serves one request at a time well; unbounded batches
  // queue behind each other and starve other Jev clients on the same backend.
  maxConcurrentRequests: 2,
  // Splash pairs the full state with every question and refuses a request
  // whose prepared tokens pass 1,048,576: 32 questions x a 25k-token state fits.
  maxQuestionsPerRequest: 32,
  // Splash prefills a 25k-token state in about 12 s (~2,150 tok/s); past this
  // a request is abandoned so a stuck backend cannot hold the session.
  requestTimeoutMs: 30_000,
};

/** Hosts that stay on machines we run: loopback and the sub2api Docker bridge. */
export const LOCAL_JEV_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '172.21.0.1'];

/**
 * Whether `url` may receive Jev state (the whole conversation): http(s) to a
 * local host or one listed in `extraHosts` (comma-separated). Anything else, a
 * missing URL included, means no Jev call, so a lost or mistyped config never
 * sends a conversation to a hosted API.
 */
export function jevEndpointAllowed(url: string | undefined, extraHosts = ''): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const extra = extraHosts.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...LOCAL_JEV_HOSTS, ...extra].includes(parsed.hostname.toLowerCase());
}

/** The endpoint's host for logs and messages; never its path, query or userinfo. */
function endpointHost(url: string | undefined): string {
  if (!url) return '(unset)';
  try {
    return new URL(url).host;
  } catch {
    return '(invalid)';
  }
}

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  /** System One endpoint; must pass `jevEndpointAllowed`, unset means no Jev call. */
  baseUrl?: string;
  /** Comma-separated hosts allowed besides LOCAL_JEV_HOSTS (JEV_ALLOWED_HOSTS). */
  allowedHosts?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
  /** Per Jev request; 0 or less waits as long as the fetch takes. */
  requestTimeoutMs: number;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
    'maxConcurrentRequests',
    'maxQuestionsPerRequest',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    requestTimeoutMs: optionNumber(options, 'requestTimeoutMs', HOOK_DEFAULTS.requestTimeoutMs),
  };
  config.maxConcurrentRequests ??= HOOK_DEFAULTS.maxConcurrentRequests;
  config.maxQuestionsPerRequest ??= HOOK_DEFAULTS.maxQuestionsPerRequest;
  const baseUrl = optionString(options, 'baseUrl');
  if (baseUrl) config.baseUrl = baseUrl;
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const allowedHosts = optionString(options, 'allowedHosts');
  if (allowedHosts) config.allowedHosts = allowedHosts;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/**
 * `fetchFn` that rejects once `ms` pass. `$.http.fetch` takes no signal, so this
 * is a race: the losing fetch finishes on its own and its answer is unused.
 * Claude Code 2.1.299 also aborts a fetch after 30 s by itself, but the
 * 2.1.274 types promise no limit, so the bound is kept here.
 */
export function withTimeout(
  fetchFn: HookFetch,
  ms: number,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
): HookFetch {
  if (!(ms > 0)) return fetchFn;
  return async (url, init) => {
    const stop = new AbortController();
    const fetched = fetchFn(url, init);
    fetched.catch(() => {});
    const expired = sleep(ms, stop.signal).then(() => {
      throw new Error(`Jev request timed out after ${ms} ms`);
    });
    expired.catch(() => {});
    try {
      return await Promise.race([fetched, expired]);
    } finally {
      stop.abort();
    }
  };
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string,
  baseUrl?: string,
): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model, baseUrl }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/**
 * Runs the library over a session transcript; throws when the key is missing,
 * the endpoint is not allowed, or Jev fails.
 */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  if (!jevEndpointAllowed(config.baseUrl, config.allowedHosts)) {
    throw new Error(
      `Jev endpoint ${endpointHost(config.baseUrl)} is not a local host or in JEV_ALLOWED_HOSTS`,
    );
  }
  const result = await compact(
    messages,
    jevAsker(fetchFn, config.apiKey, config.model, config.baseUrl),
    config,
  );
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

type EnvReader = {
  env: { get: (name: string) => Promise<string | undefined> };
  settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  fs: { read: (path: string) => Promise<string> };
};

/** The jev-opus config folder, which the jev mod shares. */
async function configDir($: Pick<EnvReader, 'env'>): Promise<string> {
  return (
    (await $.env.get('JEV_OPUS_CONFIG_DIR')) ||
    `${(await $.env.get('XDG_CONFIG_HOME')) || `${(await $.env.get('HOME')) ?? ''}/.config`}/jev-opus`
  );
}

/**
 * KEY=value lines of the jev-opus gateway's .env (the same file the jev mod
 * reads), or nothing when it is missing or unreadable.
 */
async function jevOpusEnv($: EnvReader): Promise<Record<string, string>> {
  const dir = await configDir($);
  let text: string;
  try {
    text = await $.fs.read(`${dir}/.env`);
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) env[match[1]!] = match[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

/** The first of `names` set in the settings' `env` block. */
async function settingsEnv($: EnvReader, names: readonly string[]): Promise<string | undefined> {
  const env = (await $.settings.read())['env'];
  if (!env || typeof env !== 'object') return undefined;
  for (const name of names) {
    const value = (env as Record<string, unknown>)[name];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/**
 * Fills the key, endpoint and extra allowed hosts when the options leave them
 * unset: TYPESAFE_*, then the JEV_* names the jev-opus gateway uses, from the
 * process environment, then the settings' `env` block, then the jev-opus .env
 * file. `$.env.get` takes literal names only, so the engine can list what the
 * module reads.
 */
export async function resolveEndpoint($: EnvReader, config: HookConfig): Promise<HookConfig> {
  const apiKey =
    config.apiKey ??
    (await $.env.get('TYPESAFE_API_KEY')) ??
    (await $.env.get('JEV_API_KEY')) ??
    (await settingsEnv($, ['TYPESAFE_API_KEY', 'JEV_API_KEY']));
  const baseUrl =
    config.baseUrl ??
    (await $.env.get('TYPESAFE_BASE_URL')) ??
    (await $.env.get('JEV_BASE_URL')) ??
    (await settingsEnv($, ['TYPESAFE_BASE_URL', 'JEV_BASE_URL']));
  const allowedHosts =
    config.allowedHosts ??
    (await $.env.get('JEV_ALLOWED_HOSTS')) ??
    (await settingsEnv($, ['JEV_ALLOWED_HOSTS']));
  if (apiKey && baseUrl && allowedHosts) return { ...config, apiKey, baseUrl, allowedHosts };
  const file = await jevOpusEnv($);
  return {
    ...config,
    apiKey: apiKey || file['JEV_API_KEY'] || undefined,
    baseUrl: baseUrl || file['JEV_BASE_URL'] || undefined,
    allowedHosts: allowedHosts || file['JEV_ALLOWED_HOSTS'] || undefined,
  };
}

const JOURNAL_CAP = 512 * 1024;
let journalQueue: Promise<void> = Promise.resolve();

/**
 * Appends one line to `compaction-journal.jsonl` in the jev-opus folder, next
 * to the jev mod's journal; past the cap the file moves to `.1`. Never throws.
 */
async function journal(
  $: Pick<EnvReader, 'env' | 'fs'> & { fs: { write: (path: string, text: string) => Promise<void> } },
  entry: Record<string, unknown>,
): Promise<void> {
  const write = async () => {
    const path = `${await configDir($)}/compaction-journal.jsonl`;
    const line = JSON.stringify(entry);
    let text = '';
    try {
      text = await $.fs.read(path);
    } catch {
      /* first line */
    }
    if (text.length + line.length + 1 > JOURNAL_CAP) {
      await $.fs.write(`${path}.1`, text);
      text = '';
    }
    await $.fs.write(path, `${text}${line}\n`);
  };
  journalQueue = journalQueue.then(write).catch(() => {});
  await journalQueue;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    // One journal line per compaction: counts, sizes and timings, no content.
    const started = await $.clock.now();
    const requests: { ms: number; status: number | string }[] = [];
    const entry: Record<string, unknown> = { at: started, messagesBefore: event.messages.length };
    const finish = async (fields: Record<string, unknown>) => {
      await journal($, { ...entry, ...fields, ms: (await $.clock.now()) - started, requests });
    };
    try {
      const config = await resolveEndpoint($, configured);
      entry.endpoint = endpointHost(config.baseUrl);
      const timed = withTimeout(
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        },
        config.requestTimeoutMs,
        (ms, signal) => $.clock.sleep(ms, { signal }),
      );
      const { result, messages } = await compactSession(event.messages, config, async (url, init) => {
        const sent = await $.clock.now();
        try {
          const response = await timed(url, init);
          requests.push({ ms: (await $.clock.now()) - sent, status: response.status });
          return response;
        } catch (error) {
          requests.push({ ms: (await $.clock.now()) - sent, status: errorText(error) });
          throw error;
        }
      });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      const { stats } = result;
      const sizes = {
        reduction: Math.round(reductionRatio(result) * 1000) / 1000,
        stateTokens: stats.stateTokens,
        stateStage: stats.stateStage,
        kept: stats.kept,
        resultsDropped: stats.resultsDropped,
        callsDropped: stats.callsDropped,
        pinned: stats.pinned,
      };
      if (reductionRatio(result) < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        await finish({ outcome: 'below-minimum', ...sizes });
        return next(event);
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      await finish({ outcome: 'compacted', messagesAfter: messages.length, ...sizes });
      return { messages };
    } catch (error) {
      notify($, `fallback to built-in summary (${errorText(error)})`);
      await finish({ outcome: 'error', error: errorText(error) });
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
