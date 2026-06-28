# Sandbox availability checker

This repository contains a small external health checker for three public
`trycloudflare.com` endpoints. GitHub Actions runs it four times per hour, so
the laptop and the NixOS sandbox do not run the monitoring process.

The checker sends ordinary HTTP `GET` requests. It does not connect to the
terminal WebSocket, authenticate, type commands, or imitate interactive use.
It cannot start a suspended sandbox or recreate a stopped Cloudflare tunnel.

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

## Run locally

Python 3.11 or newer is sufficient. The checker has no third-party runtime
dependencies.

```bash
python -m unittest discover -s tests -v
python -m src.checker --config config/targets.json
```

The live command intentionally waits for a random 0–90 seconds before its
first request. It then checks the targets in random order, with random 2–8
second gaps. Transient failures receive one retry.

Every attempt produces one JSON log line. The final summary exits with:

- `0` when every target is reachable;
- `1` when at least one target remains unavailable;
- `2` when target configuration is invalid.

## Publish and enable GitHub Actions

1. Create a new **public** repository on GitHub. Public visibility is required
   for unlimited free use of standard GitHub-hosted runners.
2. Add the GitHub repository as this checkout's remote and push the default
   branch.
3. Open the repository's **Actions** tab and enable workflows if prompted.
4. Open **Check sandbox availability**, select **Run workflow**, and run it
   once manually.
5. Open the completed run and confirm the three target records and final
   summary appear in **Check live endpoints**.

The workflow runs at minutes 7, 22, 37, and 52 of every UTC hour. GitHub may
delay scheduled jobs during periods of high Actions load.

GitHub automatically disables scheduled workflows in public repositories
after 60 days without repository activity. When that happens, open the
workflow in the Actions tab and select **Enable workflow**. This project does
not create artificial commits to bypass that GitHub policy.

## Logs and failures

Open **Actions** → **Check sandbox availability** to inspect each run. A run is
marked failed only after the checker has attempted all three targets. Expected
network failures are reduced to `timeout`, `network`, or `http`; response
bodies, cookies, and credentials are never logged.

GitHub notification delivery depends on the notification settings of the
repository owner. This version intentionally has no email, Telegram, Discord,
database, artifact, or secret configuration.
