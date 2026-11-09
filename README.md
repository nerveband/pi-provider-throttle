# pi-provider-throttle

A Pi extension that paces outbound model requests so a provider's rate limit stops turning into failures.

Built for Baseten Model APIs, where a 200k token context and a fast agent loop will exhaust a token-per-minute quota in a few seconds and come back as `429 rate_limit_exceeded`.

## The problem it solves

Pi sends one request per turn and retries transient errors. With a large context, each request is expensive in tokens:

| Measure | Observed in a 281 request session |
|---|---|
| Median prompt size | ≈ 233,000 tokens |
| Largest prompt | ≈ 327,000 tokens |
| Median gap between request starts | ≈ 2.1 s |
| Busiest minute | 27 requests |
| Hard 429 failures | 56 |

At those sizes, a one-per-minute budget is realistic, and a two-second loop is not. The retries also add load at the worst moment.

## What it does

- Enforces a minimum gap between request starts for the chosen providers.
- Keeps a 60 second sliding window of estimated prompt tokens and waits for room before starting.
- On HTTP 429, holds every request until the cooldown expires. It uses `Retry-After` when the provider sends one and otherwise doubles its own backoff, up to a ceiling.
- Stops idle prompt-cache warming for those providers. Warming resends the full context with no new output, so on a 200k token prompt it spends a whole request of quota for nothing.
- Shows `pacing …` and `rate limited: holding …` in the status line while it waits.

It never rewrites your payload. It only decides when the request leaves.

## Install

From git:

```bash
pi install git:github.com/nerveband/pi-provider-throttle
```

As an npm package after you publish one:

```bash
pi install npm:pi-provider-throttle
```

Or copy `src/index.ts` into `~/.pi/agent/extensions/` and run `/reload`.

## Configuration

All settings are environment variables, read when Pi starts.

| Variable | Default | Meaning |
|---|---|---|
| `PI_THROTTLE_PROVIDERS` | `baseten` | Comma separated provider ids to pace. `baseten` matches `models.json`. |
| `PI_THROTTLE_MIN_INTERVAL_MS` | `3000` | Smallest gap between request starts. |
| `PI_THROTTLE_TPM` | `0` | Token budget per minute. `0` disables window pacing. |
| `PI_THROTTLE_BASE_COOLDOWN_MS` | `20000` | First backoff after a 429. |
| `PI_THROTTLE_MAX_COOLDOWN_MS` | `300000` | Backoff ceiling and longest hold. |
| `PI_THROTTLE_MAX_WAIT_MS` | `180000` | Longest single sleep before a request. |

For a 200k token context on a modest quota, start with a real budget:

```bash
export PI_THROTTLE_TPM=1000000     # one request of this size per minute
export PI_THROTTLE_MIN_INTERVAL_MS=15000
```

Tokens are estimated from the serialized payload at about four characters per token. It is a close guess, not the provider's own count, so leave headroom.

## What it cannot fix

Throttling controls when a request leaves, not how much capacity exists. If the account quota is genuinely too small for the work, or a dedicated deployment has no warm replica, requests will still fail. On the Baseten side these help:

- `min_replicas` of at least 1 for interactive traffic, so scale-from-zero does not answer with 429 or 529.
- `target_utilization` below 100 percent, so scaling starts before every slot is full.
- A higher `max_replicas`, or a higher concurrency target, once benchmarks support it.
- Async endpoints for batch work instead of synchronous bursts.

Baseten returns 429 when a rate limit is exceeded or when no replica has room, and 529 when the queue passes its hard limit. A sustained 429 is a capacity or quota signal, not just a pacing signal.

## Verify it is working

```bash
PI_THROTTLE_MIN_INTERVAL_MS=2000 pi -p --model baseten/<your-model> "say ok"
```

The request should start later than it otherwise would, and a 429 should be followed by a wait rather than an immediate retry.

## Design notes

- The throttle lives in `before_provider_request`, which Pi awaits, so a delay there delays the actual send.
- The 429 handling lives in `after_provider_response`, which sees the status and headers before the body is consumed.
- State resets on Pi restart. Nothing is written to disk.
- It only touches providers you name, so other providers keep their normal latency.

## License

MIT
