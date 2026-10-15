"""GitCode v5. Credentials only in headers; safe errors never contain request URLs."""
import json
import os
import time
import random
import threading
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from urllib.error import HTTPError, URLError

class SyncError(Exception):
    pass

class Client:
    def __init__(self, token=None, delay=1.3):
        self.token = token if token is not None else os.environ.get('GITCODE_API_TOKEN', '')
        self.delay = delay
        self.requests = 0
        self._lock = threading.Lock()
        self._next_request = 0.0
        self._local = threading.local()

    def get(self, path, **params):
        url = 'https://api.gitcode.com/api/v5/repos/' + path
        if params:
            url += '?' + urlencode(params)
        headers = {'Accept': 'application/json', 'User-Agent': 'cann-issue-dashboard/1.0'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        for attempt in range(5):
            try:
                with self._lock:
                    wait = max(0, self._next_request - time.monotonic())
                    self._next_request = time.monotonic() + wait + self.delay
                    self.requests += 1
                time.sleep(wait)
                with urlopen(Request(url, headers=headers), timeout=45) as response:
                    self._local.total = response.headers.get("total_count")
                    return json.load(response)
            except HTTPError as exc:
                if exc.code not in (429, 500, 502, 503, 504) or attempt == 4:
                    raise SyncError('GitCode HTTP ' + str(exc.code)) from None
                retry = exc.headers.get('Retry-After', '')
                backoff = min(float(retry), 60) if retry.isdigit() else (max(10, 2 ** attempt) if exc.code == 429 else 2 ** attempt) + random.random()
                print('GitCode retry HTTP', exc.code, 'cooldown', round(backoff, 1), 'seconds', flush=True)
                with self._lock:
                    self._next_request = max(self._next_request, time.monotonic() + backoff)
                time.sleep(backoff)
            except (URLError, TimeoutError, OSError):
                if attempt == 4:
                    raise SyncError('GitCode network failure') from None
                time.sleep(2 ** attempt)
            except (ValueError, TypeError):
                raise SyncError('GitCode invalid JSON') from None

    def pages(self, path, **params):
        result, seen = [], set()
        for page in range(1, 10001):
            self._local.total = None
            rows = self.get(path, **params, page=page, per_page=100)
            if not isinstance(rows, list):
                raise SyncError('Expected paginated array')
            if not rows:
                return result
            for row in rows:
                if not isinstance(row, dict) or row.get('id') is None:
                    raise SyncError('Missing record identity')
                identity = str(row['id'])
                if identity in seen:
                    raise SyncError('Repeated record: unstable pagination')
                seen.add(identity)
            result.extend(rows)
            total = getattr(self._local, 'total', None)
            if total is not None and str(total).isdigit() and len(result) >= int(total):
                if len(result) != int(total):
                    raise SyncError('Pagination total changed during scan')
                return result
        raise SyncError('Pagination limit exceeded')
