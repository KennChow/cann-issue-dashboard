import copy
import unittest
from unittest.mock import patch
from collector.scan_report import render, send_report


def item(number):
    return {'id': f'cann/ge#{number}', 'repo': 'cann/ge', 'state': 'open',
            'title': '测试问题', 'created_at': '2026-10-15T01:00:00Z',
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
        self.assertIn('新增 Issue 1 条；已有 Issue 更新 1 条；新增评论 1 条', text)
        self.assertIn('https://gitcode.com/cann/ge/issues/2', text)
        self.assertNotIn('https://gitcode.com/cann/ge/issues/1', text)
        self.assertIn('10:00:00（北京时间）', text)
        self.assertIn('共 2 条，待处理 2 条', text)

    def test_overlap_and_failed_scan(self):
        before = snapshot([item(1)])
        after = copy.deepcopy(before)
        after['errors'] = ['cann/ge: HTTP 500']
        text = render(before, after, 'failure')
        self.assertIn('新增 Issue 0 条', text)
        self.assertIn('上次保留值', text)
        self.assertIn('HTTP 500', text)

    def test_initial_baseline(self):
        text = render({}, snapshot([item(1)]))
        self.assertIn('首次扫描，无历史基线', text)
        self.assertIn('新增 Issue 1 条', text)

    def test_partial_success(self):
        before = snapshot([item(1)])
        after = snapshot([item(1), item(2)])
        after['errors'] = ['other repo failed']
        text = render(before, after, 'failure')
        self.assertIn('新增 Issue 1 条', text)
        self.assertIn('other repo failed', text)


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
