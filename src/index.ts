/**
 * Paces outbound provider requests so rate limits are not overrun.
 *
 * Written for Baseten Model APIs, which enforce a requests-per-minute and a
 * tokens-per-minute limit per model. Input tokens (cached or not) and output
 * tokens all count. Budgets replenish continuously, not on a fixed minute, and
 * every response reports them in x-ratelimit-* headers. Past the limit they
 * answer 429 {"code":"rate_limit_exceeded"}.
 *
 * What it does per request:
 *  - sends one request at a time, with a minimum gap between starts
 *  - reads x-ratelimit-{limit,remaining}-{tokens,requests} from each response,
 *    projects the refill, and waits until the next request fits. The headers
 *    show the budget shared with other sessions and machines, which an
 *    in-process counter cannot see
 *  - optionally keeps a 60s sliding window of estimated tokens against
 *    PI_THROTTLE_TPM (a manual cap that works before any header was seen)
 *  - after a 429, holds every request until the cooldown expires
 *    (Retry-After when sent, otherwise a doubling backoff)
 *  - stops prompt-cache warming for the paced providers
 *
 * Configure with environment variables or a JSON file:
 *  PI_THROTTLE_CONFIG           config path, default ~/.pi/agent/provider-throttle.json
 *  PI_THROTTLE_PROVIDERS        comma list, default "baseten"
 *  PI_THROTTLE_MIN_INTERVAL_MS  minimum gap, default 3000
 *  PI_THROTTLE_TPM              manual token budget per minute, default 0 (off)
 *  PI_THROTTLE_HEADROOM         fraction of the reported token limit kept free
 *                               for output tokens and estimate error, default 0.1
 *  PI_THROTTLE_COUNT_MAX_TOKENS 1 to count the request's max_tokens as spent up
 *                               front, default off (see README)
 *  PI_THROTTLE_BASE_COOLDOWN_MS first 429 backoff, default 20000
 *  PI_THROTTLE_MAX_COOLDOWN_MS  backoff ceiling, default 300000
 *  PI_THROTTLE_MAX_WAIT_MS      longest single sleep, default 180000
 *
 * Config file keys match the variables without the prefix and in camel case,
 * for example { "tpm": 1000000, "minIntervalMs": 15000 }.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface FileConfig {
  providers?: string[];
  minIntervalMs?: number;
  tpm?: number;
  headroom?: number;
  countMaxTokens?: boolean;
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  maxWaitMs?: number;
}

function loadFileConfig(): FileConfig {
  const path = process.env.PI_THROTTLE_CONFIG ?? join(homedir(), ".pi", "agent", "provider-throttle.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as FileConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const file = loadFileConfig();

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

const PROVIDERS = new Set(
  (process.env.PI_THROTTLE_PROVIDERS ?? file.providers?.join(",") ?? "baseten")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const MIN_INTERVAL_MS = envNumber("PI_THROTTLE_MIN_INTERVAL_MS", file.minIntervalMs ?? 3000);
const TPM = envNumber("PI_THROTTLE_TPM", file.tpm ?? 0);
const HEADROOM = Math.min(envNumber("PI_THROTTLE_HEADROOM", file.headroom ?? 0.1), 0.9);
const COUNT_MAX_TOKENS = envFlag("PI_THROTTLE_COUNT_MAX_TOKENS", file.countMaxTokens === true);
const BASE_COOLDOWN_MS = envNumber("PI_THROTTLE_BASE_COOLDOWN_MS", file.baseCooldownMs ?? 20000);
const MAX_COOLDOWN_MS = envNumber("PI_THROTTLE_MAX_COOLDOWN_MS", file.maxCooldownMs ?? 300000);
const MAX_WAIT_MS = Math.max(envNumber("PI_THROTTLE_MAX_WAIT_MS", file.maxWaitMs ?? 180000), 1000);
const WINDOW_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;
/** A 429 as Pi words it in a failed assistant message, plus the plain-English forms. */
const RATE_LIMIT_ERROR = /(?<![a-z0-9])429(?![a-z0-9])|rate.?limit|too many requests/i;

