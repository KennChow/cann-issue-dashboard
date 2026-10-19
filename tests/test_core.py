import base64
import copy
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from collector.api import Client, SyncError
from collector.model import normalize, reply, status, stats, owners, date, comments
from collector.sync import collect_repo
from collector.history import history, activity
from collector.reports import index_reports, safe_path
NOW = datetime(2026,10,15,tzinfo=timezone.utc)
CONFIG = {'maintainers':{},'maintainers_complete':[],'bots':['bot'],'full_interval_days':7,'repos':['cann/ge'],'report_repo':'a/reports','report_branch':'main'}
def raw(age=0, **kw):
    return {'id':1,'number':'1','title':'Test','state':'open','created_at':(NOW-timedelta(hours=age)).isoformat(),'updated_at':NOW.isoformat(),'user':{'login':'author'},**kw}
def issue(age=0,**kw):
    i=normalize('cann/ge',raw(age,**kw));i.update(reply_status='unreplied',comments_complete=True);i['metrics']=status(i,NOW);return i
class CoreTests(unittest.TestCase):
    def test_time_boundaries(self):
        for hours,soon,over in [(264,False,False),(264.0001,True,False),(336,True,False),(336.0001,False,True)]:
            with self.subTest(hours=hours):
                m=issue(hours)['metrics'];self.assertEqual((m['due_soon'],m['overdue']),(soon,over))
    def test_closed_no_risk(self):
        m=issue(500,state='closed')['metrics'];self.assertFalse(any(m[k] for k in ('unassigned','unreplied','overdue','due_soon')))
    def test_assignee_not_author(self):
        self.assertTrue(issue()['metrics']['unassigned'])
        self.assertFalse(issue(assignee={'login':'owner'})['metrics']['unassigned'])
    def test_multi_owner_deduplicated(self):
        i=issue(assignees=[{'login':'a'},{'login':'b'},{'login':'a'}]);self.assertEqual(len(owners([i])),1);self.assertEqual(stats([i])['open'],1)
        self.assertEqual(owners([issue()])[0]['person']['login'],'未分配')
    def test_reply_roles(self):
        i=issue(1)
        def c(login,body='response',system=False):return {'id':'1','author':{'login':login},'body':body,'created_at':NOW.isoformat(),'system':system}
        for rows,complete,expected in [([c('author')],True,'unreplied'),([c('external')],True,'unreplied'),([c('maintainer')],True,'replied'),([c('bot')],True,'unreplied'),([c('maintainer','/assign someone')],True,'unreplied'),([c('external')],False,'unknown')]:
            i['comments']=rows;self.assertEqual(reply(i,{'maintainer','bot'},complete,['bot'])[0],expected)
        i['comments']=[];i['comments_complete']=False;self.assertEqual(reply(i,set(),True,[])[0],'unknown')
    def test_invalid_input(self):
        for row in [raw(created_at='2026-01-01'),raw(state='surprise'),raw(number=None),raw(assignees={1:2})]:
            with self.assertRaises(SyncError):normalize('cann/ge',row)
    def test_timezone(self):
        self.assertEqual(date('2026-10-15T08:00:00+08:00'),NOW)
        i=issue();i['created_at']='2026-10-14T17:00:00Z';self.assertEqual(activity([i])[0]['date'],'2026-10-15')
    def test_no_false_closed_today(self):
        i=issue(state='closed');self.assertEqual(sum(r['closed'] for r in activity([i])),0)
        i['closed_at']='2026-10-01T08:00:00+08:00';self.assertEqual(next(r for r in activity([i]) if r['closed'])['date'],'2026-10-01')
    def test_snapshot_idempotency_and_partial(self):
        a=history([], [issue()], NOW);self.assertEqual(history(a,[issue()],NOW),a);self.assertEqual(history(a,[],NOW+timedelta(days=1),complete=False),a)
    def test_pages_until_empty_even_short_page(self):
        c=Client();c.get=lambda p,**kw: {1:[{'id':1}],2:[{'id':2}],3:[]}[kw['page']]
        self.assertEqual(len(c.pages('x')),2)
    def test_repeated_or_invalid_page(self):
        for result in [[{'id':1}],{'error':'bad'},[{}]]:
            c=Client();c.get=lambda *a,**k:result
            with self.assertRaises(SyncError):c.pages('x')
    def test_incremental_retains_old_and_reopens(self):
        oldi=issue(400,state='closed');old={'issues':[oldi],'last_full':NOW.isoformat(),'last_success':NOW.isoformat()}
        class Fake:
            def pages(self,path,**params):
                if path.endswith('/issues'):
                    self.params=params;return [raw(400)]
                return []
        c=Fake();new=collect_repo(c,'cann/ge',old,CONFIG,NOW)
        self.assertIn('since',c.params);self.assertEqual(new['issues'][0]['state'],'open');self.assertEqual(old['issues'][0]['state'],'closed')
    def test_full_failure_never_mutates_old(self):
        old={'issues':[issue()],'last_full':NOW.isoformat(),'last_success':NOW.isoformat()};before=copy.deepcopy(old)
        class Fake:
            def pages(self,*a,**k):raise SyncError('failed')
        with self.assertRaises(SyncError):collect_repo(Fake(),'cann/ge',old,CONFIG,NOW,True)
        self.assertEqual(old,before)
    def test_retry_network_and_http(self):
        from urllib.error import HTTPError
        c=Client(delay=0)
        with patch('collector.api.urlopen',side_effect=HTTPError('hidden',429,'rate',{},None)) as p,patch('collector.api.time.sleep'):
            with self.assertRaisesRegex(SyncError,'429'):c.get('x')
            self.assertEqual(p.call_count,5)
    def test_reports_exact_latest_and_cache(self):
        entries=[{'repo':'cann/ge','number':1,'path':'old','finished_at':'2026-10-01T00:00:00Z'},{'repo':'cann/ge','number':1,'path':'new','finished_at':'2026-10-02T00:00:00Z'},{'repo':'other/ge','number':1,'path':'wrong','finished_at':'2026-10-03T00:00:00Z'}]
        class Fake:
            def get(self,path,**kw):
                if '/contents/' in path:return {'sha':'manifest','content':base64.b64encode('\n'.join(json.dumps(e) for e in entries).encode()).decode()}
                if kw['page']>1:return {'tree':[]}
                if path.endswith('/main'):return {'tree':[{'type':'blob','path':'index.ndjson','sha':'manifest'},{'type':'tree','path':'old','sha':'old'},{'type':'tree','path':'new','sha':'new'}]}
                return {'tree':[{'type':'blob','path':'report.md','sha':'r'}]}
        cache={};r=index_reports(Fake(),CONFIG,cache);self.assertEqual(len(r),1);self.assertEqual(r['cann/ge#1'][0]['path'],'new/report.md');self.assertEqual(len(r['cann/ge#1']),2)
        self.assertEqual(index_reports(Fake(),CONFIG,cache),r)
    def test_path_rejection(self):
        for p in ('../bad','/bad','a/../../bad','a\\b'):
            with self.assertRaises(SyncError):safe_path(p)

