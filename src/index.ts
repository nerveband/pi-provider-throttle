/**
 * Paces outbound provider requests so token-per-minute limits are not overrun.
 *
 * Written for Baseten Model APIs, which answer with
 * 429 {"code":"rate_limit_exceeded"} once RPM/TPM is exceeded.
 * Large contexts (200k+ tokens) mean only a few requests per minute fit,
 * while an agent turn loop can try one every couple of seconds.
 *
 * What it does per request:
 *  - enforces a minimum gap between request starts
 *  - keeps a 60s sliding window of estimated tokens and waits for room
 *  - after a 429, holds every request until the cooldown expires
 *    (Retry-After when present, otherwise a doubling backoff)
 *  - stops idle prompt-cache warming, which would resend the full context
 *    for no new output
 *
 * Configure with environment variables:
 *  PI_THROTTLE_PROVIDERS        comma list, default "baseten"
 *  PI_THROTTLE_MIN_INTERVAL_MS  minimum gap, default 3000
 *  PI_THROTTLE_TPM              token budget per minute, default 0 (off)
 *  PI_THROTTLE_BASE_COOLDOWN_MS first 429 backoff, default 20000
 *  PI_THROTTLE_MAX_COOLDOWN_MS  backoff ceiling, default 300000
 *  PI_THROTTLE_MAX_WAIT_MS      longest single sleep, default 180000
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const PROVIDERS = new Set(
  (process.env.PI_THROTTLE_PROVIDERS ?? "baseten")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const MIN_INTERVAL_MS = envNumber("PI_THROTTLE_MIN_INTERVAL_MS", 3000);
const TPM = envNumber("PI_THROTTLE_TPM", 0);
const BASE_COOLDOWN_MS = envNumber("PI_THROTTLE_BASE_COOLDOWN_MS", 20000);
const MAX_COOLDOWN_MS = envNumber("PI_THROTTLE_MAX_COOLDOWN_MS", 300000);
const MAX_WAIT_MS = envNumber("PI_THROTTLE_MAX_WAIT_MS", 180000);
const WINDOW_MS = 60_000;

let lastStartAt = 0;
let cooldownUntil = 0;
let cooldownStep = 0;
let window: { at: number; tokens: number }[] = [];
let limitedCount = 0;

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
  return Math.min(wait, MAX_WAIT_MS);
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

function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.["retry-after"];
  if (!raw) return undefined;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function showStatus(ctx: ExtensionContext, text: string | undefined): void {
  try {
    ctx.ui.setStatus("provider-throttle", text);
  } catch {
    // Status is cosmetic; never let it break a request.
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", async (event, ctx) => {
    if (!isTarget(ctx)) return;
    const tokens = estimateTokens(event.payload);
    const wait = waitMsFor(tokens);
    if (wait > 0) {
      showStatus(ctx, `pacing ${Math.ceil(wait / 1000)}s`);
      await sleep(wait, ctx.signal);
      showStatus(ctx, undefined);
    }
    lastStartAt = Date.now();
    window.push({ at: lastStartAt, tokens });
    prune(lastStartAt);
  });

  pi.on("after_provider_response", async (event, ctx) => {
    if (!isTarget(ctx)) return;
    if (event.status === 429) {
      limitedCount += 1;
      cooldownStep += 1;
      const backoff = Math.min(BASE_COOLDOWN_MS * 2 ** (cooldownStep - 1), MAX_COOLDOWN_MS);
      const hold = retryAfterMs(event.headers) ?? backoff;
      cooldownUntil = Math.max(cooldownUntil, Date.now() + Math.min(hold, MAX_COOLDOWN_MS));
      showStatus(ctx, `rate limited: holding ${Math.ceil((cooldownUntil - Date.now()) / 1000)}s`);
      ctx.ui.notify?.(
        `Provider rate limited (${limitedCount} total). Pausing requests for ${Math.ceil(
          (cooldownUntil - Date.now()) / 1000,
        )}s.`,
        "warning",
      );
    } else if (event.status >= 200 && event.status < 300) {
      if (cooldownStep > 0) cooldownStep = 0;
    }
  });

  // Idle warming resends the whole context, which on a 200k-token prompt is a
  // full request worth of quota spent with nothing to show for it.
  pi.on("cache_warming_decision", async (_event, ctx) => {
    if (!isTarget(ctx)) return;
    return { action: "stop" };
  });
}