/** A provider-reported budget: `remaining` of `limit` per minute as of `at`. */
interface Bucket {
  limit: number;
  remaining: number;
  at: number;
  /**
   * Start time of the request this snapshot answered. Headers arrive before the
   * response body, so that request's own cost may not be charged yet.
   */
  since: number;
  /** False when guessed after a 429 instead of read from headers. */
  exact: boolean;
}
interface Budgets {
  tokens?: Bucket;
  requests?: Bucket;
}

let lastStartAt = 0;
let cooldownUntil = 0;
let cooldownStep = 0;
let window: { at: number; tokens: number }[] = [];
let limitedCount = 0;
const budgets = new Map<string, Budgets>();
let lastKey = "";
let requestSeq = 0;
let limitedSeq = -1;
let lastRequest: { tokens: number; maxTokens: number; drop?: number } | undefined;

// Requests leave one at a time. Without this, several requests that waited out
// the same pause would wake together and fire as a burst, which is the exact
// behaviour the extension exists to prevent.
let chain: Promise<void> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = chain.then(task, task);
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isTarget(ctx: ExtensionContext): boolean {
  return Boolean(ctx.model && PROVIDERS.has(ctx.model.provider));
}

/** Prompt tokens, estimated from the serialized payload at roughly 4 characters per token. */
function estimateInputTokens(payload: unknown): number {
  try {
    return Math.ceil(JSON.stringify(payload).length / 4);
  } catch {
    return 0;
  }
}

