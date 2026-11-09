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

On Baseten Model APIs every model has two limits: requests per minute and tokens per minute. Input tokens (cached or not) and output tokens all count. For one fast DeepSeek model, this account reported 120 requests and about 2.1 million tokens each minute. Twenty-seven requests is far under 120, but 27 requests of 233,000 tokens is over 6 million tokens. The token limit is the one that bites.

## What it does

- It waits a minimum time between requests.
- It sends one request at a time. After a pause, the waiting requests leave in a line, not all at once.
- It reads the `x-ratelimit-*` headers on every Baseten response. They say your real limit and how much is left. It works out how fast the budget refills and waits until the next request fits. You do not have to know your limit or type it in.
- Those headers show the budget shared by every Pi session and every machine that uses the same key. A counter inside one Pi process cannot see that.
- It can also keep its own count of the tokens it sent in the last minute (`PI_THROTTLE_TPM`). That works before the first response arrives, and when a provider sends no headers.
- When a `429` comes back, it stops sending for a while. It uses the wait time the provider asks for. If the provider gives none, it doubles its own wait time.
- It turns off cache warming for these providers. Warming resends your whole context for no new answer, and cached tokens count toward the limit too.
- It shows `pacing …` or `rate limited: holding …` while it waits. Type `/throttle` to see what it knows.

It never changes your request. It only decides when the request leaves.

## Install

Use one command:

```bash
pi install git:github.com/nerveband/pi-provider-throttle
```

Then start Pi, or run `/reload` in a running session.

To install from a copy on your disk instead:

```bash
cp src/index.ts ~/.pi/agent/extensions/provider-throttle.ts
```

Do not do both. Two copies means duplicate waits and duplicate warnings.

## Settings

You do not need any setting for Baseten. These exist for tuning.

All settings are environment variables. Set them before you start Pi.

| Variable | Default | What it means |
|---|---|---|
| `PI_THROTTLE_PROVIDERS` | `baseten` | Which providers to slow down. Use commas for more than one. |
| `PI_THROTTLE_MIN_INTERVAL_MS` | `3000` | Shortest time between two requests, in milliseconds. |
| `PI_THROTTLE_TPM` | `0` | A manual token cap for each minute. `0` turns it off. The headers already set this for you, so use it only as an extra limit. |
| `PI_THROTTLE_HEADROOM` | `0.1` | Share of the reported token limit to keep free. It covers output tokens and the error in the token guess. |
| `PI_THROTTLE_COUNT_MAX_TOKENS` | off | Set to `1` to count each request's `max_tokens` as spent up front. See below. |
| `PI_THROTTLE_BASE_COOLDOWN_MS` | `20000` | First wait after a `429`, in milliseconds. |
| `PI_THROTTLE_MAX_COOLDOWN_MS` | `300000` | Longest wait, in milliseconds. |
| `PI_THROTTLE_MAX_WAIT_MS` | `180000` | Longest single sleep, in milliseconds. A longer pause is waited out in several sleeps. |

Environment variables only reach Pi if you start it from a shell that has them. To make settings stick for every launch, write a config file instead:

```bash
mkdir -p ~/.pi/agent
printf '%s\n' '{"minIntervalMs": 5000, "headroom": 0.15}' > ~/.pi/agent/provider-throttle.json
```

The file takes `providers`, `minIntervalMs`, `tpm`, `headroom`, `countMaxTokens`, `baseCooldownMs`, `maxCooldownMs` and `maxWaitMs`. Environment variables win over the file.

If you want a hard cap on top of the headers, set `PI_THROTTLE_TPM`. One million tokens each minute holds about five 200,000 token requests. A 15 second gap holds it nearer four.

The plugin guesses token counts at four characters per token. It is close, not exact. The headers correct the guess after each response, and the headroom covers the rest.

### Does Baseten hold back `max_tokens` up front?

Pi asks for a large `max_tokens` on some models, for example 384,000. If the provider charged all of that against your budget when the request starts, each request would cost far more than its prompt.

The Baseten docs say output tokens count toward the limit. They do not say whether the full `max_tokens` is held back at the start. By default this plugin assumes it is not.

To check, send one prompt, then run `/throttle`. Look at the `budget fell by` number on the `last request` line:

- About the size of the prompt: the output is not held back. Leave the setting off.
- About the prompt plus `max_tokens`: set `PI_THROTTLE_COUNT_MAX_TOKENS=1`. Or lower `maxTokens` for that model in `~/.pi/agent/models.json`.

