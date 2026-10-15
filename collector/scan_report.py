"""Plain-text scan summaries and configurable SMTP delivery (standard library only)."""
import argparse
import json
import os
from pathlib import Path
import smtplib
import ssl
from email.message import EmailMessage
from datetime import datetime, timedelta, timezone

ROOT = Path(__file__).resolve().parents[1]


def summary(label, record):
    rows = record.get('issues', [])
    counts = record.get('stats', {})
    opened = sum(i['state'] == 'open' for i in rows)
    closed = sum(i['state'] == 'closed' for i in rows)
    return (f'{label}：共 {len(rows)} 条，待处理 {opened} 条，已关闭 {closed} 条；'
            f'未分配内部责任人 {counts.get("no_internal_assignee", 0)} 条，'
            f'未回复 {counts.get("unreplied", 0)} 条，'
            f'回复状态未知 {counts.get("unknown", 0)} 条，'
            f'超期 {counts.get("overdue", 0)} 条，临期 {counts.get("due_soon", 0)} 条，'
            f'已有 AI 报告 {counts.get("has_report", 0)} 条。')


def render(previous, current, outcome='success'):
    repos = current.get('repositories', {})
    rows = [i for r in repos.values() for i in r.get('issues', [])]
    at = datetime.fromisoformat(current['generated_at'].replace('Z', '+00:00'))
    at = at.astimezone(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S')
    lines = ['CANN Issue 扫描报告', f'数据快照时间：{at}（北京时间）',
             f'扫描结果：{"成功" if outcome == "success" else "失败或部分失败，部分数据可能为上次保留值"}',
             '统计范围：当前已采集的公共 Issue。', '', '全量数据',
             summary('全部仓库', {'issues': rows, 'stats': current.get('stats', {})})]
    new, changed, new_comments, new_reports = [], 0, 0, 0
    for repo, record in sorted(repos.items()):
        lines.append(summary(repo, record))
        lines.append(f'  最近成功扫描：{record.get("last_success", "无")}')
        old = {i['id']: i for i in previous.get('repositories', {}).get(repo, {}).get('issues', [])}
        for item in record.get('issues', []):
            before = old.get(item['id'])
            if before is None:
                new.append(item)
            elif any(item.get(k) != before.get(k) for k in (
                    'title', 'body', 'state', 'updated_at', 'assignees', 'comments', 'labels', 'priority')):
                changed += 1
            new_comments += len({c['id'] for c in item.get('comments', [])} -
                                {c['id'] for c in (before or {}).get('comments', [])})
            new_reports += len({r['url'] for r in item.get('reports', [])} -
                               {r['url'] for r in (before or {}).get('reports', [])})
        for warning in record.get('warnings', []):
            lines.append(f'  注意：{warning}')
    lines += ['', '本次新增和变化',
              '口径：与扫描前快照比较；新增表示首次扫描到，不等同于本时段创建。',
              f'新增 Issue {len(new)} 条；已有 Issue 更新 {changed} 条；新增评论 {new_comments} 条；新增 AI 报告 {new_reports} 份。']
    if not previous.get('repositories'):
        lines.append('首次扫描，无历史基线；所有已采集 Issue 均作为首次发现列出。')
    for item in sorted(new, key=lambda i: (i['repo'], i['created_at'], i['id'])):
        title = ' '.join(item['title'].split())
        lines += [f'{item["id"]} [{item["state"]}] {title}',
                  f'创建时间：{item["created_at"]}', item['url']]
    if not new:
        lines.append('本次未扫描到新增 Issue。')
    errors = current.get('errors', [])
    if errors:
        lines += ['', '扫描异常'] + [str(e) for e in errors]
    return '\n'.join(lines) + '\n'


def send_report(body, config, env):
    recipients = [x.strip() for x in env.get('REPORT_RECIPIENTS', '').split(',') if x.strip()]
    recipients = recipients or config['recipients']
    required = ('SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'SMTP_FROM')
    missing = [key for key in required if not env.get(key)]
    if missing:
        raise ValueError('Missing mail configuration: ' + ', '.join(missing))
    if not recipients or any('@' not in x or '\n' in x or '\r' in x for x in recipients):
        raise ValueError('Invalid report recipients')
    security = env.get('SMTP_SECURITY', 'ssl')
    if security not in ('ssl', 'starttls'):
        raise ValueError('SMTP_SECURITY must be ssl or starttls')
    port = int(env.get('SMTP_PORT') or ('465' if security == 'ssl' else '587'))
    message = EmailMessage()
    message['Subject'] = 'CANN Issue 扫描报告'
    message['From'] = env['SMTP_FROM']
    message['To'] = ', '.join(recipients)
    message.set_content(body, charset='utf-8')
    context = ssl.create_default_context()
    factory = smtplib.SMTP_SSL if security == 'ssl' else smtplib.SMTP
    kwargs = {'context': context} if security == 'ssl' else {}
    with factory(env['SMTP_HOST'], port, timeout=60, **kwargs) as smtp:
        if security == 'starttls':
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
        smtp.login(env['SMTP_USERNAME'], env['SMTP_PASSWORD'])
        refused = smtp.send_message(message)
        if refused:
            raise RuntimeError('SMTP refused one or more recipients')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--send', action='store_true')
    parser.add_argument('--previous', type=Path, default=ROOT / '.cache/before-scan.json')
    parser.add_argument('--current', type=Path, default=ROOT / 'public/data/dashboard.json')
    parser.add_argument('--output', type=Path, default=ROOT / '.cache/scan-report.txt')
    parser.add_argument('--outcome', default='success')
    args = parser.parse_args()
    if args.send:
        try:
            send_report(args.output.read_text(encoding='utf-8'),
                        json.loads((ROOT / 'config/mail.json').read_text()), os.environ)
        except (ValueError, OSError, smtplib.SMTPException, RuntimeError) as exc:
            # SMTP responses can contain credentials/addresses; do not log raw server responses.
            print(f'Mail delivery failed ({type(exc).__name__}); check SMTP configuration and service.')
            raise SystemExit(1)
        print('Report delivered to configured recipients.')
    else:
        previous = json.loads(args.previous.read_text()) if args.previous.exists() else {}
        current = json.loads(args.current.read_text())
        body = render(previous, current, args.outcome)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(body, encoding='utf-8')
        print(body)


if __name__ == '__main__':
    main()
