from datetime import datetime, timezone
from .api import SyncError

UTC = timezone.utc

def date(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(UTC)
    except (AttributeError, ValueError, TypeError):
        raise SyncError('Missing or timezone-less timestamp') from None

def user(value):
    if isinstance(value, str):
        return {'login': value, 'avatar': ''}
    if not isinstance(value, dict):
        return {'login': '', 'avatar': ''}
    avatar = value.get('avatar_url') or ''
    return {'login': value.get('login') or value.get('username') or '', 'avatar': avatar if avatar.startswith('https://') else ''}

def normalize(repo, row):
    confidential = row.get('visibility_reason') not in (None, 'public')
    if not row.get('number') or not row.get('title'):
        raise SyncError('Issue missing number/title')
    state = row.get('state')
    if state not in ('open', 'opened', 'closed', 'rejected', 'progressing'):
        raise SyncError('Unknown upstream issue state')
    for key in ('created_at', 'updated_at'):
        date(row.get(key))
    closed = row.get('finished_at') or row.get('closed_at') or None
    if closed:
        date(closed)
    assignees = row.get('assignees') or ([row['assignee']] if row.get('assignee') else [])
    if not isinstance(assignees, list):
        raise SyncError('Invalid assignees')
    people = {u['login']: u for u in map(user, assignees) if u['login']}
    number = str(row['number'])
    title = f'[保密 Issue #{number}]' if confidential else row['title']
    body = '' if confidential else (row.get('body') or '')
    result = dict(id=repo + '#' + number, repo=repo, number=number, title=title,
                  body=body, author=user(row.get('user') or row.get('author')),
                  assignees=list(people.values()), state='closed' if state in ('closed', 'rejected') else 'open',
                  created_at=row['created_at'], updated_at=row['updated_at'], closed_at=closed,
                  url=f'https://gitcode.com/{repo}/issues/{number}',
                  labels=[x.get('name', '') if isinstance(x, dict) else str(x) for x in row.get('labels') or []],
                  source_status=row.get('issue_state') or '', priority=(row.get('issue_priority_detail') or {}).get('title', ''),
                  comment_count=row.get('comments'), comments=[], comments_complete=False, reports=[])
    if confidential:
        result['confidential'] = True
    return result

def comments(rows, confidential=False):
    result = []
    for row in rows:
        at = row.get('created_at')
        date(at)
        raw_body = row.get('body') or ''
        if confidential:
            stripped = raw_body.strip()
            body = '' if not stripped else ('/command' if stripped.startswith('/') else '[保密评论]')
        else:
            body = raw_body
        result.append({'id': str(row['id']), 'body': body, 'author': user(row.get('user')),
                       'created_at': at, 'system': bool(row.get('system', False))})
    return sorted(result, key=lambda c: (date(c['created_at']), c['id']))

def reply(issue, members, members_complete, bots):
    valid = [c for c in issue['comments'] if not c['system'] and c['body'].strip()
             and not c['body'].lstrip().startswith('/')
             and c['author']['login'] != issue['author']['login']
             and c['author']['login'] not in bots and date(c['created_at']) >= date(issue['created_at'])]
    replies = [c for c in valid if c['author']['login'] in members]
    if replies:
        return 'replied', replies[0]['created_at']
    if issue['comments_complete'] and (members_complete or not valid):
        return 'unreplied', None
    return 'unknown', None

def internal_assignment(issue, members, complete):
    """Internal means repository collaborator, not company employment."""
    if not issue['assignees']:
        return 'missing'
    names = {name.casefold() for name in members}
    if any(a['login'].casefold() in names for a in issue['assignees']):
        return 'assigned'
    return 'missing' if complete else 'unknown'


def status(issue, now):
    age = max(0, (now - date(issue['created_at'])).total_seconds() / 3600)
    opened = issue['state'] == 'open'
    return dict(age_hours=round(age, 3), overdue_hours=round(max(0, age - 336), 3),
                remaining_hours=round(336 - age, 3), unassigned=opened and not issue['assignees'],
                no_internal_assignee=opened and issue.get('internal_assignment') == 'missing',
                unreplied=opened and issue['reply_status'] == 'unreplied',
                overdue=opened and age > 336, due_soon=opened and 264 < age <= 336,
                has_report=bool(issue['reports']))

def stats(issues):
    result = {k: sum(bool(i['metrics'][k]) for i in issues) for k in ('unassigned', 'no_internal_assignee', 'unreplied', 'overdue', 'due_soon', 'has_report')}
    result.update(open=sum(i['state'] == 'open' for i in issues), closed=sum(i['state'] == 'closed' for i in issues))
    result['unknown'] = sum(i['state'] == 'open' and i['reply_status'] == 'unknown' for i in issues)
    result['closure_rate'] = round(result['closed'] / len(issues) * 100, 2) if issues else None
    result['normal'] = sum(i['state'] == 'open' and not i['metrics']['overdue'] and not i['metrics']['due_soon'] for i in issues)
    return result

def workload_owner(issue):
    people = issue['assignees']
    return next((p for p in people if p.get('membership') == 'internal'),
                people[0] if people else {'login': '未分配', 'avatar': '', 'membership': 'unassigned'})

def owners(issues):
    groups = {}
    for issue in issues:
        if issue['state'] != 'open':
            continue
        person = workload_owner(issue)
        role = person.get('membership', 'unknown')
        group = groups.setdefault(person['login'], {'person': person, 'issues': [], 'repos': {}, 'repo_roles': {}})
        group['issues'].append(issue)
        group['repos'][issue['repo']] = group['repos'].get(issue['repo'], 0) + 1
        group['repo_roles'][issue['repo']] = role
    result = []
    for group in groups.values():
        roles = set(group['repo_roles'].values())
        role = next(iter(roles)) if len(roles) == 1 else 'mixed'
        result.append({**group, 'role': role, 'stats': stats(group['issues']), 'issues': [i['id'] for i in group['issues']]})
    return result