class PersistenceTests(unittest.TestCase):
    def test_failed_run_preserves_successful_data(self):
        import tempfile
        from pathlib import Path
        from types import SimpleNamespace
        from collector import sync
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'config').mkdir();(root/'public/data').mkdir(parents=True)
            (root/'config/repos.json').write_text(json.dumps({**CONFIG,'snapshot_days':365}))
            oldi=issue();oldi['events']=[]
            previous={'repositories':{'cann/ge':{'issues':[oldi],'last_success':NOW.isoformat(),'last_full':NOW.isoformat()}},'snapshots':[],'last_success':NOW.isoformat(),'report_index':{}}
            (root/'public/data/dashboard.json').write_text(json.dumps(previous))
            class Failed:
                requests=1
                def pages(self,*a,**k):raise SyncError('HTTP 500')
                def get(self,*a,**k):raise SyncError('HTTP 500')
            with patch.object(sync,'ROOT',root):
                self.assertEqual(sync.run(SimpleNamespace(repo=None,full=True),Failed()),1)
            after=json.loads((root/'public/data/dashboard.json').read_text())
            self.assertEqual(after['repositories']['cann/ge']['issues'][0]['title'],oldi['title'])
            self.assertEqual(after['last_success'],NOW.isoformat());self.assertFalse(after['complete']);self.assertEqual(len(after['errors']),3)
    def test_nonpublic_data_redacted(self):
        norm=normalize('cann/ge',raw(visibility_reason='private',title='sensitive-vuln-title',body='sensitive-poc-body'))
        self.assertTrue(norm.get('confidential'))
        self.assertEqual(norm['title'],'[保密 Issue #1]')
        self.assertEqual(norm['body'],'')
        self.assertNotIn('sensitive',json.dumps(norm))

