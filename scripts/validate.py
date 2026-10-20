"""Fail publication if payload is malformed or contains a known environment secret."""
import json
import os
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from collector.model import stats, status, date, owners, pr_stats, pr_status
for candidate in Path('public').rglob('*.json'):
    payload = json.loads(candidate.read_text())
    assert not (isinstance(payload, dict) and 'fields' in payload and 'repo_fallbacks' in payload), 'Private duty data must not be published'
p=Path('public/data/dashboard.json')
raw=p.read_text();data=json.loads(raw)
assert data['schema_version']==1
for key in ('GITCODE_API_TOKEN','GITHUB_TOKEN','GH_TOKEN'):
    token=os.environ.get(key)
    assert not token or token not in raw, 'Credential found in publication payload'
issues=[i for r in data['repositories'].values() for i in r['issues']]
assert len({i['id'] for i in issues})==len(issues)
assert stats(issues)==data['stats']
assert owners(issues)==data['owners']
assert sum(o['stats']['open'] for o in data['owners']) == data['stats']['open']
for issue in issues:
    assert status(issue,date(data['generated_at']))==issue['metrics']
    assert issue['url'].startswith('https://gitcode.com/cann/')
    if issue.get('confidential'):
        assert issue['title']==f"[保密 Issue #{issue['number']}]" and issue['body']==''
        assert all(c['body'] in ('','/command','[保密评论]') for c in issue['comments'])
    for report in issue['reports']:
        assert report['url'].startswith('https://gitcode.com/chenqian1365/issue-watch-results/blob/')
prs=[pr for r in data['repositories'].values() for pr in r.get('prs',[])]
assert len({pr['id'] for pr in prs})==len(prs)
if 'pr_stats' in data:
    assert pr_stats(prs)==data['pr_stats']
for pr in prs:
    assert pr_status(pr,date(data['generated_at']))==pr['metrics']
    assert pr['url'].startswith('https://gitcode.com/cann/')
    if pr.get('confidential'):
        assert pr['title']==f"[保密 PR #{pr['number']}]" and pr['body']==''
        assert all(c['body'] in ('','/command','[保密评论]') for c in pr['comments'])
print('Validated',len(issues),'issues and',len(prs),'external PRs; aggregate and metric consistency OK')
