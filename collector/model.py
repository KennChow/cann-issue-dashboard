import re
from datetime import datetime, timezone
from .api import SyncError

UTC = timezone.utc
DEFAULT_BOTS = {'cann-robot', 'gitcode-bot', 'openeuler-ci-bot', 'ascend-robot', 'atomgit-bot'}
ISSUE_URL_RE = re.compile(r'https?://gitcode\.com/(cann/[A-Za-z0-9_-]+)/issues/(\d+)', re.I)
REPO_ISSUE_RE = re.compile(r'\b(cann/[A-Za-z0-9_-]+)#(\d+)\b', re.I)
KEYWORD_ISSUE_RE = re.compile(r'(?:issues?|fix(?:es|ed)?|close[sd]?|resolve[sd]?|关联\s*issue|问题单)[:\s#：]+#?(\d+)\b', re.I)
BARE_HASH_RE = re.compile(r'(?<![A-Za-z0-9_])#(\d+)\b')

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

def extract_linked_issues(repo, title='', body='', api_issues=None, known_issue_ids=None):
    found = set()
    for item in api_issues or []:
        if isinstance(item, str):
            val = item.strip().lstrip('#')
            if '#' in val:
                found.add(val)
            elif val:
                found.add(f'{repo}#{val}')
        elif isinstance(item, dict):
            url_match = ISSUE_URL_RE.search(item.get('html_url') or item.get('url') or '')
            if url_match:
                found.add(f'{url_match.group(1)}#{url_match.group(2)}')
                continue
            num = str(item.get('number') or item.get('iid') or '').strip().lstrip('#')
            irepo = (item.get('repository') or {}).get('full_name') or repo
            if num:
                found.add(f'{irepo}#{num}')
    text = f'{title or ""}\n{body or ""}'
    for m in ISSUE_URL_RE.finditer(text):
        found.add(f'{m.group(1)}#{m.group(2)}')
    for m in REPO_ISSUE_RE.finditer(text):
        cand = f'{m.group(1)}#{m.group(2)}'
        if not known_issue_ids or cand in known_issue_ids:
            found.add(cand)
    for m in KEYWORD_ISSUE_RE.finditer(text):
        cand = f'{repo}#{m.group(1)}'
        if not known_issue_ids or cand in known_issue_ids:
            found.add(cand)
    if known_issue_ids:
        for m in BARE_HASH_RE.finditer(text):
            cand = f'{repo}#{m.group(1)}'
            if cand in known_issue_ids:
                found.add(cand)
    return sorted(found, key=lambda s: (s.split('#')[0], int(s.split('#')[1]) if s.split('#')[1].isdigit() else 0, s))

def normalize_pr(repo, row):
    confidential = row.get('visibility_reason') not in (None, 'public')
    if not row.get('number') or not row.get('title'):
        raise SyncError('PR missing number/title')
    raw_state = row.get('state')
    if raw_state not in ('open', 'opened', 'closed', 'merged'):
        raise SyncError('Unknown upstream PR state')
    state = 'open' if raw_state in ('open', 'opened') else raw_state
    for key in ('created_at', 'updated_at'):
        date(row.get(key))
    merged = row.get('merged_at') or None
    if merged:
        date(merged)
    closed = row.get('closed_at') or merged or None
    if closed:
        date(closed)
    if state == 'merged' and not merged:
        merged = closed or row['updated_at']
    assignees = row.get('assignees') or ([row['assignee']] if row.get('assignee') else [])
    testers = row.get('testers') or []
    if not isinstance(assignees, list) or not isinstance(testers, list):
        raise SyncError('Invalid PR assignees/testers')
    assignee_people = {u['login']: u for u in map(user, assignees) if u['login']}
    tester_people = {u['login']: u for u in map(user, testers) if u['login']}
    raw_labels = row.get('labels') or []
    label_names = []
    ci_passed_at = row.get('ci_passed_at') or None
    lgtm_times = []
    for lbl in raw_labels:
        if isinstance(lbl, dict):
            name = lbl.get('name') or ''
            if name:
                label_names.append(name)
            lname = name.lower()
            if lname == 'ci-pipeline-passed':
                ts = lbl.get('updated_at') or lbl.get('created_at')
                if ts:
                    try:
                        date(ts)
                        ci_passed_at = ts
                    except SyncError:
                        pass
            elif lname in ('lgtm', 'approved'):
                ts = lbl.get('updated_at') or lbl.get('created_at')
                if ts:
                    try:
                        date(ts)
                        lgtm_times.append(ts)
                    except SyncError:
                        pass
        elif lbl:
            label_names.append(str(lbl))
    lower_labels = {l.lower() for l in label_names}
    lgtm_ts = min(lgtm_times) if lgtm_times else None
    if 'ci-pipeline-passed' in lower_labels:
        ci_status = 'passed'
        if not ci_passed_at:
            ci_passed_at = row['created_at']
        elif (lgtm_ts and date(lgtm_ts) < date(ci_passed_at)) or (
            merged
            and (date(ci_passed_at) - date(row['created_at'])).total_seconds() > 48 * 3600
            and (date(merged) - date(ci_passed_at)).total_seconds() < 4 * 3600
        ):
            ci_passed_at = row['created_at']
    elif 'ci-pipeline-failed' in lower_labels:
        ci_status = 'failed'
    elif 'ci-pipeline-running' in lower_labels:
        ci_status = 'running'
    else:
        ci_status = row.get('ci_status') if row.get('ci_status') in ('passed', 'failed', 'running', 'not_executed') else 'not_executed'
    number = str(row['number'])
    title = f'[保密 PR #{number}]' if confidential else row['title']
    body = '' if confidential else (row.get('body') or '')
    head_sha = ((row.get('head') or {}).get('sha')
                or (row.get('diff_refs') or {}).get('head_sha')
                or row.get('head_sha') or '')
    target_branch = row.get('target_branch') or (row.get('base') or {}).get('ref') or ''
    source_branch = row.get('source_branch') or (row.get('head') or {}).get('ref') or ''
    comment_count = row.get('notes') if row.get('notes') is not None else row.get('comments')
    result = dict(
        id=repo + '!' + number,
        repo=repo,
        number=number,
        title=title,
        body=body,
        author=user(row.get('user') or row.get('author')),
        assignees=list(assignee_people.values()),
        testers=list(tester_people.values()),
        state=state,
        draft=bool(row.get('draft', False)),
        mergeable=True if row.get('mergeable') is None else bool(row.get('mergeable')),
        ci_status=ci_status,
        ci_passed_at=ci_passed_at,
        head_sha=head_sha,
        target_branch=target_branch,
        source_branch=source_branch,
        added_lines=int(row.get('added_lines') or 0),
        removed_lines=int(row.get('removed_lines') or 0),
        created_at=row['created_at'],
        updated_at=row['updated_at'],
        closed_at=closed,
        merged_at=merged,
        first_reply_at=lgtm_ts,
        url=f'https://gitcode.com/{repo}/merge_requests/{number}',
        labels=label_names,
        comment_count=comment_count,
        comments=[],
        files=[],
        linked_issues=[],
        details_complete=False,
    )
    if confidential:
        result['confidential'] = True
    return result

