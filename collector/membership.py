"""Four-repository internal directory. Only public identity/role fields are retained."""
from .api import SyncError
from .model import user, internal_assignment, workload_owner

def collect_directory(client, repos, explicit, previous, now):
    sources = {}
    for repo in repos:
        old = previous.get('sources', {}).get(repo, {})
        try:
            raw = client.pages(repo + '/collaborators')
            members = []
            for row in raw:
                person = user(row)
                if not person['login']:
                    raise SyncError('Member missing login')
                members.append({**person, 'access_level': int(row.get('access_level') or 0), 'permission': row.get('permission') or ''})
            sources[repo] = {'members': members, 'last_success': now.isoformat(), 'error': None}
        except (SyncError, ValueError, TypeError, KeyError) as exc:
            sources[repo] = {**old, 'members': old.get('members', []), 'error': str(exc) if isinstance(exc, SyncError) else 'Invalid member response'}
    people = {}
    for repo, source in sources.items():
        for member in source['members']:
            key = member['login'].casefold()
            row = people.setdefault(key, {'login': member['login'], 'avatar': member['avatar'], 'repos': [], 'stale_repos': [], 'explicit_reason': ''})
            row['stale_repos' if source['error'] else 'repos'].append(repo)
    for entry in explicit:
        key = entry['login'].casefold()
        row = people.setdefault(key, {'login':entry['login'], 'avatar':'', 'repos':[], 'stale_repos':[], 'explicit_reason':''})
        row['explicit_reason'] = entry['reason']
    for row in people.values():
        row['confirmed'] = bool(row['repos'] or row['explicit_reason'])
    return {'checked_at':now.isoformat(), 'complete':all(not s['error'] for s in sources.values()),
            'sources':sources, 'people':sorted(people.values(), key=lambda p:p['login'].casefold())}

def apply_directory(issue, directory):
    confirmed = {p['login'].casefold() for p in directory['people'] if p['confirmed']}
    for person in issue['assignees']:
        person['membership'] = 'internal' if person['login'].casefold() in confirmed else ('external' if directory['complete'] else 'unknown')
    issue['workload_owner'] = workload_owner(issue)['login']
    issue['internal_assignment'] = internal_assignment(issue, confirmed, directory['complete'])
