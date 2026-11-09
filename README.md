# pi-provider-throttle

A Pi plugin that slows down requests to your model provider so you stop getting `429` rate limit errors.

## The problem

Pi sends one request each turn. It retries when a request fails.

Some providers limit how many tokens you can send each minute. If your context is large, one request can use a huge part of that limit.

Here is what one long session looked like:

| What we measured | Value |
|---|---|
| Normal request size | about 233,000 tokens |
| Largest request | about 327,000 tokens |
| Normal gap between requests | about 2 seconds |
| Most requests in one minute | 27 |
| Requests that failed with `429` | 56 |

So Pi was sending very large requests very fast. The provider said no, over and over.

## What it does

- It waits a minimum time between requests.
- It counts the tokens it sent in the last minute. It waits if the next request would go over your limit.
- When a `429` comes back, it stops sending for a while. It uses the wait time the provider asks for. If the provider gives none, it doubles its own wait time.
- It turns off idle cache warming. That feature resends your whole context for no new answer, which wastes your limit.
- It shows `pacing …` or `rate limited: holding …` while it waits.

It never changes your request. It only decides when the request leaves.

## Install

Use one command:

```bash
pi install git:github.com/nerveband/pi-provider-throttle
```

Then start Pi, or run `/reload` in a running session.

To install from a copy on your disk instead:

```bash
cp src/index.ts ~/.pi/agent/extensions/
```

Do not do both. Two copies means two waits on every request.

## Set your limit

All settings are environment variables. Set them before you start Pi.

| Variable | Default | What it means |
|---|---|---|
| `PI_THROTTLE_PROVIDERS` | `baseten` | Which providers to slow down. Use commas for more than one. |
| `PI_THROTTLE_MIN_INTERVAL_MS` | `3000` | Shortest time between two requests, in milliseconds. |
| `PI_THROTTLE_TPM` | `0` | Tokens allowed each minute. `0` turns this check off. |
| `PI_THROTTLE_BASE_COOLDOWN_MS` | `20000` | First wait after a `429`, in milliseconds. |
| `PI_THROTTLE_MAX_COOLDOWN_MS` | `300000` | Longest wait, in milliseconds. |
| `PI_THROTTLE_MAX_WAIT_MS` | `180000` | Longest single pause before a request, in milliseconds. |

A good start for large contexts:

```bash
export PI_THROTTLE_TPM=1000000
export PI_THROTTLE_MIN_INTERVAL_MS=15000
```

That allows about one 200,000 token request each minute.

The plugin guesses token counts at four characters per token. It is close, not exact. Leave some room under your real limit.

## Check that it works

Run one small request:

```bash
PI_THROTTLE_MIN_INTERVAL_MS=5000 pi -p --model baseten/<your-model> "say ok"
```

You should see the request start later than usual. Then send a few requests in a row. Each one should wait its turn.

## If you still get `429` errors

The plugin controls when a request leaves. It cannot add capacity to your account.

If errors continue, the limit itself is too small for your work. On Baseten you can:

- Set `min_replicas` to at least 1 for live traffic. A sleeping model answers with `429` or `529`.
- Set `target_utilization` below 100 percent. Then scaling starts before every slot is full.
- Raise `max_replicas` after you test what one copy can handle.
- Use async endpoints for batch jobs instead of bursts.

Baseten sends `429` when you pass a rate limit or when no copy has room. It sends `529` when its queue is full. A steady stream of `429` means you need more capacity, not just slower sending.

## For agents

If you are an agent installing this for someone, do these steps in order:

1. Run `pi list` and check that `git:github.com/nerveband/pi-provider-throttle` is not already there.
2. Run `pi install git:github.com/nerveband/pi-provider-throttle`.
3. Run `ls ~/.pi/agent/extensions/provider-throttle.ts`. If that file exists, move it away so the plugin does not load twice.
4. Read the provider limit from the user or their provider dashboard.
5. Set `PI_THROTTLE_TPM` to that number in the user's shell profile.
6. Run the check command above and report the result.

Do not edit `settings.json` to point at a tag or commit. An unpinned git install is what lets `pi update --extensions` move to new versions.

## Updates

Update by hand whenever you want:

```bash
pi update --extensions
```

That pulls the newest version from GitHub. Your settings stay as they are.

If you want this to happen on its own, install the optional daily job:

```bash
scripts/install-auto-update-macos.sh
```

It runs `pi update --extensions` once a day and writes to `~/Library/Logs/pi-extension-update.log`. Turn it off with `scripts/uninstall-auto-update-macos.sh`.

Keep the install unpinned, meaning no tag and no commit hash in the source. A pinned install never moves to a newer version.

## How it works

- It checks before each request, then waits if needed. Pi waits with it, so the request really is delayed.
- It reads the `429` status and its headers after the provider answers.
- It keeps everything in memory. It writes nothing to disk and forgets all state when Pi restarts.
- It only touches providers you list. Other providers keep their normal speed.

## License

MIT
