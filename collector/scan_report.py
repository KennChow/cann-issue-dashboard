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
    opened = sum(i['state'] == 'open' for i in rows)
    closed = sum(i['state'] == 'closed' for i in rows)
    return f'{label}：共 {len(rows)} / 待处理 {opened} / 已关闭 {closed}'


def render(previous, current, outcome='success'):
    repos = current.get('repositories', {})
    rows = [i for r in repos.values() for i in r.get('issues', [])]
    at = datetime.fromisoformat(current['generated_at'].replace('Z', '+00:00'))
    at = at.astimezone(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M')
    new, changed, new_comments, new_reports = [], 0, 0, 0
    warnings = []
    for repo, record in sorted(repos.items()):
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
        warnings.extend(record.get('warnings', []))
    counts = current.get('stats', {})
    lines = [f'[CANN] Issue 汇总（新增 {len(new)} / 更新 {changed}）',
             f'{at}（北京时间）', '',
             summary('全量', {'issues': rows}),
             f'待关注：超期 {counts.get("overdue", 0)} / 临期 {counts.get("due_soon", 0)} / '
             f'未回复 {counts.get("unreplied", 0)} / 未分配内部责任人 {counts.get("no_internal_assignee", 0)}', '']
    lines += [summary(repo, record) for repo, record in sorted(repos.items())]
    lines += ['', f'本次：新增 Issue {len(new)} / 更新 {changed} / 新评论 {new_comments} / 新 AI 报告 {new_reports}']
    if not previous.get('repositories'):
        lines.append('首次扫描，无历史基线；以下为首次发现。')
    if new:
        lines.append('新增 Issue（首次扫描到）：')
    for item in sorted(new, key=lambda i: (i['repo'], i['created_at'], i['id'])):
        title = ' '.join(item['title'].split())
        state = '待处理' if item['state'] == 'open' else '已关闭'
        created = datetime.fromisoformat(item['created_at'].replace('Z', '+00:00'))
        created = created.astimezone(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M')
        author = ' '.join(((item.get('author') or {}).get('login') or '未知').split())
        lines += [f'- {item["id"]} [{state}] {title}',
                  f'  创建：{created}（北京时间） | 提交人：{author}',
                  f'  {item["url"]}']
    errors = current.get('errors', [])
    if outcome != 'success' or errors:
        lines += ['', '扫描异常：部分数据为上次保留值。']
        lines.extend(' '.join(str(e).split())[:160] for e in errors[:3])
        if len(errors) > 3:
            lines.append(f'另有 {len(errors) - 3} 项异常，详见看板。')
    if warnings:
        lines.append(f'数据提示：{len(warnings)} 项采集警告，详见看板。')
    lines += ['', '看板：https://kennchow.github.io/cann-issue-dashboard/']
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
    message['Subject'] = body.splitlines()[0] if body.startswith('[CANN] ') else '[CANN] Issue 汇总'
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
