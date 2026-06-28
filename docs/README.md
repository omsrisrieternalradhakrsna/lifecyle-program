# Sandbox availability and terminal traffic

This repository contains a small external health checker for three public
`trycloudflare.com` endpoints plus a lightweight ttyd traffic runner. GitHub
Actions runs both after cron-job.org dispatches the workflow four times per
hour, so the laptop and the NixOS sandbox do not run the monitoring process.

The checker sends ordinary HTTP `GET` requests. It does not connect to the
terminal WebSocket, authenticate, type commands, or imitate interactive use.
That behavior belongs to the separate traffic runner. Neither component can
start a suspended sandbox or recreate a stopped Cloudflare tunnel.

## Targets

Targets are defined in `config/targets.json`. Each entry needs a unique name
and an absolute HTTPS URL:

```json
{
  "name": "example",
  "url": "https://example.trycloudflare.com"
}
```

Quick Tunnel hostnames are temporary. If `cloudflared` restarts and produces a
new hostname, update the matching URL and push the change to GitHub.

## Terminal traffic

`src/traffic_runner.mjs` opens one independent ttyd WebSocket session per
target. It uses ttyd's `/token` and `/ws` endpoints directly, so it does not
need Chromium or other browser automation. Each WebSocket handshake sends the
endpoint's matching `Origin` header, as a normal browser does; this is required
by ttyd instances that enforce origin checks.

Each session:

- starts at a different randomized time;
- types one character every 200–800 milliseconds;
- chooses from a fixed allowlist of lightweight commands;
- avoids recently used commands;
- occasionally types and corrects a nearby-key typo;
- occasionally submits a harmless invalid option or nonexistent path;
- uses normal 4–20 second pauses and occasional 30–90 second gaps; and
- reconnects independently with capped exponential backoff.

The allowlist contains `pwd`, `whoami`, `date`, bounded `ls` and `ps`
variants, `cd` among `/`, `/tmp`, and the home directory, fixed `echo`
messages, and reads of `/etc/os-release` or `/proc/uptime`. It does not use
redirection, recursive traversal, downloads, package managers, compilation,
or arbitrary discovered filenames.

Terminal output, tokens, cookies, and response bodies are never written to
logs. Logs contain connection state, safe command identifiers, timing,
reconnect information, byte counts, and final summaries.

## Run locally

The checker requires Python 3.11 or newer. The traffic runner requires Node.js
22 or newer and the small `ws` WebSocket client dependency.

```bash
python -m unittest discover -s tests -v
npm ci
npm test
python -m src.checker --config config/targets.json
node src/traffic_runner.mjs --config config/targets.json --dry-run
```

The live command intentionally waits for a random 0–90 seconds before its
first request. It then checks the targets in random order, with random 2–8
second gaps. Transient failures receive one retry.

Every attempt produces one JSON log line. The final summary exits with:

- `0` when every target is reachable;
- `1` when at least one target remains unavailable;
- `2` when target configuration is invalid.

Run a bounded live traffic session with:

```bash
node src/traffic_runner.mjs \
  --config config/targets.json \
  --duration-seconds 240 \
  --log-level debug
```

`--duration-seconds 0` runs until `SIGINT` or `SIGTERM`; use that mode only on
an authorized, dedicated always-on host. A target is considered successful if
it establishes at least one ttyd connection during the run. Temporary
failures are retried while the other targets continue.

## Publish and enable automation

1. Create a new **public** repository on GitHub. Public visibility is required
   for unlimited free use of standard GitHub-hosted runners.
2. Add the GitHub repository as this checkout's remote and push the default
   branch.
3. Open the repository's **Actions** tab and enable workflows if prompted.
4. Open **Check sandbox availability**, select **Run workflow**, and run it
   once manually.
5. Open the completed run and confirm the three target records and final
   summary appear in **Check live endpoints**.

Native GitHub `schedule` events are intentionally not used because GitHub did
not reliably emit them for this repository. cron-job.org job `7937273`
dispatches `.github/workflows/keepalive.yml` at minutes 7, 22, 37, and 52 of
every hour in the `Asia/Kolkata` timezone. Each external dispatch requests a
four-minute traffic session. A manually dispatched run defaults to a
30-second smoke test and accepts a custom `duration_seconds` input.

The cron-job.org request stores no response bodies. Its GitHub credential must
be a dedicated fine-grained token restricted to this repository with only
`Actions: write` permission. Rotate that token before its configured
expiration and update the cron-job.org request header at the same time.

GitHub-hosted runners have finite job limits and are governed by GitHub's
[Actions terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features).
The externally dispatched workflow provides bounded, best-effort interactive
availability checks, not uninterrupted 24/7 WebSocket sessions. For strict
continuous operation, run the same CLI with `--duration-seconds 0` under a
service manager on infrastructure authorized for that purpose.

## Logs and failures

Open **Actions** → **Check sandbox availability** to inspect each run. A run is
marked failed after the checker and traffic runner have had an opportunity to
attempt all three targets. A failed HTTP check does not prevent the terminal
runner from trying to reconnect. Expected checker network failures are reduced
to `timeout`, `network`, or `http`; response bodies, terminal output, cookies,
tokens, and credentials are never logged.

GitHub notification delivery depends on the notification settings of the
repository owner. This version intentionally has no email, Telegram, Discord,
database, artifact, or secret configuration.