class RateAndCacheTests(unittest.TestCase):
    def test_total_count_avoids_empty_request(self):
        c=Client();calls=[]
        def get(path,**kw):
            calls.append(kw['page']);c._local.total='1';return [{'id':1}]
        c.get=get
        self.assertEqual(c.pages('x'),[{'id':1}]);self.assertEqual(calls,[1])
    def test_missing_comments_retried_outside_incremental_window(self):
        oldi=issue();oldi['comments_complete']=False
        old={'issues':[oldi],'last_full':NOW.isoformat(),'last_success':NOW.isoformat()}
        class Fake:
            def pages(self,path,**params):return []
            def get(self,path):return raw(comments=0)
        new=collect_repo(Fake(),'cann/ge',old,CONFIG,NOW)
        self.assertTrue(new['issues'][0]['comments_complete'])

class ConfidentialTests(unittest.TestCase):
    def test_confidential_records_redacted_and_counted(self):
        class Fake:
            def pages(self,path,**params):
                if path.endswith('/issues'):
                    return [raw(comments=0,visibility_reason='public'),raw(number='2',id=2,title='secret-vuln',body='secret-body',comments=1,visibility_reason='confidential')]
                if path.endswith('/2/comments'):
                    return [{'id':20,'body':'secret-comment-detail','user':{'login':'member'},'created_at':NOW.isoformat()}]
                return []
        record=collect_repo(Fake(),'cann/ge',{},CONFIG,NOW,True)
        self.assertEqual(len(record['issues']),2);self.assertEqual(record['confidential_count'],1)
        conf_issue=next(i for i in record['issues'] if i['number']=='2')
        self.assertEqual(conf_issue['title'],'[保密 Issue #2]')
        self.assertEqual(conf_issue['body'],'')
        self.assertEqual(conf_issue['comments'][0]['body'],'[保密评论]')
        self.assertNotIn('secret-',json.dumps(record))

class MembershipTests(unittest.TestCase):
    def test_gitcode_ecosystem_developer_is_project_member(self):
        class Fake:
            def pages(self,path,**params):
                if path.endswith('/issues'):return [raw(1,comments=1)]
                if path.endswith('/collaborators'):return [{'id':2,'login':'member','access_level':15,'permission':'read'}]
                return [{'id':3,'body':'Confirmed and investigating','user':{'login':'member'},'created_at':NOW.isoformat()}]
        record=collect_repo(Fake(),'cann/ge',{},CONFIG,NOW,True)
        self.assertEqual(record['issues'][0]['reply_status'],'replied')

class BulkTests(unittest.TestCase):
    def test_bulk_comments_exclude_unknown_targets_and_validate_identity(self):
        class Fake:
            def pages(self,path,**params):
                if path.endswith('/issues'):
                    return [raw(1,id=n,number=str(n),comments=1 if n==1 else 0) for n in range(1,22)]
                if path.endswith('/collaborators'):return [{'id':99,'login':'member','access_level':15}]
                if path.endswith('/issues/comments'):
                    return [{'id':101,'target':{'issue':{'id':1,'number':1}},'body':'Public response','user':{'login':'member'},'created_at':NOW.isoformat()}, {'id':102,'target':{'issue':{'id':999,'number':999}},'body':'private-content-must-not-be-published','user':{'login':'member'},'created_at':NOW.isoformat()}]
                raise AssertionError('Unexpected per-issue request')
        result=collect_repo(Fake(),'cann/ge',{},CONFIG,NOW,True)
        self.assertEqual(result['issues'][0]['reply_status'],'replied')
        self.assertNotIn('private-content-must-not-be-published',json.dumps(result))
        self.assertEqual(len(result['issues']),21)

