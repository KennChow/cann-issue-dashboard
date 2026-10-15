"""Fail publication if payload is malformed or contains a known environment secret."""
import json
import os
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from collector.model import stats, status, date
p=Path('public/data/dashboard.json')
raw=p.read_text();data=json.loads(raw)
assert data['schema_version']==1
for key in ('GITCODE_API_TOKEN','GITHUB_TOKEN','GH_TOKEN'):
    token=os.environ.get(key)
    assert not token or token not in raw, 'Credential found in publication payload'
issues=[i for r in data['repositories'].values() for i in r['issues']]
assert len({i['id'] for i in issues})==len(issues)
assert stats(issues)==data['stats']
for issue in issues:
    assert status(issue,date(data['generated_at']))==issue['metrics']
    assert issue['url'].startswith('https://gitcode.com/cann/')
    for report in issue['reports']:
        assert report['url'].startswith('https://gitcode.com/chenqian1365/issue-watch-results/blob/')
print('Validated',len(issues),'issues; aggregate and metric consistency OK')
