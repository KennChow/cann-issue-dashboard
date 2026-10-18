import copy
import unittest
from unittest.mock import patch
from collector.scan_report import compute_official_sla, render, render_html, send_report, workday_hours


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

        before = snapshot([i1, i2])
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
        self.assertEqual(sla['total'], 2)
        self.assertEqual(sla['closed'], 1)
        self.assertEqual(sla['closure_rate'], 50.0)

        text = render(before, after)
        self.assertIn('[CANN] Issue 巡检 | 待处理 1 · 超期 0 · 新增 0 / 更新 2', text)
        self.assertIn('【一、全局概况与官方 SLA 核心指标】', text)
        self.assertIn('【二、分仓多维统计明细】', text)
        self.assertIn('本次新闭环 Issue：', text)
        self.assertIn('本次指派变更 Issue：', text)
        self.assertIn('本次新增评论 Issue：', text)
        self.assertIn('本次新增 AI 诊断报告 Issue：', text)
        self.assertIn('【四、重点风险待办清单】', text)
        self.assertIn('【五、内部维护人待办负载 Top 排行】', text)
        self.assertIn('dev_a：待处理 3', text)

        html_doc = render_html(before, after)
        self.assertIn('<!DOCTYPE html>', html_doc)
        self.assertIn('四仓公共 Issue 态势与 SLA 巡检汇总', html_doc)
        self.assertIn('本次新闭环 Issue', html_doc)
        self.assertIn('内部维护人待办负载 Top 10', html_doc)


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
