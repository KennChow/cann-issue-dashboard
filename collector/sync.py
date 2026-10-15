"""python -m collector.sync [--repo cann/ge] [--full]. Repository-atomic ingestion."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import argparse
import copy
import json
import os
from pathlib import Path
from datetime import datetime, timedelta, timezone
from .api import Client, SyncError
from .model import normalize, comments, reply, status, stats, owners, date, user, internal_assignment
from .reports import index_reports
from .history import history, activity
ROOT = Path(__file__).resolve().parents[1]

def read(path, default):
    return json.loads(path.read_text()) if path.exists() else default

def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
    os.replace(temp, path)

def collect_repo(client, repo, old, config, now, full=False, cache_dir=None):
    old_rows = {i['id']: i for i in old.get('issues', [])}
    full = full or not old.get('last_full') or now - date(old['last_full']) >= timedelta(days=config['full_interval_days'])
    params = {'state': 'all', 'sort': 'updated', 'direction': 'asc'}
    if not full and old.get('last_success'):
        params['since'] = (date(old['last_success']) - timedelta(hours=1)).isoformat()
    raw = client.pages(repo + '/issues', **params)
    excluded = {repo + '#' + str(r.get('number')) for r in raw if r.get('visibility_reason') not in (None, 'public')}
    raw = [r for r in raw if repo + '#' + str(r.get('number')) not in excluded]
    changed_ids = {repo + '#' + str(r.get('number')) for r in raw}
    if not full:
        for identity, previous_issue in old_rows.items():
            if not previous_issue.get('comments_complete') and identity not in changed_ids and identity not in excluded:
                detail = client.get(f"{repo}/issues/{previous_issue['number']}")
                if detail.get('visibility_reason') in (None, 'public'):
                    raw.append(detail)
                else:
                    excluded.add(identity)
    for raw_issue in raw:
        normalize(repo, raw_issue)
    rows = {} if full else copy.deepcopy(old_rows)
    for identity in excluded:
        rows.pop(identity, None)
    warnings = []
    assignment_members = set()
    assignment_members_complete = False
    members = set(config['maintainers'].get(repo, []))
    member_complete = repo in config['maintainers_complete']
    try:
        membership = client.pages(repo + '/collaborators')
        assignment_members = {user(m)['login'] for m in membership if user(m)['login']}
        assignment_members_complete = True
        members.update(user(m)['login'] for m in membership if int(m.get('access_level') or 0) >= 15 or m.get('permission') in ('admin', 'write'))
        member_complete = True
    except SyncError as exc:
        warnings.append('成员身份: ' + str(exc))
    bulk_results = {}
    if full and len(raw) > 20:
        try:
            all_comments = client.pages(repo + '/issues/comments', sort='created', direction='asc')
            public_ids = {str(r['id']): str(r['number']) for r in raw}
            grouped = {number: [] for number in public_ids.values()}
            for comment in all_comments:
                target = (comment.get('target') or {}).get('issue') or {}
                target_id = str(target.get('id'))
                if target_id not in public_ids:
                    continue  # Never retain comments belonging to excluded/non-public Issues.
                number = str(target.get('number'))
                if number != public_ids[target_id]:
                    raise SyncError('Bulk comment target identity mismatch')
                grouped[number].append(comment)
            for raw_issue in raw:
                number = str(raw_issue['number'])
                expected = raw_issue.get('comments')
                if expected is None or len(grouped[number]) == int(expected):
                    bulk_results[repo + '#' + number] = comments(grouped[number])
            print(repo, 'bulk comments', len(all_comments), 'validated for', len(bulk_results), 'public issues', flush=True)
        except (SyncError, ValueError, TypeError, KeyError):
            print(repo, 'bulk comments unavailable; falling back to per-issue cache/API', flush=True)
    def fetch_comments(raw_issue):
        identity = repo + '#' + str(raw_issue.get('number'))
        before = old_rows.get(identity)
        if identity in bulk_results:
            return identity, (bulk_results[identity], None)
        if before and before['updated_at'] == raw_issue.get('updated_at') and before.get('comment_count') == raw_issue.get('comments') and before.get('comments_complete') and not full:
            return identity, (before['comments'], None)
        if raw_issue.get('comments') == 0:
            return identity, ([], None)
        cache_file = None
        if cache_dir:
            cache_key = hashlib.sha256((identity + str(raw_issue.get('updated_at')) + str(raw_issue.get('comments'))).encode()).hexdigest()
            cache_file = cache_dir / (cache_key + '.json')
            cached = read(cache_file, {})
            if cached.get('at') and now - date(cached['at']) < timedelta(hours=24):
                return identity, (cached['comments'], None)
        try:
            fetched = comments(client.pages(f"{repo}/issues/{raw_issue['number']}/comments"))
            if cache_file:
                atomic(cache_file, {'at': now.isoformat(), 'comments': fetched})
            return identity, (fetched, None)
        except SyncError as exc:
            return identity, (before['comments'] if before else [], str(exc))
    print(repo, 'fetching comments for', len(raw), 'changed issues', flush=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        comment_results = {}
        for completed, (identity, result) in enumerate(pool.map(fetch_comments, raw), 1):
            comment_results[identity] = result
            if completed % 50 == 0:
                print(repo, 'comments', completed, '/', len(raw), flush=True)
    for raw_issue in raw:
        issue = normalize(repo, raw_issue)
        before = old_rows.get(issue['id'])
        issue['comments'], comment_error = comment_results[issue['id']]
        issue['comments_complete'] = comment_error is None
        if comment_error:
            warnings.append('评论 #' + issue['number'] + ': ' + comment_error)
        events = before.get('events', [])[:] if before else []
        if not before:
            events.append({'at': now.isoformat(), 'kind': '首次观测', 'detail': issue['state']})
        else:
            for key in ('state', 'assignees', 'source_status'):
                if before[key] != issue[key]:
                    events.append({'at': now.isoformat(), 'kind': '观测到 ' + key + ' 变化', 'detail': json.dumps(issue[key], ensure_ascii=False)})
        issue['events'] = events[-100:]
        rows[issue['id']] = issue
    for issue in rows.values():
        issue['internal_assignment'] = internal_assignment(issue, assignment_members, assignment_members_complete)
        issue['reply_status'], issue['first_reply_at'] = reply(issue, members, member_complete, config['bots'])
    return {'issues': list(rows.values()), 'last_success': now.isoformat(), 'last_full': now.isoformat() if full else old['last_full'],
            'excluded_nonpublic': len(excluded), 'warnings': warnings, 'error': None, 'mode': 'full' if full else 'incremental'}

def run(args, client=None):
    client = client or Client()
    config = read(ROOT / 'config/repos.json', {})
    now = datetime.now(timezone.utc)
    dest = ROOT / 'public/data/dashboard.json'
    previous = read(dest, {})
    repositories = copy.deepcopy(previous.get('repositories', {}))
    errors = []
    for repo in config['repos']:
        if args.repo and args.repo != repo:
            continue
        old = repositories.get(repo, {})
        try:
            repositories[repo] = collect_repo(client, repo, old, config, now, args.full, ROOT / ".cache/comments")
            print(repo, repositories[repo]['mode'], len(repositories[repo]['issues']), 'issues', flush=True)
        except (SyncError, ValueError, TypeError, KeyError) as exc:
            message = str(exc) if isinstance(exc, SyncError) else 'Malformed upstream data'
            repositories[repo] = {**old, 'issues': old.get('issues', []), 'error': message}
            errors.append(repo + ': ' + message)
            print(errors[-1], flush=True)
    cache_path = ROOT / '.cache/reports.json'
    cache = read(cache_path, {})
    report_index = previous.get('report_index', {})
    report_success = previous.get('report_success')
    try:
        report_index = index_reports(client, config, cache)
        report_success = now.isoformat()
        if len(cache.get('trees', {})) > 20000:
            cache['trees'] = {}
        atomic(cache_path, cache)
    except (SyncError, ValueError, TypeError, KeyError) as exc:
        errors.append('AI 报告: ' + (str(exc) if isinstance(exc, SyncError) else 'Malformed report metadata'))
    now = datetime.now(timezone.utc)
    issues = []
    for repo, record in repositories.items():
        for issue in record['issues']:
            issue['reports'] = report_index.get(issue['id'], [])
            issue['metrics'] = status(issue, now)
        record['stats'] = stats(record['issues'])
        issues.extend(record['issues'])
    complete = all(repositories.get(r, {}).get('last_success') and not repositories[r].get('error') for r in config['repos'])
    result = {'schema_version': 1, 'generated_at': now.isoformat(),
              'last_success': min(repositories[r]['last_success'] for r in config['repos']) if complete else previous.get('last_success'),
              'complete': complete, 'errors': errors, 'repositories': repositories,
              'stats': stats(issues), 'owners': owners(issues), 'report_index': report_index, 'report_success': report_success,
              'snapshots': history(previous.get('snapshots', []), issues, now, config['snapshot_days'], complete and not args.repo),
              'activity': activity(issues), 'requests': client.requests}
    json.dumps(result, allow_nan=False)
    atomic(dest, result)
    atomic(ROOT / '.cache/last-run.json', {'at': now.isoformat(), 'errors': errors, 'requests': client.requests})
    for cached_file in (ROOT / '.cache/comments').glob('*.json'):
        if datetime.fromtimestamp(cached_file.stat().st_mtime, timezone.utc) < now - timedelta(days=8):
            cached_file.unlink()
    print('Total', len(issues), 'reports', sum(bool(i['reports']) for i in issues), 'requests', client.requests, flush=True)
    return 1 if errors else 0

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', choices=read(ROOT / 'config/repos.json', {})['repos'])
    parser.add_argument('--full', action='store_true')
    raise SystemExit(run(parser.parse_args()))
if __name__ == '__main__':
    main()