class InternalAssignmentTests(unittest.TestCase):
    def test_assignment_evidence_and_multiple_assignees(self):
        from collector.model import internal_assignment
        cases=[([],set(),False,'missing'),(['external'],{'member'},True,'missing'),(['external','Member'],{'member'},True,'assigned'),(['external'],set(),False,'unknown'),(['member'],{'member'},False,'assigned')]
        for logins,members,complete,expected in cases:
            i=issue(assignees=[{'login':l} for l in logins])
            self.assertEqual(internal_assignment(i,members,complete),expected)
    def test_independent_open_only_tag(self):
        i=issue(assignees=[{'login':'author'}]);i['internal_assignment']='missing'
        m=status(i,NOW);self.assertTrue(m['no_internal_assignee']);self.assertFalse(m['unassigned'])
        i['state']='closed';self.assertFalse(status(i,NOW)['no_internal_assignee'])
    def test_membership_change_recomputes_unchanged_issue(self):
        oldi=issue(assignees=[{'login':'author'}]);oldi['internal_assignment']='assigned'
        class Fake:
            def pages(self,path,**params):return []
        record=collect_repo(Fake(),'cann/ge',{'issues':[oldi],'last_full':NOW.isoformat(),'last_success':NOW.isoformat()},CONFIG,NOW)
        self.assertEqual(record['issues'][0]['internal_assignment'],'missing')

class WorkloadTests(unittest.TestCase):
    def test_first_internal_gets_single_issue(self):
        i=issue(assignees=[{'login':'outside'},{'login':'inside1'},{'login':'inside2'}])
        for p in i['assignees']:p['membership']='external' if p['login']=='outside' else 'internal'
        groups=owners([i]);self.assertEqual(len(groups),1);self.assertEqual(groups[0]['person']['login'],'inside1');self.assertEqual(groups[0]['role'],'internal')
    def test_external_first_and_unknown(self):
        i=issue(assignees=[{'login':'a'},{'login':'b'}])
        for p in i['assignees']:p['membership']='external'
        self.assertEqual(owners([i])[0]['role'],'external');self.assertEqual(owners([i])[0]['person']['login'],'a')
        i['assignees'][0]['membership']='unknown';self.assertEqual(owners([i])[0]['role'],'unknown')
    def test_membership_varies_by_repo_and_conservation(self):
        a=issue(assignees=[{'login':'a'}]);a['assignees'][0]['membership']='internal'
        b=issue(assignees=[{'login':'a'}]);b['repo']='cann/metadef';b['assignees'][0]['membership']='external'
        groups=owners([a,b,issue()]);self.assertEqual(sum(g['stats']['open'] for g in groups),3);self.assertEqual(groups[0]['role'],'mixed')

class DirectoryTests(unittest.TestCase):
    def test_union_deduplicates_and_classifies_across_repositories(self):
        from collector.membership import collect_directory, apply_directory
        class Fake:
            def pages(self,path):return [{'login':'Chang-an-HW','id':1}] if path.startswith('cann/ge/') else [{'login':'chang-an-hw','id':1}] if path.startswith('cann/metadef/') else []
        directory=collect_directory(Fake(),['cann/ge','cann/metadef','cann/tensorflow'],[],{},NOW)
        self.assertEqual(len(directory['people']),1);self.assertEqual(len(directory['people'][0]['repos']),2)
        i=issue(assignees=[{'login':'outsider'},{'login':'Chang-an-HW'}]);i['repo']='cann/tensorflow';apply_directory(i,directory)
        self.assertEqual(i['workload_owner'],'Chang-an-HW');self.assertEqual(i['internal_assignment'],'assigned')
    def test_explicit_confirmation_and_partial_failure(self):
        from collector.membership import collect_directory, apply_directory
        class Fake:
            def pages(self,path):raise SyncError('HTTP 503')
        d=collect_directory(Fake(),['cann/ge'],[{'login':'confirmed','reason':'verified'}],{},NOW)
        self.assertFalse(d['complete'])
        i=issue(assignees=[{'login':'confirmed'}]);apply_directory(i,d);self.assertEqual(i['internal_assignment'],'assigned')
        i=issue(assignees=[{'login':'other'}]);apply_directory(i,d);self.assertEqual(i['assignees'][0]['membership'],'unknown')
    def test_failed_source_preserved_but_not_treated_as_fresh_evidence(self):
        from collector.membership import collect_directory
        class Fake:
            def pages(self,path):raise SyncError('HTTP 503')
        d=collect_directory(Fake(),['cann/ge'],[],{'sources':{'cann/ge':{'members':[{'login':'old','avatar':''}],'last_success':NOW.isoformat()}}},NOW)
        self.assertEqual(d['people'][0]['stale_repos'],['cann/ge']);self.assertFalse(d['people'][0]['confirmed'])

if __name__ == '__main__':
    unittest.main()
