import copy
import unittest
from unittest.mock import patch
from collector.scan_report import compute_official_sla, evaluate_pr_sla, render, render_html, send_report, workday_hours


def item(number):
    return {'id': f'cann/ge#{number}', 'repo': 'cann/ge', 'state': 'open',
            'title': '测试问题', 'author': {'login': 'test-author'}, 'created_at': '2026-10-15T01:00:00Z',
            'url': f'https://gitcode.com/cann/ge/issues/{number}',
            'comments': [{'id': str(number)}], 'reports': []}


def snapshot(rows):
    return {'generated_at': '2026-10-15T02:00:00Z', 'stats': {},
            'repositories': {'cann/ge': {'issues': rows}}, 'errors': []}


class ReportTests(unittest.TestCase):
    def test_diff_and_links(self):
        before = snapshot([item(1)])
        after = copy.deepcopy(before)
        after['repositories']['cann/ge']['issues'][0]['title'] = '已更新'
        after['repositories']['cann/ge']['issues'].append(item(2))
        text = render(before, after)
        self.assertIn('新增 Issue 1 / 更新 1 / 新评论 1', text)
        self.assertIn('https://gitcode.com/cann/ge/issues/2', text)
        self.assertIn('创建：2026-10-15 09:00（北京时间） | 提交人：test-author', text)
        self.assertNotIn('https://gitcode.com/cann/ge/issues/1', text)
        self.assertIn('10:00（北京时间）', text)
        self.assertIn('共 2 / 待处理 2', text)

    def test_overlap_and_failed_scan(self):
        before = snapshot([item(1)])
        after = copy.deepcopy(before)
        after['errors'] = ['cann/ge: HTTP 500']
        text = render(before, after, 'failure')
        self.assertIn('新增 Issue 0', text)
        self.assertIn('上次保留值', text)
        self.assertIn('HTTP 500', text)

    def test_initial_baseline(self):
        text = render({}, snapshot([item(1)]))
        self.assertIn('首次扫描，无历史基线', text)
        self.assertIn('新增 Issue 1', text)

    def test_partial_success(self):
        before = snapshot([item(1)])
        after = snapshot([item(1), item(2)])
        after['errors'] = ['other repo failed']
        text = render(before, after, 'failure')
        self.assertIn('新增 Issue 1', text)
        self.assertIn('other repo failed', text)

    def test_sla_and_enriched_sections(self):
        # 2026-10-01 ~ 2026-10-07 is National Day holiday; 2026-10-10 (Saturday) is makeup workday
        self.assertAlmostEqual(workday_hours('2026-10-01T00:00:00Z', '2026-10-07T00:00:00Z'), 0.0)
        self.assertAlmostEqual(workday_hours('2026-10-10T00:00:00Z', '2026-10-10T06:00:00Z'), 6.0)

        i1 = item(1)
        i1['assignees'] = [{'login': 'dev_a', 'membership': 'internal'}]
        i1['metrics'] = {'age_hours': 300.0, 'remaining_hours': 36.0, 'due_soon': True,
                         'overdue': False, 'unreplied': False, 'no_internal_assignee': False, 'unassigned': False}
        i2 = item(2)
        i2['created_at'] = '2026-10-12T01:00:00Z'
        i2['comments'] = []
        i2['metrics'] = {'age_hours': 73.0, 'remaining_hours': 263.0, 'due_soon': False,
                         'overdue': False, 'unreplied': True, 'no_internal_assignee': True, 'unassigned': True}

        i3 = item(3)
        i3['created_at'] = '2026-10-14T16:00:00Z'  # 10 hours before generated_at -> <= 24h workday
        i3['comments'] = []
        i3['metrics'] = {'age_hours': 10.0, 'remaining_hours': 326.0, 'due_soon': False,
                         'overdue': False, 'unreplied': True, 'no_internal_assignee': False, 'unassigned': False}
        i4 = item(4)
        i4['created_at'] = '2026-10-12T01:00:00Z'  # > 24h workday without human reply
        i4['comments'] = []
        i4['metrics'] = {'age_hours': 73.0, 'remaining_hours': 263.0, 'due_soon': False,
                         'overdue': False, 'unreplied': True, 'no_internal_assignee': False, 'unassigned': False}

        before = snapshot([i1, i2, i3, i4])
        after = copy.deepcopy(before)
        # Close i1, assign i2 & add comment and AI report
        after['repositories']['cann/ge']['issues'][0]['state'] = 'closed'
        after['repositories']['cann/ge']['issues'][0]['closed_at'] = '2026-10-15T01:30:00Z'
        after['repositories']['cann/ge']['issues'][1]['assignees'] = [{'login': 'ext_user', 'membership': 'external'}]
        after['repositories']['cann/ge']['issues'][1]['comments'] = [
            {'id': '99', 'body': '跟进中', 'author': {'login': 'dev_a'}, 'created_at': '2026-10-15T01:20:00Z'}
        ]
        after['repositories']['cann/ge']['issues'][1]['reports'] = [
            {'url': 'https://gitcode.com/chenqian1365/issue-watch-results/blob/main/r1/report.md', 'at': '2026-10-15T01:25:00Z'}
        ]
        after['owners'] = [{
            'person': {'login': 'dev_a', 'membership': 'internal'},
            'role': 'internal',
            'repos': {'cann/ge': 3},
            'stats': {'open': 3, 'overdue': 1, 'due_soon': 1, 'unreplied': 1, 'has_report': 2},
        }]

        sla = compute_official_sla(after['repositories']['cann/ge']['issues'], after['generated_at'])
        self.assertEqual(sla['total'], 4)
        self.assertEqual(sla['closed'], 1)
        self.assertEqual(sla['closure_rate'], 25.0)

        text = render(before, after)
        self.assertIn('[CANN] Issue 巡检 | 待处理 3 · 超期 0 · 新增 0 / 更新 2', text)
        self.assertIn('【一、全局概况与官方 SLA 核心指标】', text)
        self.assertIn('【二、分仓多维统计明细】', text)
        self.assertIn('本次新闭环 Issue：', text)
        self.assertIn('本次指派变更 Issue：', text)
        self.assertIn('本次新增评论 Issue：', text)
        self.assertIn('本次新增 AI 诊断报告 Issue：', text)
        self.assertIn('【四、重点风险待办清单】', text)
        self.assertIn('3) 即将响应超时 ≤24h 工作日', text)
        self.assertIn('4) 开启未响应超时 >24h 工作日', text)
        self.assertLess(text.index('3) 即将响应超时 ≤24h 工作日'), text.index('4) 开启未响应超时 >24h 工作日'))
        self.assertIn('【五、内部维护人待办负载 Top 排行】', text)
        self.assertIn('dev_a：待处理 3', text)

        html_doc = render_html(before, after)
        self.assertIn('<!DOCTYPE html>', html_doc)
        self.assertIn('四仓 Issue / PR 态势与 SLA 巡检汇总', html_doc)
        self.assertIn('3. 即将响应超时 &le;24h 工作日', html_doc)
        self.assertIn('4. 开启未响应超时 &gt;24h 工作日', html_doc)
        self.assertLess(html_doc.index('3. 即将响应超时'), html_doc.index('4. 开启未响应超时'))
        self.assertIn('本次新闭环 Issue', html_doc)
        self.assertIn('内部维护人待办负载 Top 10', html_doc)


