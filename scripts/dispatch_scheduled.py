"""Trigger the dashboard workflow on its UTC schedule from an external server."""

import argparse
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import socket
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = "sync-deploy.yml"
REPOSITORY = "KennChow/cann-issue-dashboard"
UTC = timezone.utc
BEIJING = timezone(timedelta(hours=8))
WINDOW = timedelta(minutes=10)


def log(message):
    print(f"{datetime.now(UTC).isoformat()} {message}", flush=True)


def field_values(field, minimum, maximum):
    values = set()
    for part in field.split(","):
        if part == "*":
            values.update(range(minimum, maximum + 1))
        elif re.fullmatch(r"\d+-\d+", part):
            first, last = map(int, part.split("-"))
            if first > last:
                raise ValueError("Descending cron range")
            values.update(range(first, last + 1))
        elif part.isdigit():
            values.add(int(part))
        else:
            raise ValueError(f"Unsupported cron field: {field}")
    if not values or min(values) < minimum or max(values) > maximum:
        raise ValueError("Cron field outside its allowed range")
    return values


def parse_schedule(text):
    """Read this project's single UTC schedule; fail if its format changes."""
    block = []
    inside = False
    for line in text.splitlines():
        if line == "  schedule:":
            inside = True
            continue
        if inside:
            if line.strip() and len(line) - len(line.lstrip()) <= 2:
                break
            block.append(line)
    content = "\n".join(block)
    matches = re.findall(r"^\s*- cron:\s*(['\"])(.*?)\1\s*(?:#.*)?$", content, re.M)
    if len(matches) != 1 or re.search(r"\btimezone\s*:", content):
        raise ValueError("Expected exactly one UTC cron in the dashboard workflow")
    cron = matches[0][1]
    fields = cron.split()
    if len(fields) != 5 or fields[2:4] != ["*", "*"]:
        raise ValueError("Only daily/weekly schedules are supported")
    return {
        "cron": cron,
        "minutes": field_values(fields[0], 0, 59),
        "hours": field_values(fields[1], 0, 23),
        "weekdays": field_values(fields[4], 0, 6),
    }


def load_schedule():
    return parse_schedule((ROOT / ".github/workflows" / WORKFLOW).read_text())


def slots(schedule, now, days_before=0, days_after=0):
    now = now.astimezone(UTC)
    result = []
    for offset in range(-days_before, days_after + 1):
        day = (now + timedelta(days=offset)).date()
        if (day.weekday() + 1) % 7 not in schedule["weekdays"]:
            continue
        for hour in schedule["hours"]:
            for minute in schedule["minutes"]:
                result.append(datetime(day.year, day.month, day.day, hour, minute, tzinfo=UTC))
    return sorted(result)


def due_slot(schedule, now):
    now = now.astimezone(UTC)
    previous = [slot for slot in slots(schedule, now, days_before=7) if slot <= now]
    if previous and now - previous[-1] <= WINDOW:
        return previous[-1]
    return None


def upcoming(schedule, now, count=3):
    return [slot for slot in slots(schedule, now, days_after=8) if slot > now][:count]


class DispatchUncertain(RuntimeError):
    """A POST may have reached GitHub; do not automatically submit it twice."""