/** Reads one field of an untyped value without asserting a shape for it. */
function fieldOf(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

function maxOutputTokens(payload: unknown): number {
  const value = fieldOf(payload, "max_tokens") ?? fieldOf(payload, "max_completion_tokens");
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Budgets are per model, and the payload names the model that is actually called. */
function requestKey(payload: unknown, ctx: ExtensionContext): string {
  const model = fieldOf(payload, "model");
  return typeof model === "string" ? model : (ctx.model?.id ?? "");
}

function prune(now: number): void {
  window = window.filter((entry) => now - entry.at < WINDOW_MS);
}

/** What the bucket holds at `at`, assuming it refills evenly at limit per minute. */
function projected(bucket: Bucket, at: number): number {
  return Math.min(bucket.limit, bucket.remaining + Math.max(0, at - bucket.at) * (bucket.limit / WINDOW_MS));
}

/**
 * Spend the snapshot cannot be trusted to include: the request it answered,
 * whose cost may only be charged once it finishes, and everything started later.
 */
function unreflected(bucket: Bucket, countTokens: boolean): number {
  let spent = 0;
  for (const entry of window) {
    if (entry.at >= bucket.since) spent += countTokens ? entry.tokens : 1;
  }
  return spent;
}

function bucketWait(
  bucket: Bucket | undefined,
  need: number,
  spare: number,
  countTokens: boolean,
  now: number,
): number {
  if (!bucket) return 0;
  // A request that cannot fit even in a full bucket waits for a full bucket instead.
  const required = Math.min(need + spare + unreflected(bucket, countTokens), bucket.limit);
  const level = projected(bucket, now);
  return level >= required ? 0 : ((required - level) * WINDOW_MS) / bucket.limit;
}

function waitMsFor(tokens: number, key: string): number {
  const now = Date.now();
  prune(now);
  let wait = Math.max(0, lastStartAt + MIN_INTERVAL_MS - now);
  wait = Math.max(wait, cooldownUntil - now);
  if (TPM > 0) {
    let used = window.reduce((sum, entry) => sum + entry.tokens, 0);
    for (const entry of window) {
      if (used + tokens <= TPM) break;
      used -= entry.tokens;
      wait = Math.max(wait, entry.at + WINDOW_MS - now);
    }
  }
  const known = budgets.get(key);
  wait = Math.max(wait, bucketWait(known?.tokens, tokens, HEADROOM * (known?.tokens?.limit ?? 0), true, now));
  wait = Math.max(wait, bucketWait(known?.requests, 1, 0, false, now));
  return wait;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    resolve();
    return promise;
  }
  const timer = setTimeout(finish, Math.min(ms, MAX_TIMER_MS));
  function finish() {
    clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
    resolve();
  }
  signal?.addEventListener("abort", finish, { once: true });
  return promise;
}

function headerNumber(headers: Record<string, string> | undefined, name: string): number | undefined {
  const raw = headers?.[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Retry-After in milliseconds. Supports seconds, HTTP-date, and retry-after-ms. */
function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const ms = headers?.["retry-after-ms"];
  if (ms) {
    const parsed = Number.parseFloat(ms);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const raw = headers?.["retry-after"];
  if (!raw) return undefined;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  const delta = at - Date.now();
  return delta > 0 ? delta : undefined;
}

function readBucket(
  headers: Record<string, string> | undefined,
  kind: "tokens" | "requests",
  now: number,
): Bucket | undefined {
  const limit = headerNumber(headers, `x-ratelimit-limit-${kind}`);
  const remaining = headerNumber(headers, `x-ratelimit-remaining-${kind}`);
  if (limit === undefined || remaining === undefined || limit === 0) return undefined;
  return { limit, remaining: Math.min(remaining, limit), at: now, since: lastStartAt, exact: true };
}

/** Stores the budgets a response reported. Returns false when it carried none. */
function recordBudgets(key: string, headers: Record<string, string> | undefined, now: number): boolean {
  const tokens = readBucket(headers, "tokens", now);
  const requests = readBucket(headers, "requests", now);
  if (!tokens && !requests) return false;
  const previous = budgets.get(key);
  if (tokens && previous?.tokens?.exact && previous.tokens.at <= lastStartAt && lastRequest) {
    // How far the budget fell across this request: shows whether max_tokens is charged up front.
    lastRequest.drop = Math.round(projected(previous.tokens, lastStartAt) - tokens.remaining);
  }
  budgets.set(key, { tokens: tokens ?? previous?.tokens, requests: requests ?? previous?.requests });
  return true;
}

function showStatus(ctx: ExtensionContext, text: string | undefined): void {
  try {
    ctx.ui.setStatus("provider-throttle", text);
  } catch {
    // Status is cosmetic; never let it break a request.
  }
}

function notify(ctx: ExtensionContext, text: string, type: "info" | "warning"): void {
  try {
    ctx.ui.notify(text, type);
  } catch {
    // Notification is cosmetic.
  }
}

function applyCooldown(
  ctx: ExtensionContext,
  key: string,
  requested: number | undefined,
  haveHeaders: boolean,
): void {
  // The response hook and the failed-message hook can both report the same 429.
  if (limitedSeq === requestSeq) return;
  limitedSeq = requestSeq;
  limitedCount += 1;
  cooldownStep += 1;
  const now = Date.now();
  const backoff = Math.min(BASE_COOLDOWN_MS * 2 ** (cooldownStep - 1), MAX_COOLDOWN_MS);
  const hold = Math.min(requested ?? backoff, MAX_COOLDOWN_MS);
  cooldownUntil = Math.max(cooldownUntil, now + hold);
  // The rejected request was most likely not charged, so it should not eat the local window.
  const last = window[window.length - 1];
  if (last && last.at === lastStartAt) window.pop();
  if (!haveHeaders) {
    // Nothing says which budget ran out, so treat both as empty and let them refill.
    const known = budgets.get(key);
    for (const bucket of [known?.tokens, known?.requests]) {
      if (bucket) Object.assign(bucket, { remaining: 0, at: now, since: now, exact: false });
    }
  }
  const seconds = Math.ceil((cooldownUntil - now) / 1000);
  showStatus(ctx, `rate limited: holding ${seconds}s`);
  notify(ctx, `Provider rate limited (${limitedCount} total). Pausing requests for ${seconds}s.`, "warning");
}

function isRateLimitedMessage(message: unknown): boolean {
  const errorMessage = fieldOf(message, "errorMessage");
  return (
    fieldOf(message, "role") === "assistant" &&
    fieldOf(message, "stopReason") === "error" &&
    typeof errorMessage === "string" &&
    RATE_LIMIT_ERROR.test(errorMessage)
  );
}

function fmt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", async (event, ctx) => {
    if (!isTarget(ctx)) return;
    const key = requestKey(event.payload, ctx);
    const input = estimateInputTokens(event.payload);
    const maxTokens = maxOutputTokens(event.payload);
    const tokens = input + (COUNT_MAX_TOKENS ? maxTokens : 0);
    await serialize(async () => {
      // Re-check after every wake. A pause longer than the single-sleep cap, or
      // one that changed while sleeping, still holds the request until it fits.
      for (;;) {
        if (ctx.signal?.aborted) {
          // The request will not leave, so it must not count as spent.
          showStatus(ctx, undefined);
          return;
        }
        const wait = Math.ceil(waitMsFor(tokens, key));
        if (wait <= 0) break;
        showStatus(ctx, `pacing ${Math.ceil(wait / 1000)}s`);
        await sleep(Math.min(wait, MAX_WAIT_MS), ctx.signal);
      }
      showStatus(ctx, undefined);
      requestSeq += 1;
      lastKey = key;
      lastStartAt = Date.now();
      lastRequest = { tokens: input, maxTokens };
      window.push({ at: lastStartAt, tokens });
      prune(lastStartAt);
    });
  });

  // Works for APIs that surface the HTTP response before the body is checked.
  // Baseten does so for every successful response, and that is where its
  // x-ratelimit-* headers are read.
  pi.on("after_provider_response", async (event, ctx) => {
    if (!isTarget(ctx)) return;
    const key = lastKey || (ctx.model?.id ?? "");
    const haveHeaders = recordBudgets(key, event.headers, Date.now());
    if (event.status === 429) {
      applyCooldown(ctx, key, retryAfterMs(event.headers), haveHeaders);
    } else if (event.status >= 200 && event.status < 300) {
      cooldownStep = 0;
    }
  });

  // Baseten uses the openai-completions API, where Pi raises the 429 as a request
  // error and never calls after_provider_response. Catch it here instead; there are
  // no headers on this path, so the cooldown falls back to exponential backoff.
  pi.on("message_end", async (event, ctx) => {
    if (!isTarget(ctx) || !isRateLimitedMessage(event.message)) return;
    applyCooldown(ctx, lastKey || (ctx.model?.id ?? ""), undefined, false);
  });

  // Warming resends the whole context, which on a 200k-token prompt is a full
  // request worth of quota spent with nothing to show for it.
  pi.on("cache_warming_decision", async (_event, ctx) => {
    if (!isTarget(ctx)) return;
    return { action: "stop" };
  });

  pi.registerCommand("throttle", {
    description: "Show what provider-throttle knows about rate limits",
    handler: async (_args, ctx) => {
      const now = Date.now();
      const lines = [
        `pacing ${[...PROVIDERS].join(", ") || "(no providers)"}: min gap ${MIN_INTERVAL_MS} ms, manual TPM ${
          TPM > 0 ? fmt(TPM) : "off"
        }, headroom ${Math.round(HEADROOM * 100)}%, max_tokens counted ${COUNT_MAX_TOKENS ? "yes" : "no"}`,
      ];
      for (const [model, known] of budgets) {
        if (known.tokens) {
          lines.push(`${model} tokens: ${fmt(projected(known.tokens, now))} of ${fmt(known.tokens.limit)} free now`);
        }
        if (known.requests) {
          lines.push(`${model} requests: ${fmt(projected(known.requests, now))} of ${fmt(known.requests.limit)} free now`);
        }
      }
      if (budgets.size === 0) lines.push("no x-ratelimit headers seen yet");
      if (lastRequest) {
        const drop = lastRequest.drop === undefined ? "unknown" : fmt(lastRequest.drop);
        lines.push(
          `last request: about ${fmt(lastRequest.tokens)} input tokens, max_tokens ${fmt(lastRequest.maxTokens)}, budget fell by ${drop}`,
        );
      }
      lines.push(
        cooldownUntil > now ? `cooldown: ${Math.ceil((cooldownUntil - now) / 1000)}s left` : "cooldown: none",
        `429s seen: ${limitedCount}`,
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
