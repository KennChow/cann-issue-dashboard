"""SHA-cached trees and explicit manifest identities; never download attachments."""
import base64
import json
import re
from urllib.parse import quote
from pathlib import PurePosixPath
from .api import SyncError
from .model import date

def safe_path(path):
    if not isinstance(path, str) or not path or '\\' in path or '..' in PurePosixPath(path).parts or path.startswith('/'):
        raise SyncError('Unsafe report path')
    return path

def index_reports(client, config, cache):
    repo, branch = config['report_repo'], config['report_branch']
    trees = cache.setdefault('trees', {})
    def tree(ref):
        if ref in trees:
            return trees[ref]
        result, seen = [], set()
        for page in range(1, 10001):
            data = client.get(f'{repo}/git/trees/{quote(ref, safe="")}', page=page, per_page=100)
            if not isinstance(data, dict) or not isinstance(data.get('tree'), list) or data.get('truncated'):
                raise SyncError('Invalid or truncated report tree')
            rows = data['tree']
            if not rows:
                break
            for row in rows:
                if row['path'] in seen:
                    raise SyncError('Repeated report tree page')
                seen.add(row['path'])
            result.extend(rows)
        else:
            raise SyncError('Report tree pagination limit')
        if ref != branch:
            trees[ref] = result
        return result
    root = tree(branch)
    manifest = next((r for r in root if r['path'] == 'index.ndjson'), None)
    metadata = cache.setdefault('metadata', {})
    if not manifest:
        raise SyncError('Report index.ndjson missing')
    sha = manifest['sha']
    if sha not in metadata:
        data = client.get(f'{repo}/contents/index.ndjson', ref=branch)
        if data.get('sha') != sha:
            raise SyncError('Report index changed during scan')
        try:
            metadata[sha] = [json.loads(l) for l in base64.b64decode(data['content']).decode().splitlines() if l.strip()]
        except (KeyError, ValueError):
            raise SyncError('Invalid report manifest') from None
    wanted = {}
    for entry in metadata[sha]:
        if entry.get('repo') not in config['repos']:
            continue
        path = safe_path(entry['path'])
        number = str(entry.get('number', ''))
        if not re.fullmatch(r'[0-9]+', number):
            raise SyncError('Invalid report issue number')
        at = entry.get('finished_at')
        date(at)
        wanted[path + '/report.md'] = (entry['repo'] + '#' + number, at)
    found = {}
    def walk(rows, prefix=''):
        for row in rows:
            path = prefix + safe_path(row['path'])
            if row['type'] == 'tree' and any(p.startswith(path + '/') for p in wanted):
                walk(tree(row['sha']), path + '/')
            elif row['type'] == 'blob' and path in wanted:
                key, at = wanted[path]
                found.setdefault(key, []).append({'at': at, 'path': path, 'url': f'https://gitcode.com/{repo}/blob/{branch}/{quote(path, safe="/")}'})
    walk(root)
    for rows in found.values():
        rows.sort(key=lambda r: (date(r['at']), r['path']), reverse=True)
    cache['metadata'] = {sha: metadata[sha]}
    return found