class GitHub:
    def __init__(self, token_path):
        token_path = Path(token_path)
        if token_path.stat().st_mode & 0o077:
            raise ValueError("GitHub credential file must have mode 600")
        self.token = token_path.read_text().strip()
        if not self.token:
            raise ValueError("GitHub credential file is empty")

    def request(self, path, body=None):
        method = "GET" if body is None else "POST"
        request = Request(
            "https://api.github.com" + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={
                "Authorization": "Bearer " + self.token,
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "User-Agent": "cann-issue-dashboard-server-scheduler",
                "Cache-Control": "no-cache",
            },
            method=method,
        )
        try:
            with urlopen(request, timeout=20) as response:
                content = response.read()
                return json.loads(content) if content else {}
        except HTTPError as error:
            if method == "POST" and error.code >= 500:
                raise DispatchUncertain(f"GitHub dispatch returned HTTP {error.code}") from None
            raise RuntimeError(f"GitHub {method} returned HTTP {error.code}") from None
        except (URLError, TimeoutError, socket.timeout, OSError):
            if method == "POST":
                raise DispatchUncertain("GitHub dispatch response was not received") from None
            raise RuntimeError("GitHub request failed; check server network access") from None

    def verify(self, schedule):
        workflow = self.request(f"/repos/{REPOSITORY}/actions/workflows/{WORKFLOW}")
        if workflow.get("state") != "active":
            raise RuntimeError("Online dashboard workflow is not active")
        source = self.request(f"/repos/{REPOSITORY}/contents/.github/workflows/{WORKFLOW}?ref=main")
        remote = parse_schedule(base64.b64decode(source["content"]).decode())
        if remote["cron"] != schedule["cron"]:
            raise RuntimeError("Local/online cron differ; update the server checkout before dispatching")

    def recent_run(self, slot, now):
        query = urlencode({
            "branch": "main", "per_page": 100,
            "created": slot.strftime("%Y-%m-%dT%H:%M:%SZ") + ".." + now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        })
        data = self.request(f"/repos/{REPOSITORY}/actions/workflows/{WORKFLOW}/runs?{query}")
        for run in data.get("workflow_runs", []):
            created = datetime.fromisoformat(run["created_at"].replace("Z", "+00:00"))
            if run.get("head_branch") == "main" and slot <= created <= now:
                return run
        return None

    def dispatch(self, workflow=WORKFLOW):
        return self.request(f"/repos/{REPOSITORY}/actions/workflows/{workflow}/dispatches", {"ref": "main"})


def save_state(path, state):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def tick(client, state_path, now=None):
    now = now or datetime.now(UTC)
    schedule = load_schedule()
    slot = due_slot(schedule, now)
    if slot is None:
        return "idle"
    state_path = Path(state_path)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    # The lock covers both the remote check and dispatch, including separate --once processes.
    with state_path.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        key = slot.isoformat()
        if key in state:
            return state[key]["status"]
        client.verify(schedule)
        run = client.recent_run(slot, now)
        if run:
            state[key] = {"status": "existing", "url": run["html_url"]}
            log(f"slot={key} already has a run: {run['html_url']}")
        else:
            # Persist before POST: a crash or lost HTTP response must not send another report.
            state[key] = {"status": "uncertain", "attempted_at": now.isoformat()}
            save_state(state_path, state)
            try:
                result = client.dispatch()
            except DispatchUncertain:
                log(f"slot={key} dispatch outcome unknown; inspect Actions before retrying manually")
                raise
            except RuntimeError:
                del state[key]
                save_state(state_path, state)
                raise
            state[key] = {"status": "accepted", "accepted_at": now.isoformat()}
            if result.get("html_url"):
                state[key]["url"] = result["html_url"]
            log(f"slot={key} GitHub accepted workflow_dispatch")
        # Retain roughly two weeks of observations without unbounded growth.
        state = dict(sorted(state.items())[-200:])
        save_state(state_path, state)
        return state[key]["status"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--serve", action="store_true", help="Continuously check scheduled slots")
    mode.add_argument("--once", action="store_true", help="Check the current scheduled slot once")
    mode.add_argument("--check", action="store_true", help="Validate credentials and compare online cron")
    mode.add_argument("--preview", action="store_true", help="Show the schedule without API requests")
    mode.add_argument("--probe", action="store_true", help="Dispatch only the diagnostic probe workflow")
    parser.add_argument("--token-file", type=Path, default=Path.home() / ".config/cann-issue-dashboard/github-token")
    parser.add_argument("--state-file", type=Path, default=ROOT / ".cache/scheduled-dispatch.json")
    args = parser.parse_args()
    schedule = load_schedule()
    log(f"repository={REPOSITORY} cron_utc={schedule['cron']}")
    log("next_beijing=" + ", ".join(slot.astimezone(BEIJING).isoformat() for slot in upcoming(schedule, datetime.now(UTC))))
    if args.preview:
        return 0
    client = GitHub(args.token_file)
    if args.check or args.probe:
        client.verify(schedule)
        identity = client.request("/user")
        log(f"GitHub access verified for {identity['login']}; local/online schedules match")
        if args.probe:
            client.dispatch("schedule-probe.yml")
            log("GitHub accepted diagnostic probe workflow_dispatch")
        return 0
    if args.once:
        log("result=" + tick(client, args.state_file))
        return 0
    log("scheduler started; checking every 15 seconds; catch-up window=10 minutes")
    while True:
        try:
            tick(client, args.state_file)
        except (OSError, ValueError, RuntimeError) as error:
            log(f"ERROR {error}")
        time.sleep(15)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError) as error:
        log(f"ERROR {error}")
        sys.exit(1)
