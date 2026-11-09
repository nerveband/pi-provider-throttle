/**
 * Paces outbound provider requests so token-per-minute limits are not overrun.
 *
 * Written for Baseten Model APIs, which answer with
 * 429 {"code":"rate_limit_exceeded"} once RPM/TPM is exceeded.
 * Large contexts (200k+ tokens) mean only a few requests per minute fit,
 * while an agent turn loop can try one every couple of seconds.
 *
 * What it does per request:
 *  - sends one request at a time, with a minimum gap between starts
 *  - keeps a 60s sliding window of estimated tokens and waits for room
 *  - after a 429, holds every request until the cooldown expires
 *    (Retry-After when sent, otherwise a doubling backoff)
 *  - stops prompt-cache warming for the paced providers
 *
 * Configure with environment variables or a JSON file:
 *  PI_THROTTLE_CONFIG           config path, default ~/.pi/agent/provider-throttle.json
 *  PI_THROTTLE_PROVIDERS        comma list, default "baseten"
 *  PI_THROTTLE_MIN_INTERVAL_MS  minimum gap, default 3000
 *  PI_THROTTLE_TPM              token budget per minute, default 0 (off)
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

const PROVIDERS = new Set(
  (process.env.PI_THROTTLE_PROVIDERS ?? file.providers?.join(",") ?? "baseten")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const MIN_INTERVAL_MS = envNumber("PI_THROTTLE_MIN_INTERVAL_MS", file.minIntervalMs ?? 3000);
const TPM = envNumber("PI_THROTTLE_TPM", file.tpm ?? 0);
const BASE_COOLDOWN_MS = envNumber("PI_THROTTLE_BASE_COOLDOWN_MS", file.baseCooldownMs ?? 20000);
const MAX_COOLDOWN_MS = envNumber("PI_THROTTLE_MAX_COOLDOWN_MS", file.maxCooldownMs ?? 300000);
const MAX_WAIT_MS = Math.max(envNumber("PI_THROTTLE_MAX_WAIT_MS", file.maxWaitMs ?? 180000), 1000);
const WINDOW_MS = 60_000;
const RATE_LIMIT_ERROR = /(?:^|\D)429(?:\D|$)|rate.?limit|too many requests/i;

let lastStartAt = 0;
let cooldownUntil = 0;
let cooldownStep = 0;
let window: { at: number; tokens: number }[] = [];
let limitedCount = 0;

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
function estimateTokens(payload: unknown): number {
  try {
    return Math.ceil(JSON.stringify(payload).length / 4);
  } catch {
    return 0;
  }
}

function prune(now: number): void {
  window = window.filter((entry) => now - entry.at < WINDOW_MS);
}

function waitMsFor(tokens: number): number {
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
  return wait;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
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

function showStatus(ctx: ExtensionContext, text: string | undefined): void {
  try {
    ctx.ui.setStatus("provider-throttle", text);
  } catch {
    // Status is cosmetic; never let it break a request.
  }
}

function applyCooldown(ctx: ExtensionContext, requested: number | undefined): void {
  limitedCount += 1;
  cooldownStep += 1;
  const backoff = Math.min(BASE_COOLDOWN_MS * 2 ** (cooldownStep - 1), MAX_COOLDOWN_MS);
  const hold = Math.min(requested ?? backoff, MAX_COOLDOWN_MS);
  cooldownUntil = Math.max(cooldownUntil, Date.now() + hold);
  const seconds = Math.ceil((cooldownUntil - Date.now()) / 1000);
  showStatus(ctx, `rate limited: holding ${seconds}s`);
  try {
    ctx.ui.notify?.(`Provider rate limited (${limitedCount} total). Pausing requests for ${seconds}s.`, "warning");
  } catch {
    // Notification is cosmetic.
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", async (event, ctx) => {
    if (!isTarget(ctx)) return;
    const tokens = estimateTokens(event.payload);
    await serialize(async () => {
      // Re-check after every wake. A cooldown longer than the single-sleep cap
      // therefore still holds the request until it expires.
      for (;;) {
        const wait = waitMsFor(tokens);
        if (wait <= 0) break;
        showStatus(ctx, `pacing ${Math.ceil(wait / 1000)}s`);
        await sleep(Math.min(wait, MAX_WAIT_MS), ctx.signal);
        if (ctx.signal?.aborted) {
          showStatus(ctx, undefined);
          return;
        }
      }
      showStatus(ctx, undefined);
      lastStartAt = Date.now();
      window.push({ at: lastStartAt, tokens });
      prune(lastStartAt);
    });
  });

  // Works for APIs that surface the HTTP response before the body is checked.
  pi.on("after_provider_response", async (event, ctx) => {
    if (!isTarget(ctx)) return;
    if (event.status === 429) {
      applyCooldown(ctx, retryAfterMs(event.headers));
    } else if (event.status >= 200 && event.status < 300) {
      cooldownStep = 0;
    }
  });

  // Baseten uses the openai-completions API, where Pi raises the 429 as a request
  // error and never calls after_provider_response. Catch it here instead; there are
  // no headers on this path, so the cooldown falls back to exponential backoff.
  pi.on("message_end", async (event, ctx) => {
    if (!isTarget(ctx)) return;
    const message = event.message;
    if (!message || message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (!RATE_LIMIT_ERROR.test(message.errorMessage ?? "")) return;
    applyCooldown(ctx, undefined);
  });

  // Warming resends the whole context, which on a 200k-token prompt is a full
  // request worth of quota spent with nothing to show for it.
  pi.on("cache_warming_decision", async (_event, ctx) => {
    if (!isTarget(ctx)) return;
    return { action: "stop" };
  });
}
