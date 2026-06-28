from __future__ import annotations

import json
import socket
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from urllib import error as urlerror

from src.checker import (
    CheckPolicy,
    Target,
    check_target,
    default_request,
    load_targets,
    run_checks,
)


FIXED_TIME = datetime(2026, 6, 28, 12, 0, tzinfo=timezone.utc)


class PredictableRandom:
    def __init__(self) -> None:
        self.ranges: list[tuple[float, float]] = []

    def uniform(self, low: float, high: float) -> float:
        self.ranges.append((low, high))
        return (low + high) / 2

    def shuffle(self, values: list[object]) -> None:
        values.reverse()


class IncrementingTimer:
    def __init__(self, increment: float = 0.025) -> None:
        self.value = 0.0
        self.increment = increment

    def __call__(self) -> float:
        current = self.value
        self.value += self.increment
        return current


class CheckerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.target = Target("one", "https://one.example.test")
        self.randomizer = PredictableRandom()
        self.sleeps: list[float] = []
        self.logs = []

    def check(self, requester):
        return check_target(
            self.target,
            requester=requester,
            sleeper=self.sleeps.append,
            randomizer=self.randomizer,
            emitter=self.logs.append,
            utc_clock=lambda: FIXED_TIME,
            timer=IncrementingTimer(),
        )

    def test_success_statuses_do_not_retry(self) -> None:
        for status in (200, 204, 301, 399):
            with self.subTest(status=status):
                self.logs.clear()
                result = self.check(lambda _url, _timeout: status)
                self.assertTrue(result.reachable)
                self.assertEqual(status, result.status)
                self.assertEqual(1, result.attempt)
                self.assertIsNone(result.error)

    def test_transient_status_retries_once(self) -> None:
        for transient in (429, 500, 503):
            with self.subTest(status=transient):
                statuses = iter((transient, 200))
                self.sleeps.clear()
                self.logs.clear()
                result = self.check(lambda _url, _timeout: next(statuses))
                self.assertTrue(result.reachable)
                self.assertEqual(2, result.attempt)
                self.assertEqual(1, len(self.sleeps))
                self.assertEqual(2, len(self.logs))

    def test_permanent_client_error_does_not_retry(self) -> None:
        result = self.check(lambda _url, _timeout: 404)
        self.assertFalse(result.reachable)
        self.assertEqual(1, result.attempt)
        self.assertEqual("http", result.error)
        self.assertEqual([], self.sleeps)

    def test_timeout_retries_and_is_sanitized(self) -> None:
        calls = 0

        def timeout(_url: str, _timeout: float) -> int:
            nonlocal calls
            calls += 1
            raise socket.timeout("sensitive upstream details")

        result = self.check(timeout)
        self.assertFalse(result.reachable)
        self.assertEqual(2, calls)
        self.assertEqual("timeout", result.error)
        self.assertNotIn("sensitive", repr(result))

    def test_network_error_retries(self) -> None:
        result = self.check(
            lambda _url, _timeout: (_ for _ in ()).throw(
                urlerror.URLError("private DNS detail")
            )
        )
        self.assertFalse(result.reachable)
        self.assertEqual(2, result.attempt)
        self.assertEqual("network", result.error)

    def test_run_checks_randomizes_order_and_continues_after_failure(self) -> None:
        targets = [
            Target("one", "https://one.example.test"),
            Target("two", "https://two.example.test"),
            Target("three", "https://three.example.test"),
        ]
        requested: list[str] = []

        def requester(url: str, _timeout: float) -> int:
            requested.append(url)
            return 404 if "two" in url else 200

        results = run_checks(
            targets,
            requester=requester,
            sleeper=self.sleeps.append,
            randomizer=self.randomizer,
            emitter=self.logs.append,
            utc_clock=lambda: FIXED_TIME,
            timer=IncrementingTimer(),
        )

        self.assertEqual(
            [
                "https://three.example.test",
                "https://two.example.test",
                "https://one.example.test",
            ],
            requested,
        )
        self.assertEqual(3, len(results))
        self.assertEqual(2, sum(result.reachable for result in results))
        self.assertEqual((0.0, 90.0), self.randomizer.ranges[0])
        self.assertEqual(
            [(2.0, 8.0), (2.0, 8.0)],
            self.randomizer.ranges[1:],
        )

    def test_default_request_never_reads_response_body(self) -> None:
        class FakeResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, *_args):
                raise AssertionError("response body must not be read")

        with patch("src.checker.urlrequest.urlopen", return_value=FakeResponse()) as call:
            self.assertEqual(200, default_request(self.target.url, 15.0))
            request = call.call_args.args[0]
            self.assertEqual("GET", request.method)
            self.assertEqual(15.0, call.call_args.kwargs["timeout"])


class ConfigurationTests(unittest.TestCase):
    def write_config(self, value) -> Path:
        temporary = tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", suffix=".json", delete=False
        )
        with temporary:
            json.dump(value, temporary)
        self.addCleanup(Path(temporary.name).unlink, missing_ok=True)
        return Path(temporary.name)

    def test_loads_valid_targets(self) -> None:
        path = self.write_config(
            [{"name": "terminal", "url": "https://terminal.example.test/path"}]
        )
        self.assertEqual(
            [Target("terminal", "https://terminal.example.test/path")],
            load_targets(path),
        )

    def test_rejects_invalid_target_configurations(self) -> None:
        invalid_values = [
            [],
            {},
            [{"name": "", "url": "https://valid.example.test"}],
            [{"name": "terminal", "url": "http://insecure.example.test"}],
            [{"name": "terminal", "url": "not-a-url"}],
            [
                {"name": "one", "url": "https://duplicate.example.test"},
                {"name": "two", "url": "https://duplicate.example.test"},
            ],
            [
                {"name": "duplicate", "url": "https://one.example.test"},
                {"name": "duplicate", "url": "https://two.example.test"},
            ],
            [
                {
                    "name": "terminal",
                    "url": "https://user:secret@terminal.example.test",
                }
            ],
        ]
        for value in invalid_values:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    load_targets(self.write_config(value))

    def test_rejects_malformed_json(self) -> None:
        temporary = tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", suffix=".json", delete=False
        )
        with temporary:
            temporary.write("{")
        path = Path(temporary.name)
        self.addCleanup(path.unlink, missing_ok=True)
        with self.assertRaisesRegex(ValueError, "not valid JSON"):
            load_targets(path)


if __name__ == "__main__":
    unittest.main()
