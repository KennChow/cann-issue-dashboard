from datetime import timedelta, timezone
from .model import date, stats
SHANGHAI = timezone(timedelta(hours=8))

def history(previous, issues, now, days=365, complete=True):
    cutoff = (now.astimezone(SHANGHAI) - timedelta(days=days-1)).date().isoformat()
    snapshots = {s['date']: s for s in previous if s['date'] >= cutoff}
    if complete:
        today = now.astimezone(SHANGHAI).date().isoformat()
        snapshots[today] = {'date': today, 'at': now.isoformat(), **stats(issues)}
    return sorted(snapshots.values(), key=lambda s: s['date'])

def activity(issues):
    buckets = {}
    for issue in issues:
        for field, key in [('created_at', 'created'), ('closed_at', 'closed')]:
            if issue.get(field) and (key != 'closed' or issue['state'] == 'closed'):
                day = date(issue[field]).astimezone(SHANGHAI).date().isoformat()
                buckets.setdefault(day, {'date': day, 'created': 0, 'closed': 0})[key] += 1
    return sorted(buckets.values(), key=lambda s: s['date'])