def pr_item(number, **overrides):
    return {
        'id': f'cann/ge!{number}', 'repo': 'cann/ge', 'state': 'open',
        'title': '测试 PR', 'author': {'login': 'contributor'},
        'created_at': '2026-10-12T01:00:00Z', 'ci_passed_at': '2026-10-14T01:00:00Z',
        'draft': False, 'mergeable': True, 'ci_status': 'passed', 'comments': [],
        'assignees': [{'login': 'reviewer', 'membership': 'internal'}],
        'url': f'https://gitcode.com/cann/ge/merge_requests/{number}',
        **overrides,
    }


class PrReportTests(unittest.TestCase):
    def test_pr_summary_diffs_and_risks_in_both_formats(self):
        before = snapshot([])
        before['repositories']['cann/ge']['prs'] = [pr_item(n) for n in range(1, 5)]
        after = copy.deepcopy(before)
        after['generated_at'] = '2026-10-15T03:00:00Z'
        prs = after['repositories']['cann/ge']['prs']
        prs[0].update(state='merged', merged_at='2026-10-15T02:00:00Z')
        prs[1].update(state='closed', closed_at='2026-10-15T02:00:00Z')
        prs[2]['comments'] = [{
            'id': 'review-1', 'body': '请修改', 'author': {'login': 'reviewer'},
            'created_at': '2026-10-14T02:00:00Z', 'comment_type': 'diff_comment', 'resolved': False,
        }]
        prs[3]['draft'] = True
        prs.append(pr_item(5, title='<script>alert("test")</script>', author_role='internal'))
        text = render(before, after)
        doc = render_html(before, after)
        for output in (text, doc):
            for phrase in (
                'PR 全量：共 5 / 待处理 3 / 已合并 1 / 未合并关闭 1',
                'PR 闭环率：40.00% | 24h 首响达标率：33.33%',
                'PR 待关注：待合并 2 / 合并受阻 1 / 未首响 1 / 首响超时 1',
                '本次 PR：新增 1 / 更新 4 / 新合并 1 / 新关闭 1 / 新评论 1',
                '本次新合并 PR', '本次新关闭 PR（未合并）', '本次新增评论 PR',
                '存在未解决评审意见的 PR', 'cann/ge!5', '指派：reviewer[内部]',
                '#/pr-dashboard', '#/prs', 'https://gitcode.com/cann/ge/merge_requests/5',
            ):
                self.assertIn(phrase, output)
        self.assertTrue(text.startswith('[CANN] Issue / PR 巡检'))
        self.assertIn('PR 待处理 3 · 新增 1', text.splitlines()[0])
        self.assertIn('&lt;script&gt;', doc)
        self.assertNotIn('<script>', doc)
        for html_phrase in (
            'PR 分仓多维统计明细',
            '本次 PR 扫描变更明细',
            'PR 重点风险与待办清单',
            '草稿 WIP',
            '未解决评审 1',
        ):
            self.assertIn(html_phrase, doc)

    def test_pr_baseline_overlap_and_old_snapshots(self):
        old = snapshot([])
        current = copy.deepcopy(old)
        current['repositories']['cann/ge']['prs'] = [pr_item(1)]
        for render_report in (render, render_html):
            self.assertIn('尚未采集 PR 数据', render_report({}, old))
            self.assertIn('首次采集 PR，无历史 PR 基线', render_report(old, current))
            self.assertIn('本次 PR：新增 1 / 更新 0', render_report(old, current))
            unchanged = render_report(current, current)
            self.assertIn('本次 PR：新增 0 / 更新 0 / 新合并 0 / 新关闭 0 / 新评论 0', unchanged)
            self.assertNotIn('首次采集 PR', unchanged)
        current['repositories']['cann/ge']['prs'] = []
        self.assertIn('PR 全量：共 0', render(current, current))
        self.assertIn('24h 首响达标率：—', render_html(current, current))

    def test_pr_warning_retained_data_and_list_limits(self):
        current = snapshot([])
        record = current['repositories']['cann/ge']
        record.update(prs=[pr_item(n) for n in range(20)],
                      warnings=['PR !1: HTTP 500'], pr_last_success='2026-10-14T01:00:00Z')
        for render_report in (render, render_html):
            output = render_report(current, current, 'failure')
            self.assertIn('PR 数据可能为上次保留值', output)
            self.assertIn('2026-10-14 09:00', output)
            self.assertIn('共 20 项，展示前 8 项', output)
            self.assertIn('另有 12 项', output)
            self.assertIn('上次保留值', output)
            self.assertIn('本次 PR：新增 0 / 更新 0', output)

    def test_pr_response_eligibility_ci_clock_and_bot_exclusion(self):
        now = '2026-10-15T03:00:00Z'
        ready = pr_item(1, ci_passed_at='2026-10-15T02:00:00Z')
        result = evaluate_pr_sla(ready, now)
        self.assertTrue(result['qualified'])
        self.assertFalse(result['timeout'])
        self.assertEqual(result['elapsed'], 1)
        for overrides in ({'draft': True}, {'mergeable': False}, {'ci_status': 'failed'}, {'state': 'closed'}):
            self.assertFalse(evaluate_pr_sla({**ready, **overrides}, now)['eligible'])
        ready['ci_passed_at'] = '2026-10-14T01:00:00Z'
        ready['comments'] = [
            {'body': 'automated', 'author': {'login': 'atomgit-bot'}, 'created_at': '2026-10-14T02:00:00Z'},
            {'body': 'self', 'author': {'login': 'contributor'}, 'created_at': '2026-10-14T02:00:00Z'},
            {'body': 'system', 'author': {'login': 'reviewer'}, 'system': True, 'created_at': '2026-10-14T02:00:00Z'},
            {'body': 'before CI', 'author': {'login': 'reviewer'}, 'created_at': '2026-10-13T02:00:00Z'},
        ]
        self.assertTrue(evaluate_pr_sla(ready, now)['timeout'])
        ready['comments'].append({
            'body': 'review', 'author': {'login': 'reviewer'}, 'created_at': '2026-10-14T02:00:00Z',
        })
        result = evaluate_pr_sla(ready, now)
        self.assertTrue(result['qualified'])
        self.assertFalse(result['timeout'])
        self.assertEqual(result['reply_hours'], 1)
        # The 24-hour boundary is inclusive; weekend and holidays do not consume SLA time.
        self.assertTrue(evaluate_pr_sla(pr_item(1), '2026-10-15T01:00:00Z')['qualified'])
        holiday = pr_item(1, ci_passed_at='2026-10-01T00:00:00Z')
        self.assertTrue(evaluate_pr_sla(holiday, '2026-10-07T00:00:00Z')['qualified'])
        merged = pr_item(1, state='merged', first_reply_at='2026-10-14T02:00:00Z')
        self.assertEqual(evaluate_pr_sla(merged, now)['reply_hours'], 1)


