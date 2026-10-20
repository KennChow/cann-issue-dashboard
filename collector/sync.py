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
from .model import (
    normalize, comments, reply, status, stats, owners, date, user,
    internal_assignment, workload_owner, DEFAULT_BOTS,
    extract_linked_issues, normalize_pr, pr_comments, pr_reply, pr_status, pr_stats,
)
from .reports import index_reports
from .history import history, activity
from .membership import collect_directory, apply_directory
ROOT = Path(__file__).resolve().parents[1]

def read(path, default):
    return json.loads(path.read_text()) if path.exists() else default

def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
    os.replace(temp, path)

def collect_repo(client, repo, old, config, now, full=False, cache_dir=None, membership_source=None):
    old_rows = {i['id']: i for i in old.get('issues', [])}
    full = full or not old.get('last_full') or now - date(old['last_full']) >= timedelta(days=config['full_interval_days'])
    params = {'state': 'all', 'sort': 'updated', 'direction': 'asc'}
    if not full and old.get('last_success'):
        params['since'] = (date(old['last_success']) - timedelta(hours=1)).isoformat()
    raw = client.pages(repo + '/issues', **params)
    changed_ids = {repo + '#' + str(r.get('number')) for r in raw}
    if not full:
        for identity, previous_issue in old_rows.items():
            if not previous_issue.get('comments_complete') and identity not in changed_ids:
                detail = client.get(f"{repo}/issues/{previous_issue['number']}")
                raw.append(detail)
    for raw_issue in raw:
        normalize(repo, raw_issue)
    rows = {} if full else copy.deepcopy(old_rows)
    warnings = []
    assignment_members = set()
    assignment_members_complete = False
    members = set(config['maintainers'].get(repo, []))
    member_complete = repo in config['maintainers_complete']
    try:
        if membership_source is not None and membership_source['error']:
            raise SyncError(membership_source['error'])
        membership = membership_source['members'] if membership_source is not None else client.pages(repo + '/collaborators')
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
            known_ids = {str(r['id']): str(r['number']) for r in raw}
            grouped = {number: [] for number in known_ids.values()}
            for comment in all_comments:
                target = (comment.get('target') or {}).get('issue') or {}
                target_id = str(target.get('id'))
                if target_id not in known_ids:
                    continue
                number = str(target.get('number'))
                if number != known_ids[target_id]:
                    raise SyncError('Bulk comment target identity mismatch')
                grouped[number].append(comment)
            for raw_issue in raw:
                number = str(raw_issue['number'])
                expected = raw_issue.get('comments')
                is_conf = raw_issue.get('visibility_reason') not in (None, 'public')
                if expected is None or len(grouped[number]) == int(expected):
                    bulk_results[repo + '#' + number] = comments(grouped[number], confidential=is_conf)
            print(repo, 'bulk comments', len(all_comments), 'validated for', len(bulk_results), 'issues', flush=True)
        except (SyncError, ValueError, TypeError, KeyError):
            print(repo, 'bulk comments unavailable; falling back to per-issue cache/API', flush=True)
    def fetch_comments(raw_issue):
        identity = repo + '#' + str(raw_issue.get('number'))
        before = old_rows.get(identity)
        is_conf = raw_issue.get('visibility_reason') not in (None, 'public')
        if identity in bulk_results:
            return identity, (bulk_results[identity], None)
        if before and before['updated_at'] == raw_issue.get('updated_at') and before.get('comment_count') == raw_issue.get('comments') and before.get('comments_complete') and not full:
            return identity, (before['comments'], None)
        if raw_issue.get('comments') == 0:
            return identity, ([], None)
        cache_file = None
        if cache_dir:
            cache_key = hashlib.sha256((identity + str(raw_issue.get('updated_at')) + str(raw_issue.get('comments')) + ('#conf' if is_conf else '')).encode()).hexdigest()
            cache_file = cache_dir / (cache_key + '.json')
            cached = read(cache_file, {})
            if cached.get('at') and now - date(cached['at']) < timedelta(hours=24):
                return identity, (cached['comments'], None)
        try:
            fetched = comments(client.pages(f"{repo}/issues/{raw_issue['number']}/comments"), confidential=is_conf)
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
                previous_value = [p['login'] for p in before[key]] if key == 'assignees' else before[key]
                current_value = [p['login'] for p in issue[key]] if key == 'assignees' else issue[key]
                if previous_value != current_value:
                    events.append({'at': now.isoformat(), 'kind': '观测到 ' + key + ' 变化', 'detail': json.dumps(issue[key], ensure_ascii=False)})
        issue['events'] = events[-100:]
        rows[issue['id']] = issue
    assignment_names = {name.casefold() for name in assignment_members}
    for issue in rows.values():
        for person in issue['assignees']:
            person['membership'] = 'internal' if person['login'].casefold() in assignment_names else ('external' if assignment_members_complete else 'unknown')
        issue['workload_owner'] = workload_owner(issue)['login']
        issue['internal_assignment'] = internal_assignment(issue, assignment_members, assignment_members_complete)
        issue['reply_status'], issue['first_reply_at'] = reply(issue, members, member_complete, config['bots'])
    conf_count = sum(bool(i.get('confidential')) for i in rows.values())
    return {'issues': list(rows.values()), 'last_success': now.isoformat(), 'last_full': now.isoformat() if full else old['last_full'],
            'excluded_nonpublic': 0, 'confidential_count': conf_count, 'warnings': warnings, 'error': None, 'mode': 'full' if full else 'incremental'}

