"""Check public endpoints from a scheduled GitHub Actions workflow."""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from collections.abc import Callable, MutableSequence, Sequence
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from random import SystemRandom
from typing import Any, Protocol
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import urlsplit

USER_AGENT = "lifecycle-availability-checker/1.0"
DEFAULT_CONFIG = Path("config/targets.json")
SUCCESS_STATUS_RANGE = range(200, 400)
RETRYABLE_STATUSES = {429}


@dataclass(frozen=True)
class Target:
    """A named HTTPS endpoint."""

    name: str
    url: str


@dataclass(frozen=True)
class CheckResult:
    """The structured result of one request attempt."""

    name: str
    url: str
    checked_at: str
    attempt: int
    reachable: bool
    status: int | None
    duration_ms: int
    error: str | None


@dataclass(frozen=True)
class CheckPolicy:
    """Timing and retry limits for a checker run."""

    timeout_seconds: float = 15.0
    initial_delay_seconds: tuple[float, float] = (0.0, 90.0)
    between_targets_seconds: tuple[float, float] = (2.0, 8.0)
    retry_delay_seconds: tuple[float, float] = (3.0, 8.0)
    max_attempts: int = 2


class Randomizer(Protocol):
    """Subset of random.SystemRandom used by the checker."""

    def uniform(self, low: float, high: float) -> float: ...

    def shuffle(self, values: MutableSequence[Any]) -> None: ...


Requester = Callable[[str, float], int]
Sleeper = Callable[[float], None]
Emitter = Callable[[CheckResult], None]
UtcClock = Callable[[], datetime]
Timer = Callable[[], float]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _isoformat_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_target(raw: object, index: int) -> Target:
    if not isinstance(raw, dict):
        raise ValueError(f"target {index} must be an object")

    name = raw.get("name")
    url = raw.get("url")
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"target {index} must have a non-empty string name")
    if not isinstance(url, str) or not url.strip():
        raise ValueError(f"target {index} must have a non-empty string URL")

    parsed = urlsplit(url)
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        raise ValueError(f"target {index} URL must be an absolute HTTPS URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"target {index} URL must not contain credentials")

    return Target(name=name.strip(), url=url.strip())


def load_targets(path: Path) -> list[Target]:
    """Load and validate targets from a JSON file."""

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"target configuration not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"target configuration is not valid JSON: {path}") from exc

    if not isinstance(raw, list) or not raw:
        raise ValueError("target configuration must be a non-empty JSON array")

    targets = [_validate_target(item, index) for index, item in enumerate(raw, start=1)]
    names = [target.name for target in targets]
    urls = [target.url for target in targets]
    if len(names) != len(set(names)):
        raise ValueError("target names must be unique")
    if len(urls) != len(set(urls)):
        raise ValueError("target URLs must be unique")
    return targets


def default_request(url: str, timeout_seconds: float) -> int:
    """Open an endpoint and return its status without reading its body."""

    request = urlrequest.Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml",
            "User-Agent": USER_AGENT,
        },
        method="GET",
    )
    try:
        with urlrequest.urlopen(request, timeout=timeout_seconds) as response:
            return int(response.status)
    except urlerror.HTTPError as exc:
        try:
            return int(exc.code)
        finally:
            exc.close()


def emit_json(result: CheckResult) -> None:
    """Write one compact JSON record without response data or credentials."""

    print(json.dumps(asdict(result), sort_keys=True), flush=True)


def _classify_network_error(exc: BaseException) -> str:
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return "timeout"
    if isinstance(exc, urlerror.URLError) and isinstance(
        exc.reason, (TimeoutError, socket.timeout)
    ):
        return "timeout"
    return "network"


def _is_retryable_status(status: int) -> bool:
    return status in RETRYABLE_STATUSES or status >= 500


def check_target(
    target: Target,
    *,
    requester: Requester = default_request,
    sleeper: Sleeper = time.sleep,
    randomizer: Randomizer | None = None,
    emitter: Emitter = emit_json,
    utc_clock: UtcClock = _utc_now,
    timer: Timer = time.monotonic,
    policy: CheckPolicy = CheckPolicy(),
) -> CheckResult:
    """Check one target, retrying transient failures once by default."""

    rng = randomizer or SystemRandom()
    last_result: CheckResult | None = None

    for attempt in range(1, policy.max_attempts + 1):
        checked_at = _isoformat_utc(utc_clock())
        started = timer()
        status: int | None = None
        error: str | None = None

        try:
            status = requester(target.url, policy.timeout_seconds)
        except (TimeoutError, socket.timeout, urlerror.URLError, OSError) as exc:
            error = _classify_network_error(exc)

        duration_ms = max(0, round((timer() - started) * 1000))
        reachable = status in SUCCESS_STATUS_RANGE if status is not None else False
        if status is not None and not reachable:
            error = "http"

        last_result = CheckResult(
            name=target.name,
            url=target.url,
            checked_at=checked_at,
            attempt=attempt,
            reachable=reachable,
            status=status,
            duration_ms=duration_ms,
            error=error,
        )
        emitter(last_result)

        retryable = status is None or (
            status is not None and _is_retryable_status(status)
        )
        if reachable or not retryable or attempt == policy.max_attempts:
            return last_result

        sleeper(rng.uniform(*policy.retry_delay_seconds))

    if last_result is None:  # Defensive guard for an invalid custom policy.
        raise ValueError("max_attempts must be at least 1")
    return last_result


def run_checks(
    targets: Sequence[Target],
    *,
    requester: Requester = default_request,
    sleeper: Sleeper = time.sleep,
    randomizer: Randomizer | None = None,
    emitter: Emitter = emit_json,
    utc_clock: UtcClock = _utc_now,
    timer: Timer = time.monotonic,
    policy: CheckPolicy = CheckPolicy(),
) -> list[CheckResult]:
    """Check every target in randomized order and return final results."""

    if not targets:
        raise ValueError("at least one target is required")

    rng = randomizer or SystemRandom()
    ordered_targets = list(targets)
    rng.shuffle(ordered_targets)
    sleeper(rng.uniform(*policy.initial_delay_seconds))

    results: list[CheckResult] = []
    for index, target in enumerate(ordered_targets):
        results.append(
            check_target(
                target,
                requester=requester,
                sleeper=sleeper,
                randomizer=rng,
                emitter=emitter,
                utc_clock=utc_clock,
                timer=timer,
                policy=policy,
            )
        )
        if index < len(ordered_targets) - 1:
            sleeper(rng.uniform(*policy.between_targets_seconds))
    return results


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Check configured HTTPS endpoints in randomized order."
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG,
        help=f"target JSON file (default: {DEFAULT_CONFIG})",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        targets = load_targets(args.config)
        results = run_checks(targets)
    except ValueError as exc:
        print(json.dumps({"error": "configuration", "detail": str(exc)}), file=sys.stderr)
        return 2

    available = sum(result.reachable for result in results)
    summary = {
        "event": "summary",
        "checked": len(results),
        "reachable": available,
        "unavailable": len(results) - available,
    }
    print(json.dumps(summary, sort_keys=True), flush=True)
    return 0 if available == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
