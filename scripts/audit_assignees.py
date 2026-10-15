"""Audit current public Issue assignees against complete current collaborator lists."""
import json
import sys
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from collector.api import Client
from collector.model import normalize, user

client = Client()
config = json.loads(Path('config/repos.json').read_text())
rows = []
coverage = []
for repo in config['repos']:
    members = client.pages(repo + '/collaborators')
    # All returned collaborators count, including read-only ecosystem members.
    member_logins = {user(m)['login'].casefold() for m in members if user(m)['login']}
    raw = client.pages(repo + '/issues', state='all')
    public = [normalize(repo, r) for r in raw if r.get('visibility_reason') in (None, 'public')]
    for issue in public:
        for assignee in issue['assignees']:
            if assignee['login'].casefold() not in member_logins:
                rows.append({'repo': repo, 'number': issue['number'], 'title': issue['title'],
                    'url': issue['url'], 'state': issue['state'], 'assignee': assignee['login'],
                    'author': issue['author']['login'],
                    'author_is_assignee': assignee['login'].casefold() == issue['author']['login'].casefold()})
    coverage.append({'repo':repo, 'members':len(member_logins), 'issues':len(public)})
    print(repo, 'members',len(member_logins),'public issues',len(public),flush=True)
result = {'checked_at': datetime.now(timezone.utc).isoformat(), 'coverage': coverage, 'assignments': rows}
Path('reports/assignee-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
lines = ['# 非仓库成员责任人核对', '', '核对时间：'+result['checked_at'], '',
    '以当前 collaborators 完整分页名单为准，包含只读生态开发者。仅核对公共 Issue。创建者与责任人相同不证明其本人执行了指派；不修改原始 Assignee 或未分配指标。', '']
for state,label in [('open','Open Issue'),('closed','Closed Issue（历史参考）')]:
    subset=[r for r in rows if r['state']==state]
    lines += ['## '+label, '', f"{len({r['assignee'].casefold() for r in subset})} 位责任人，{len({(r['repo'],r['number']) for r in subset})} 条 Issue，{len(subset)} 项责任归属。", '', '| 责任人 | 仓库 | Issue | 创建者 | 创建者同名 |', '|---|---|---|---|---|']
    for r in sorted(subset,key=lambda r:(r['assignee'].casefold(),r['repo'],int(r['number']))):
        lines.append(f"| {r['assignee']} | {r['repo']} | [#{r['number']}]({r['url']}) | {r['author']} | {'是' if r['author_is_assignee'] else '否'} |")
    lines.append('')
Path('reports/assignee-audit.md').write_text('\n'.join(lines)+'\n')
for state in ('open','closed'):
    subset=[r for r in rows if r['state']==state]
    groups=defaultdict(list)
    for row in subset:groups[row['assignee']].append(row)
    print(state,json.dumps({u:{'count':len(v),'same_author':sum(r['author_is_assignee'] for r in v),'issues':[r['repo'].replace('cann/','')+'#'+r['number'] for r in v]} for u,v in groups.items()},ensure_ascii=False))