def pr_comments(rows, confidential=False, bots=()):
    bot_names = DEFAULT_BOTS | {b.casefold() for b in bots}
    result = []
    for row in rows:
        at = row.get('created_at')
        date(at)
        updated = row.get('updated_at') or at
        date(updated)
        author = user(row.get('user') or row.get('author'))
        raw_body = row.get('body') or ''
        if confidential:
            stripped = raw_body.strip()
            body = '' if not stripped else ('/command' if stripped.startswith('/') else '[保密评论]')
        else:
            login_cf = author['login'].casefold()
            is_bot = login_cf in bot_names or login_cf.endswith('[bot]') or login_cf.endswith('-bot')
            if is_bot and len(raw_body) > 200 and not raw_body.lstrip().startswith('/'):
                body = raw_body[:200] + '...'
            else:
                body = raw_body
        entry = {
            'id': str(row['id']),
            'body': body,
            'author': author,
            'created_at': at,
            'updated_at': updated,
            'comment_type': row.get('comment_type') or 'pr_comment',
            'system': bool(row.get('system', False)),
        }
        if isinstance(row.get('resolved'), bool):
            entry['resolved'] = row['resolved']
        result.append(entry)
    return sorted(result, key=lambda c: (date(c['created_at']), c['id']))

def pr_reply(pr, bots=()):
    bot_names = DEFAULT_BOTS | {b.casefold() for b in bots}
    author_cf = (pr.get('author') or {}).get('login', '').casefold()
    created_dt = date(pr['created_at'])
    valid = []
    for c in pr.get('comments') or []:
        if c.get('system'):
            continue
        body = (c.get('body') or '').strip()
        if not body:
            continue
        login_cf = (c.get('author') or {}).get('login', '').casefold()
        if not login_cf or login_cf == author_cf:
            continue
        if login_cf in bot_names or login_cf.endswith('[bot]') or login_cf.endswith('-bot'):
            continue
        if date(c['created_at']) >= created_dt:
            valid.append(c)
    if valid:
        ci_dt = date(pr['ci_passed_at']) if pr.get('ci_passed_at') else created_dt
        after_ci = [c for c in valid if date(c['created_at']) >= ci_dt]
        if after_ci:
            return 'replied', after_ci[0]['created_at']
        if pr.get('state') == 'merged':
            return 'replied', valid[0]['created_at']
    if pr.get('author_role') == 'internal' and pr.get('first_reply_at'):
        return 'replied', pr['first_reply_at']
    if pr.get('details_complete'):
        return 'unreplied', None
    return 'unknown', None

def pr_status(pr, now):
    age = max(0, (now - date(pr['created_at'])).total_seconds() / 3600)
    opened = pr['state'] == 'open'
    ready = opened and not pr.get('draft') and bool(pr.get('mergeable', True)) and pr.get('ci_status') == 'passed'
    blocked = opened and not ready
    unreplied = ready and pr.get('reply_status') == 'unreplied'
    return dict(
        age_hours=round(age, 3),
        ready=ready,
        blocked=blocked,
        unreplied=unreplied,
        has_linked_issue=bool(pr.get('linked_issues')),
    )

def pr_stats(prs):
    total = len(prs)
    opened = sum(p['state'] == 'open' for p in prs)
    merged = sum(p['state'] == 'merged' for p in prs)
    closed = sum(p['state'] == 'closed' for p in prs)
    closed_loop = merged + closed
    ready = sum(bool(p['metrics']['ready']) for p in prs)
    blocked = sum(bool(p['metrics']['blocked']) for p in prs)
    unreplied = sum(bool(p['metrics']['unreplied']) for p in prs)
    has_linked_issue = sum(bool(p['metrics']['has_linked_issue']) for p in prs)
    closure_rate = round(closed_loop / total * 100, 2) if total else None
    return dict(
        total=total,
        open=opened,
        merged=merged,
        closed=closed,
        closed_loop=closed_loop,
        ready=ready,
        blocked=blocked,
        unreplied=unreplied,
        has_linked_issue=has_linked_issue,
        closure_rate=closure_rate,
    )