Other sessions that use the same key change the number, so check when nothing else is running.

## Check that it works

Pacing is easiest to see inside one interactive session, because each new `pi -p` process starts with an empty timer.

```bash
pi
```

Send two or three prompts, then run `/throttle`. You should see:

- the limits Baseten reported, for example `tokens: 1,950,000 of 2,097,154 free now`
- the last request size and how far the budget fell
- the cooldown and how many `429` errors it has seen

If a limit is close, the next prompt shows `pacing …` before it runs. If you hit one, you should see `rate limited: holding …` and the next prompt waits instead of failing.

## If you still get `429` errors

The plugin controls when a request leaves. It cannot add capacity to your account.

For Baseten Model APIs, which is what the `baseten` provider in Pi calls:

- Check the limits for your exact model slug. Fast variants have their own slugs and their own limits. Ask the management API: `GET https://api.baseten.co/v1/model_apis/<slug>`, with the slug URL-encoded (`/` becomes `%2F`), or read them from the Baseten dashboard.
- Your account tier sets the default. Check your own numbers rather than a table, because tiers change.
- Ask for more with the [rate limit increase form](https://www.baseten.co/talk-to-us/increase-rate-limits). Say the model and how many requests and tokens you need each minute.
- `529` is different. It means Baseten has no serving capacity at that moment. It can happen while you are inside your limits.

If you run your own dedicated Baseten deployment instead, these apply:

- Set `min_replicas` to at least 1 for live traffic. A sleeping model answers with `429` or `529`.
- Set `target_utilization` below 100 percent. Then scaling starts before every slot is full.
- Raise `max_replicas` after you test what one copy can handle.
- Use async endpoints for batch jobs instead of bursts.

A steady stream of `429` means you need more capacity, not just slower sending.

## For agents

If you are an agent installing this for someone, do these steps in order:

1. Run `pi list` and check that `git:github.com/nerveband/pi-provider-throttle` is not already there.
2. Run `pi install git:github.com/nerveband/pi-provider-throttle`.
3. Run `ls ~/.pi/agent/extensions/provider-throttle.ts`. If that file exists, move it away so the plugin does not load twice.
4. Do not ask for the provider limit. The plugin reads it from the response headers.
5. Start `pi`, send two prompts, run `/throttle`, and report what it shows.
6. If the `budget fell by` number is near the prompt size plus `max_tokens`, set `PI_THROTTLE_COUNT_MAX_TOKENS=1` in `~/.pi/agent/provider-throttle.json` as `"countMaxTokens": true`.

Do not edit `settings.json` to point at a tag or commit. An unpinned git install is what lets `pi update --extensions` move to new versions.

## Updates

Update by hand whenever you want:

```bash
pi update --extensions
```

That pulls the newest version from GitHub. Your settings stay as they are.

If you want this to happen on its own, install the optional daily job:

```bash
~/.pi/agent/git/github.com/nerveband/pi-provider-throttle/scripts/install-auto-update-macos.sh
```

Run it from a logged-in desktop session. launchd cannot load a user job from a headless shell. The script writes absolute paths for node and Pi, because launchd does not read your shell profile.

It updates this package only, once a day, and writes to `~/Library/Logs/pi-extension-update.log`. It does not touch your other packages. Turn it off with `scripts/uninstall-auto-update-macos.sh`.

Keep the install unpinned, meaning no tag and no commit hash in the source. A pinned install never moves to a newer version.

## How it works

- It checks before each request, then waits if needed. Pi waits with it, so the request really is delayed.
- Baseten reports `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens` and the same two for requests. Baseten says budgets refill continuously, not at a fixed minute mark, so the plugin assumes an even refill of the whole limit each minute. Each new response corrects that picture.
- The headers arrive before the answer is finished, so the cost of that request may not be charged yet. The plugin counts that request, and any started after it, as still to be charged. This keeps it on the safe side. It costs one request of spare room, not speed.
- Budgets are kept for each model, because limits belong to a model slug.
- It looks for a `429` in two places: the HTTP response when the provider exposes it, and the request error that Baseten raises through the openai-completions path. Headers only arrive on the first path, so the second path uses doubling backoff. A failed request does not count against the local token window.
- It keeps everything in memory. It writes nothing except its optional config file, and it forgets all state when Pi restarts or reloads.
- It only touches providers you list. Other providers keep their normal speed.
- Each Pi session keeps its own timers, so several Pi sessions in one process, or on several machines, share Baseten's budget only through the headers.

## License

MIT
