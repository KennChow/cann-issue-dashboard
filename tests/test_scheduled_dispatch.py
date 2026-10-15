from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from datetime import datetime, timezone

from scripts.dispatch_scheduled import (
    DispatchUncertain, due_slot, load_schedule, parse_schedule, tick, upcoming,
)


def utc(value):
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)


class ScheduleTests(unittest.TestCase):
    def test_matches_business_hours_in_beijing(self):
        schedule = load_schedule()
        times = upcoming(schedule, utc("2026-10-15T00:00:00"), count=12)
        self.assertEqual([slot.hour + 8 for slot in times], [9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21])
        self.assertEqual({slot.minute for slot in times}, {13})

    def test_before_slot_and_limited_catch_up(self):
        schedule = load_schedule()
        self.assertIsNone(due_slot(schedule, utc("2026-10-15T01:12:59")))
        self.assertEqual(due_slot(schedule, utc("2026-10-15T01:13:00")), utc("2026-10-15T01:13:00"))
        self.assertIsNotNone(due_slot(schedule, utc("2026-10-15T01:22:59")))
        self.assertIsNone(due_slot(schedule, utc("2026-10-15T01:23:01")))

    def test_sunday_excluded_and_saturday_included(self):
        schedule = load_schedule()
        self.assertIsNotNone(due_slot(schedule, utc("2026-10-17T13:13:00")))
        self.assertIsNone(due_slot(schedule, utc("2026-10-18T01:13:00")))
        self.assertEqual(upcoming(schedule, utc("2026-10-17T13:13:01"))[0], utc("2026-10-19T01:13:00"))

    def test_ranges_and_lists_have_identical_meaning(self):
        source = 'on:\n  schedule:\n    - cron: "13 1-4,6-13 * * 1-6"\n  workflow_dispatch:\n'
        self.assertEqual(parse_schedule(source)["hours"], load_schedule()["hours"])

    def test_schedule_changes_are_not_silently_misinterpreted(self):
        for source in [
            'on:\n  schedule:\n    - cron: "13 1 * * *"\n      timezone: Asia/Shanghai\n',
            'on:\n  schedule:\n    - cron: "13 1 1 * *"\n',
            'on:\n  schedule:\n    - cron: "13 1 * * *"\n    - cron: "14 1 * * *"\n',
            'on:\n  schedule:\n    - cron: "70 1 * * *"\n',
        ]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                parse_schedule(source)


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state = Path(self.directory.name) / "state.json"
        self.client = Mock()
        self.client.recent_run.return_value = None
        self.client.dispatch.return_value = {}
        self.now = utc("2026-10-15T01:13:01")

    def test_repeated_checks_and_restart_only_dispatch_once(self):
        self.assertEqual(tick(self.client, self.state, self.now), "accepted")
        self.assertEqual(tick(self.client, self.state, self.now), "accepted")
        self.client.dispatch.assert_called_once_with()
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)

    def test_online_run_prevents_duplicate_dispatch(self):
        self.client.recent_run.return_value = {"html_url": "https://github.com/run/1"}
        self.assertEqual(tick(self.client, self.state, self.now), "existing")
        self.client.dispatch.assert_not_called()

    def test_network_failure_before_post_can_retry(self):
        self.client.verify.side_effect = [RuntimeError("network unavailable"), None]
        with self.assertRaises(RuntimeError):
            tick(self.client, self.state, self.now)
        self.assertEqual(tick(self.client, self.state, self.now), "accepted")
        self.client.dispatch.assert_called_once()

    def test_lost_post_response_does_not_send_duplicate_mail(self):
        self.client.dispatch.side_effect = DispatchUncertain("response lost")
        with self.assertRaises(DispatchUncertain):
            tick(self.client, self.state, self.now)
        self.assertEqual(tick(self.client, self.state, self.now), "uncertain")
        self.client.dispatch.assert_called_once()

    def test_rejected_post_can_retry(self):
        self.client.dispatch.side_effect = [RuntimeError("HTTP 429"), {}]
        with self.assertRaises(RuntimeError):
            tick(self.client, self.state, self.now)
        self.assertEqual(tick(self.client, self.state, self.now), "accepted")

    def test_crash_after_persisting_attempt_does_not_post_again(self):
        self.client.dispatch.side_effect = KeyboardInterrupt
        with self.assertRaises(KeyboardInterrupt):
            tick(self.client, self.state, self.now)
        self.assertEqual(tick(self.client, self.state, self.now), "uncertain")
        self.client.dispatch.assert_called_once()

    def test_off_schedule_never_contacts_github(self):
        self.assertEqual(tick(self.client, self.state, utc("2026-10-15T14:13:00")), "idle")
        self.client.verify.assert_not_called()
        self.client.dispatch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