def collect_repo_prs(client, repo, old, config, now, full=False, cache_dir=None, internal_logins=None, known_issue_ids=None):
    old_rows = {p['id']: p for p in old.get('prs', [])}
    full = full or not old.get('pr_last_full') or now - date(old['pr_last_full']) >= timedelta(days=config['full_interval_days'])
    bot_names = DEFAULT_BOTS | {b.casefold() for b in config.get('bots', [])}
    internal_set = {x.casefold() for x in (internal_logins or set())} | bot_names
    if not full and old.get('pr_last_success'):
        since = date(old['pr_last_success']) - timedelta(hours=1)
        raw, seen = [], set()
        for page in range(1, 10001):
            rows_page = client.get(repo + '/pulls', state='all', sort='updated', direction='desc', page=page, per_page=100)
            if not isinstance(rows_page, list):
                raise SyncError('Expected paginated PR array')
            if not rows_page:
                break
            stop = False
            for r in rows_page:
                if not isinstance(r, dict) or r.get('id') is None:
                    raise SyncError('Missing PR record identity')
                rid = str(r['id'])
                if rid in seen:
                    raise SyncError('Repeated PR record: unstable pagination')
                seen.add(rid)
                if date(r.get('updated_at')) < since:
                    stop = True
                else:
                    raw.append(r)
            if stop:
                break
    else:
        raw = client.pages(repo + '/pulls', state='all', sort='updated', direction='desc')
    changed_ids = {repo + '!' + str(r.get('number')) for r in raw}
    if not full:
        for identity, previous_pr in old_rows.items():
            author_cf = (previous_pr.get('author') or {}).get('login', '').casefold()
            if author_cf and author_cf not in internal_set and not previous_pr.get('details_complete') and identity not in changed_ids:
                detail = client.get(f"{repo}/pulls/{previous_pr['number']}")
                raw.append(detail)
    valid_raw = []
    ext_raw = []
    intr_need_comments = []
    for raw_pr in raw:
        author_login = user(raw_pr.get('user') or raw_pr.get('author'))['login']
        if not author_login:
            continue
        pr_norm = normalize_pr(repo, raw_pr)
        is_internal = author_login.casefold() in internal_set
        valid_raw.append((raw_pr, is_internal))
        if not is_internal:
            ext_raw.append(raw_pr)
        else:
            if (pr_norm['state'] in ('open', 'merged')
                    and not pr_norm['draft']
                    and pr_norm['mergeable']
                    and pr_norm['ci_status'] == 'passed'):
                ci_dt = date(pr_norm.get('ci_passed_at') or pr_norm['created_at'])
                end_dt = date(pr_norm.get('merged_at') or now.isoformat())
                if pr_norm['state'] == 'open' or (end_dt - ci_dt).total_seconds() > 24 * 3600:
                    intr_need_comments.append(raw_pr)
    rows = {} if full else {pid: copy.deepcopy(p) for pid, p in old_rows.items()}
    warnings = []
    def fetch_details(raw_pr):
        identity = repo + '!' + str(raw_pr.get('number'))
        before = old_rows.get(identity)
        is_conf = raw_pr.get('visibility_reason') not in (None, 'public')
        head_sha = ((raw_pr.get('head') or {}).get('sha')
                    or (raw_pr.get('diff_refs') or {}).get('head_sha')
                    or raw_pr.get('head_sha') or '')
        comment_count = raw_pr.get('notes') if raw_pr.get('notes') is not None else raw_pr.get('comments')
        if (before and before.get('details_complete')
                and before.get('updated_at') == raw_pr.get('updated_at')
                and before.get('comment_count') == comment_count
                and before.get('head_sha', '') == head_sha):
            linked = extract_linked_issues(
                repo,
                '' if is_conf else raw_pr.get('title', ''),
                '' if is_conf else raw_pr.get('body', ''),
                before.get('linked_issues', []),
                known_issue_ids,
            )
            return identity, (before.get('files', []), before.get('comments', []), linked, None)
        cache_file = None
        if cache_dir:
            cache_key = hashlib.sha256(
                (identity + str(raw_pr.get('updated_at')) + str(comment_count) + str(head_sha) + ('#conf' if is_conf else '')).encode()
            ).hexdigest()
            cache_file = cache_dir / (cache_key + '.json')
            cached = read(cache_file, {})
            if cached.get('at') and now - date(cached['at']) < timedelta(hours=24):
                linked = extract_linked_issues(
                    repo,
                    '' if is_conf else raw_pr.get('title', ''),
                    '' if is_conf else raw_pr.get('body', ''),
                    cached.get('linked_issues', []),
                    known_issue_ids,
                )
                return identity, (cached.get('files', []), cached.get('comments', []), linked, None)
        try:
            if is_conf:
                files = []
                api_issues = []
            else:
                raw_files = client.get(f"{repo}/pulls/{raw_pr['number']}/files")
                files = [f.get('filename') for f in (raw_files if isinstance(raw_files, list) else []) if isinstance(f, dict) and f.get('filename')]
                raw_issues = client.get(f"{repo}/pulls/{raw_pr['number']}/issues")
                api_issues = raw_issues if isinstance(raw_issues, list) else []
            if comment_count == 0:
                fetched_comments = []
            else:
                fetched_comments = pr_comments(
                    client.pages(f"{repo}/pulls/{raw_pr['number']}/comments"),
                    confidential=is_conf,
                    bots=config.get('bots', []),
                )
            linked = extract_linked_issues(
                repo,
                '' if is_conf else raw_pr.get('title', ''),
                '' if is_conf else raw_pr.get('body', ''),
                api_issues,
                known_issue_ids,
            )
            if cache_file:
                atomic(cache_file, {'at': now.isoformat(), 'files': files, 'comments': fetched_comments, 'linked_issues': linked})
            return identity, (files, fetched_comments, linked, None)
        except SyncError as exc:
            fallback_files = before.get('files', []) if before else []
            fallback_comments = before.get('comments', []) if before else []
            fallback_issues = before.get('linked_issues', []) if before else []
            return identity, (fallback_files, fallback_comments, fallback_issues, str(exc))
    def fetch_internal_comments(raw_pr):
        identity = repo + '!' + str(raw_pr.get('number'))
        before = old_rows.get(identity)
        is_conf = raw_pr.get('visibility_reason') not in (None, 'public')
        head_sha = ((raw_pr.get('head') or {}).get('sha')
                    or (raw_pr.get('diff_refs') or {}).get('head_sha')
                    or raw_pr.get('head_sha') or '')
        comment_count = raw_pr.get('notes') if raw_pr.get('notes') is not None else raw_pr.get('comments')
        if (before and before.get('details_complete')
                and before.get('updated_at') == raw_pr.get('updated_at')
                and before.get('comment_count') == comment_count
                and before.get('head_sha', '') == head_sha):
            return identity, (before.get('comments', []), before.get('first_reply_at'), None)
        cache_file = None
        if cache_dir:
            cache_key = hashlib.sha256(
                (identity + str(raw_pr.get('updated_at')) + str(comment_count) + str(head_sha) + ('#conf' if is_conf else '')).encode()
            ).hexdigest()
            cache_file = cache_dir / (cache_key + '.json')
            cached = read(cache_file, {})
            if cached.get('at') and now - date(cached['at']) < timedelta(hours=24):
                return identity, (cached.get('comments', []), None, None)
        try:
            if comment_count == 0:
                fetched_comments = []
            else:
                fetched_comments = pr_comments(
                    client.pages(f"{repo}/pulls/{raw_pr['number']}/comments"),
                    confidential=is_conf,
                    bots=config.get('bots', []),
                )
            if cache_file:
                atomic(cache_file, {'at': now.isoformat(), 'files': [], 'comments': fetched_comments, 'linked_issues': []})
            return identity, (fetched_comments, None, None)
        except SyncError as exc:
            return identity, (before.get('comments', []) if before else [], before.get('first_reply_at') if before else None, str(exc))
    print(repo, 'fetching PR details for', len(ext_raw), 'external PRs', flush=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        detail_results = {}
        for completed, (identity, result) in enumerate(pool.map(fetch_details, ext_raw), 1):
            detail_results[identity] = result
            if completed % 50 == 0:
                print(repo, 'PR details', completed, '/', len(ext_raw), flush=True)
        intr_results = {}
        for identity, result in pool.map(fetch_internal_comments, intr_need_comments):
            intr_results[identity] = result
    for raw_pr, is_internal in valid_raw:
        pr = normalize_pr(repo, raw_pr)
        pr['author_role'] = 'internal' if is_internal else 'external'
        if not is_internal:
            files, fetched_comments, linked, detail_error = detail_results[pr['id']]
            pr['files'] = files
            pr['comments'] = fetched_comments
            pr['linked_issues'] = linked
            pr['details_complete'] = detail_error is None
            if detail_error:
                warnings.append('PR !' + pr['number'] + ': ' + detail_error)
        else:
            if pr['state'] != 'open':
                pr['body'] = ''
            if pr['id'] in intr_results:
                fetched_comments, prev_reply_at, detail_error = intr_results[pr['id']]
                pr['comments'] = fetched_comments
                pr['details_complete'] = detail_error is None
                if prev_reply_at and not fetched_comments:
                    pr['first_reply_at'] = prev_reply_at
            else:
                pr['details_complete'] = True
                if (pr['state'] == 'merged'
                        and not pr['draft']
                        and pr['mergeable']
                        and pr['ci_status'] == 'passed'):
                    pr['first_reply_at'] = pr.get('first_reply_at') or pr.get('merged_at') or pr['updated_at']
        rows[pr['id']] = pr
    for pr in rows.values():
        author_cf = (pr.get('author') or {}).get('login', '').casefold()
        is_internal = author_cf in internal_set
        pr['author_role'] = 'internal' if is_internal else 'external'
        if not is_internal:
            pr['linked_issues'] = extract_linked_issues(
                repo,
                '' if pr.get('confidential') else pr.get('title', ''),
                '' if pr.get('confidential') else pr.get('body', ''),
                pr.get('linked_issues', []),
                known_issue_ids,
            )
        pr['reply_status'], pr['first_reply_at'] = pr_reply(pr, config.get('bots', []))
        if is_internal and pr['state'] != 'open':
            pr['comments'] = []
            pr['body'] = ''
            pr['assignees'] = []
            pr['testers'] = []
            pr['head_sha'] = ''
            if isinstance(pr.get('author'), dict):
                pr['author']['avatar'] = ''
        pr['metrics'] = pr_status(pr, now)
    conf_count = sum(bool(p.get('confidential')) for p in rows.values())
    return {
        'prs': list(rows.values()),
        'pr_last_success': now.isoformat(),
        'pr_last_full': now.isoformat() if full else old.get('pr_last_full', now.isoformat()),
        'pr_confidential_count': conf_count,
        'pr_warnings': warnings,
        'pr_mode': 'full' if full else 'incremental',
    }

def run(args, client=None):
    client = client or Client()
    config = read(ROOT / 'config/repos.json', {})
    now = datetime.now(timezone.utc)
    dest = ROOT / 'public/data/dashboard.json'
    previous = read(dest, {})
    repositories = copy.deepcopy(previous.get('repositories', {}))
    errors = []
    directory = collect_directory(client, config['repos'], read(ROOT / 'config/internal_people.json', []), previous.get('internal_directory', {}), now)
    for repo, source in directory['sources'].items():
        if source['error']:
            errors.append(repo + ' 成员名单: ' + source['error'])
    for repo in config['repos']:
        if args.repo and args.repo != repo:
            continue
        old = repositories.get(repo, {})
        try:
            repositories[repo] = collect_repo(client, repo, old, config, now, args.full, ROOT / ".cache/comments", directory["sources"][repo])
            for k in ('prs', 'pr_stats', 'pr_last_success', 'pr_last_full', 'pr_confidential_count'):
                if k in old:
                    repositories[repo][k] = old[k]
            print(repo, repositories[repo]['mode'], len(repositories[repo]['issues']), 'issues', flush=True)
        except (SyncError, ValueError, TypeError, KeyError) as exc:
            message = str(exc) if isinstance(exc, SyncError) else 'Malformed upstream data'
            repositories[repo] = {**old, 'issues': old.get('issues', []), 'prs': old.get('prs', []), 'error': message}
            errors.append(repo + ': ' + message)
            print(errors[-1], flush=True)
    known_issue_ids = {i['id'] for r in repositories.values() for i in r.get('issues', [])}
    internal_logins = (
        {p['login'].casefold() for p in directory.get('people', []) if p.get('confirmed', True)}
        | {m.casefold() for ms in config.get('maintainers', {}).values() for m in ms}
        | {b.casefold() for b in config.get('bots', [])}
        | DEFAULT_BOTS
    )
    for repo in config['repos']:
        if args.repo and args.repo != repo:
            continue
        if repositories.get(repo, {}).get('error'):
            continue
        old = previous.get('repositories', {}).get(repo, {})
        try:
            pr_res = collect_repo_prs(
                client, repo, old, config, now, args.full,
                ROOT / ".cache/prs", internal_logins, known_issue_ids,
            )
            repositories[repo]['prs'] = pr_res['prs']
            repositories[repo]['pr_last_success'] = pr_res['pr_last_success']
            repositories[repo]['pr_last_full'] = pr_res['pr_last_full']
            repositories[repo]['pr_confidential_count'] = pr_res['pr_confidential_count']
            repositories[repo].setdefault('warnings', []).extend(pr_res['pr_warnings'])
            print(repo, pr_res['pr_mode'], len(pr_res['prs']), 'PRs', flush=True)
        except (SyncError, ValueError, TypeError, KeyError) as exc:
            message = str(exc) if isinstance(exc, SyncError) else 'Malformed upstream PR data'
            repositories[repo]['prs'] = old.get('prs', [])
            repositories[repo].setdefault('warnings', []).append('PR: ' + message)
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
    all_prs = []
    for repo, record in repositories.items():
        for issue in record['issues']:
            apply_directory(issue, directory)
            issue['reports'] = report_index.get(issue['id'], [])
            issue['metrics'] = status(issue, now)
        record['stats'] = stats(record['issues'])
        issues.extend(record['issues'])
        record.setdefault('prs', [])
        for pr in record['prs']:
            author_cf = (pr.get('author') or {}).get('login', '').casefold()
            pr['author_role'] = 'internal' if author_cf in internal_logins else 'external'
            if pr['author_role'] != 'internal':
                pr['linked_issues'] = extract_linked_issues(
                    repo,
                    '' if pr.get('confidential') else pr.get('title', ''),
                    '' if pr.get('confidential') else pr.get('body', ''),
                    pr.get('linked_issues', []),
                    known_issue_ids,
                )
            pr['reply_status'], pr['first_reply_at'] = pr_reply(pr, config.get('bots', []))
            pr['metrics'] = pr_status(pr, now)
        record['pr_stats'] = pr_stats(record['prs'])
        all_prs.extend(record['prs'])
    complete = all(repositories.get(r, {}).get('last_success') and not repositories[r].get('error') for r in config['repos'])
    result = {'schema_version': 1, 'generated_at': now.isoformat(),
              'last_success': min(repositories[r]['last_success'] for r in config['repos']) if complete else previous.get('last_success'),
              'complete': complete, 'errors': errors, 'repositories': repositories, 'internal_directory': directory,
              'stats': stats(issues), 'pr_stats': pr_stats(all_prs), 'owners': owners(issues), 'report_index': report_index, 'report_success': report_success,
              'snapshots': history(previous.get('snapshots', []), issues, now, config['snapshot_days'], complete and not args.repo),
              'activity': activity(issues), 'requests': client.requests}
    json.dumps(result, allow_nan=False)
    atomic(dest, result)
    atomic(ROOT / '.cache/last-run.json', {'at': now.isoformat(), 'errors': errors, 'requests': client.requests})
    for cache_subdir in (ROOT / '.cache/comments', ROOT / '.cache/prs'):
        for cached_file in cache_subdir.glob('*.json'):
            if datetime.fromtimestamp(cached_file.stat().st_mtime, timezone.utc) < now - timedelta(days=8):
                cached_file.unlink()
    print('Total', len(issues), 'issues', len(all_prs), 'external PRs', 'reports', sum(bool(i['reports']) for i in issues), 'requests', client.requests, flush=True)
    return 1 if errors else 0

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', choices=read(ROOT / 'config/repos.json', {})['repos'])
    parser.add_argument('--full', action='store_true')
    raise SystemExit(run(parser.parse_args()))
if __name__ == '__main__':
    main()