class MailTests(unittest.TestCase):
    def setUp(self):
        self.env = dict(SMTP_HOST='smtp.example.com', SMTP_USERNAME='sender',
                        SMTP_PASSWORD='test-secret', SMTP_FROM='sender@example.com')
        self.config = {'recipients': ['one@example.com', 'two@example.com']}

    def test_ssl_plain_text_and_default_recipients(self):
        with patch('collector.scan_report.smtplib.SMTP_SSL') as factory:
            smtp = factory.return_value.__enter__.return_value
            smtp.send_message.return_value = {}
            send_report('纯文字报告', self.config, self.env)
            message = smtp.send_message.call_args.args[0]
            self.assertEqual(message.get_content_type(), 'text/plain')
            self.assertEqual(message['To'], 'one@example.com, two@example.com')
            self.assertIn('纯文字报告', message.get_content())
            smtp.login.assert_called_once_with('sender', 'test-secret')

    def test_multipart_html_and_plain_text(self):
        with patch('collector.scan_report.smtplib.SMTP_SSL') as factory:
            smtp = factory.return_value.__enter__.return_value
            smtp.send_message.return_value = {}
            send_report('[CANN] Issue 巡检 | 待处理 10\n纯文本内容', self.config, self.env, html_body='<html><body><h1>HTML报告</h1></body></html>')
            message = smtp.send_message.call_args.args[0]
            self.assertEqual(message.get_content_type(), 'multipart/alternative')
            self.assertEqual(message['Subject'], '[CANN] Issue 巡检 | 待处理 10')
            parts = list(message.iter_parts())
            self.assertEqual(len(parts), 2)
            self.assertEqual(parts[0].get_content_type(), 'text/plain')
            self.assertEqual(parts[1].get_content_type(), 'text/html')
            self.assertIn('HTML报告', parts[1].get_content())

    def test_starttls_override_and_partial_refusal(self):
        self.env.update(SMTP_SECURITY='starttls', REPORT_RECIPIENTS='override@example.com')
        with patch('collector.scan_report.smtplib.SMTP') as factory:
            smtp = factory.return_value.__enter__.return_value
            smtp.send_message.return_value = {'override@example.com': (550, b'rejected')}
            with self.assertRaises(RuntimeError):
                send_report('report', self.config, self.env)
            smtp.starttls.assert_called_once()
            self.assertEqual(smtp.send_message.call_args.args[0]['To'], 'override@example.com')
            self.assertEqual(factory.call_args.args[1], 587)

    def test_missing_credentials_fail_before_connection(self):
        with patch('collector.scan_report.smtplib.SMTP_SSL') as factory:
            with self.assertRaises(ValueError):
                send_report('report', self.config, {})
            factory.assert_not_called()

    def test_header_injection_rejected(self):
        self.env['REPORT_RECIPIENTS'] = 'one@example.com\nBcc: other@example.com'
        with self.assertRaises(ValueError):
            send_report('report', self.config, self.env)
