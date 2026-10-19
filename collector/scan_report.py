"""Plain-text and HTML scan summaries with configurable SMTP delivery (standard library only)."""
import argparse
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
import html
import json
import math
import os
from pathlib import Path
import smtplib
import ssl
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD_URL = 'https://kennchow.github.io/cann-issue-dashboard/'
BJT = timezone(timedelta(hours=8))
BJT_OFFSET_SECONDS = 8 * 3600
DAY_SECONDS = 24 * 3600

# 中国大陆国务院办公厅法定节假日（休假）与调休补班日（2024 - 2026），与前端 src/sla.ts 严格保持一致
CN_HOLIDAYS = {
    # 2024
    '2024-01-01',
    '2024-02-10', '2024-02-11', '2024-02-12', '2024-02-13', '2024-02-14', '2024-02-15', '2024-02-16', '2024-02-17',
    '2024-04-04', '2024-04-05', '2024-04-06',
    '2024-05-01', '2024-05-02', '2024-05-03', '2024-05-04', '2024-05-05',
    '2024-06-08', '2024-06-09', '2024-06-10',
    '2024-09-15', '2024-09-16', '2024-09-17',
    '2024-10-01', '2024-10-02', '2024-10-03', '2024-10-04', '2024-10-05', '2024-10-06', '2024-10-07',
    # 2025
    '2025-01-01',
    '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
    '2025-04-04', '2025-04-05', '2025-04-06',
    '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
    '2025-05-31', '2025-06-01', '2025-06-02',
    '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
    # 2026
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
}

CN_MAKEUP_WORKDAYS = {
    # 2024
    '2024-02-04', '2024-02-18', '2024-04-07', '2024-04-28', '2024-05-11', '2024-09-14', '2024-09-29', '2024-10-12',
    # 2025
    '2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11',
    # 2026
    '2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10',
}

BOT_LOGINS = {'cann-robot', 'gitcode-bot', 'openeuler-ci-bot', 'ascend-robot'}


def parse_iso(value):
    if not value or not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def fmt_bjt(iso_str):
    dt = parse_iso(iso_str)
    if not dt:
        return '未知'
    return dt.astimezone(BJT).strftime('%Y-%m-%d %H:%M')


def is_cn_workday(bjt_day_index):
    dt = datetime.fromtimestamp(bjt_day_index * DAY_SECONDS, tz=timezone.utc)
    date_str = dt.strftime('%Y-%m-%d')
    if date_str in CN_MAKEUP_WORKDAYS:
        return True
    if date_str in CN_HOLIDAYS:
        return False
    return dt.weekday() < 5


def workday_hours(start_iso, end_iso):
    start_dt = parse_iso(start_iso)
    end_dt = parse_iso(end_iso)
    if not start_dt or not end_dt:
        return 0.0
    start_ts = start_dt.timestamp()
    end_ts = end_dt.timestamp()
    if end_ts <= start_ts:
        return 0.0
    bjt_start = start_ts + BJT_OFFSET_SECONDS
    bjt_end = end_ts + BJT_OFFSET_SECONDS
    start_day = math.floor(bjt_start / DAY_SECONDS)
    end_day = math.floor(bjt_end / DAY_SECONDS)
    valid_sec = 0.0
    for day in range(start_day, end_day + 1):
        if not is_cn_workday(day):
            continue
        seg_start = max(bjt_start, day * DAY_SECONDS)
        seg_end = min(bjt_end, (day + 1) * DAY_SECONDS)
        if seg_end > seg_start:
            valid_sec += seg_end - seg_start
    return valid_sec / 3600.0


def evaluate_issue_sla(issue, snapshot_iso):
    author_login = ((issue.get('author') or {}).get('login') or '').lower()
    assignees = issue.get('assignees') or []
    is_self_processed = bool(author_login) and any(
        (a.get('login') or '').lower() == author_login for a in assignees if isinstance(a, dict)
    )
    source_status = str(issue.get('source_status') or '')
    labels = issue.get('labels') or []
    is_milestone = (
        'milestone' in source_status.lower()
        or '里程碑' in source_status
        or any('milestone' in str(l).lower() or '里程碑' in str(l) for l in labels)
    )
    excluded_from_resp_sla = is_self_processed or is_milestone

    created_dt = parse_iso(issue.get('created_at'))
    created_ts = created_dt.timestamp() if created_dt else 0.0
    first_human_reply_at = None
    for c in issue.get('comments') or []:
        if not isinstance(c, dict) or c.get('system'):
            continue
        body = str(c.get('body') or '').strip()
        if not body or body.startswith('/'):
            continue
        commenter = ((c.get('author') or {}).get('login') or '').lower()
        if not commenter or commenter == author_login:
            continue
        if commenter in BOT_LOGINS or commenter.endswith('[bot]') or commenter.endswith('-bot'):
            continue
        c_dt = parse_iso(c.get('created_at'))
        if c_dt and c_dt.timestamp() >= created_ts:
            first_human_reply_at = c.get('created_at')
            break
    if not first_human_reply_at and issue.get('first_reply_at'):
        first_human_reply_at = issue.get('first_reply_at')

    end_iso = issue.get('closed_at') or snapshot_iso
    stay_work_hours = workday_hours(issue.get('created_at'), end_iso)
    first_resp_work_hours = (
        workday_hours(issue.get('created_at'), first_human_reply_at) if first_human_reply_at else None
    )
    close_work_days = (
        workday_hours(issue.get('created_at'), issue.get('closed_at')) / 24.0
        if issue.get('state') == 'closed' and issue.get('closed_at')
        else None
    )

    if not excluded_from_resp_sla:
        first_resp_qualified = (
            first_resp_work_hours <= 24.0 if first_resp_work_hours is not None else stay_work_hours <= 24.0
        )
    else:
        first_resp_qualified = False
    first_resp_unqualified = (not excluded_from_resp_sla) and (not first_resp_qualified)
    open_no_resp = (
        (not excluded_from_resp_sla)
        and issue.get('state') == 'open'
        and first_human_reply_at is None
    )
    open_no_resp_timeout = open_no_resp and stay_work_hours > 24.0

    return {
        'is_self_processed': is_self_processed,
        'is_milestone': is_milestone,
        'excluded_from_resp_sla': excluded_from_resp_sla,
        'first_human_reply_at': first_human_reply_at,
        'first_resp_work_hours': first_resp_work_hours,
        'stay_work_hours': stay_work_hours,
        'close_work_days': close_work_days,
        'first_resp_qualified': first_resp_qualified,
        'first_resp_unqualified': first_resp_unqualified,
        'open_no_resp': open_no_resp,
        'open_no_resp_timeout': open_no_resp_timeout,
    }


def compute_official_sla(issues, snapshot_iso):
    total = len(issues)
    opened = 0
    closed = 0
    close_days_sum = 0.0
    close_days_count = 0

    resp_eligible_total = 0
    excluded_self_processed = 0
    excluded_milestone = 0
    first_resp_qualified_num = 0
    first_resp_unqualified_num = 0
    first_resp_hours_sum = 0.0
    first_resp_hours_count = 0
    open_no_resp_total = 0
    open_no_resp_timeout_num = 0

    for issue in issues:
        state = issue.get('state')
        if state == 'open':
            opened += 1
        elif state == 'closed':
            closed += 1
        sla = evaluate_issue_sla(issue, snapshot_iso)
        if sla['close_work_days'] is not None:
            close_days_sum += sla['close_work_days']
            close_days_count += 1
        if sla['is_self_processed']:
            excluded_self_processed += 1
        if sla['is_milestone']:
            excluded_milestone += 1
        if sla['excluded_from_resp_sla']:
            continue
        resp_eligible_total += 1
        if sla['first_resp_qualified']:
            first_resp_qualified_num += 1
        else:
            first_resp_unqualified_num += 1
        if sla['first_resp_work_hours'] is not None:
            first_resp_hours_sum += sla['first_resp_work_hours']
            first_resp_hours_count += 1
        if sla['open_no_resp']:
            open_no_resp_total += 1
            if sla['open_no_resp_timeout']:
                open_no_resp_timeout_num += 1

    closure_rate = round(closed / total * 100, 2) if total > 0 else None
    first_resp_rate = (
        round(first_resp_qualified_num / resp_eligible_total * 100, 2)
        if resp_eligible_total > 0
        else None
    )
    avg_close_days = round(close_days_sum / close_days_count, 1) if close_days_count > 0 else None
    avg_first_resp_hours = (
        round(first_resp_hours_sum / first_resp_hours_count, 1)
        if first_resp_hours_count > 0
        else None
    )

    return {
        'total': total,
        'open': opened,
        'closed': closed,
        'closure_rate': closure_rate,
        'avg_close_days': avg_close_days,
        'resp_eligible_total': resp_eligible_total,
        'excluded_self_processed': excluded_self_processed,
        'excluded_milestone': excluded_milestone,
        'first_resp_qualified_num': first_resp_qualified_num,
        'first_resp_unqualified_num': first_resp_unqualified_num,
        'first_resp_qualified_rate': first_resp_rate,
        'avg_first_resp_hours': avg_first_resp_hours,
        'open_no_resp_total': open_no_resp_total,
        'open_no_resp_timeout_num': open_no_resp_timeout_num,
    }


def summary(label, record, snapshot_iso=None):
    rows = record.get('issues', [])
    opened = sum(i.get('state') == 'open' for i in rows)
    closed = sum(i.get('state') == 'closed' for i in rows)
    base = f'{label}：共 {len(rows)} / 待处理 {opened} / 已关闭 {closed}'
    r_stats = record.get('stats')
    if not r_stats and not snapshot_iso:
        return base
    if r_stats or snapshot_iso:
        sla = compute_official_sla(rows, snapshot_iso or '')
        rate_str = f'{sla["closure_rate"]:.2f}%' if sla['closure_rate'] is not None else '—'
        resp_str = f'{sla["first_resp_qualified_rate"]:.2f}%' if sla['first_resp_qualified_rate'] is not None else '—'
        overdue = (r_stats or {}).get('overdue', sum(bool((i.get('metrics') or {}).get('overdue')) for i in rows))
        due_soon = (r_stats or {}).get('due_soon', sum(bool((i.get('metrics') or {}).get('due_soon')) for i in rows))
        unreplied = (r_stats or {}).get('unreplied', sum(bool((i.get('metrics') or {}).get('unreplied')) for i in rows))
        no_internal = (r_stats or {}).get(
            'no_internal_assignee',
            sum(bool((i.get('metrics') or {}).get('no_internal_assignee')) for i in rows),
        )
        return (
            f'{base} | 闭环率 {rate_str} | 首响达标 {resp_str} | '
            f'超期 {overdue} / 临期 {due_soon} / 未回复 {unreplied} / 未分配内部维护人 {no_internal}'
        )
    return base


def _clean_text(value, default='未知'):
    text = ' '.join(str(value or '').split())
    return text if text else default


def _format_assignees(issue):
    assignees = issue.get('assignees') or []
    if not assignees:
        return '未分配'
    parts = []
    for person in assignees:
        if not isinstance(person, dict):
            continue
        login = _clean_text(person.get('login'), '')
        if not login:
            continue
        membership = person.get('membership')
        if membership == 'internal':
            parts.append(f'{login}[内部]')
        elif membership == 'external':
            parts.append(f'{login}[外部]')
        else:
            parts.append(login)
    return '、'.join(parts) if parts else '未分配'


def _owner_login(issue):
    owner = issue.get('workload_owner')
    if owner:
        return _clean_text(owner)
    assignees = issue.get('assignees') or []
    for person in assignees:
        if isinstance(person, dict) and person.get('membership') == 'internal' and person.get('login'):
            return _clean_text(person['login'])
    for person in assignees:
        if isinstance(person, dict) and person.get('login'):
            return _clean_text(person['login'])
    return '未分配'


def _analyze(previous, current, outcome='success'):
    repos = current.get('repositories', {})
    snapshot_iso = current.get('generated_at', '')
    at = fmt_bjt(snapshot_iso)
    rows = [i for r in repos.values() for i in r.get('issues', [])]
    has_baseline = bool(previous.get('repositories'))

    new_issues = []
    changed = 0
    new_comments_total = 0
    new_reports_total = 0
    newly_closed = []
    assignee_changed = []
    commented_issues = []
    reported_issues = []
    warnings = []

    for repo, record in sorted(repos.items()):
        old = {i['id']: i for i in previous.get('repositories', {}).get(repo, {}).get('issues', [])}
        for item in record.get('issues', []):
            before = old.get(item['id'])
            old_comment_ids = {c['id'] for c in (before or {}).get('comments', []) if isinstance(c, dict) and 'id' in c}
            cur_comment_ids = {c['id'] for c in item.get('comments', []) if isinstance(c, dict) and 'id' in c}
            added_comment_ids = cur_comment_ids - old_comment_ids

            old_report_urls = {r['url'] for r in (before or {}).get('reports', []) if isinstance(r, dict) and 'url' in r}
            cur_report_urls = {r['url'] for r in item.get('reports', []) if isinstance(r, dict) and 'url' in r}
            added_report_urls = cur_report_urls - old_report_urls

            new_comments_total += len(added_comment_ids)
            new_reports_total += len(added_report_urls)

            if before is None:
                new_issues.append(item)
            else:
                if any(
                    item.get(k) != before.get(k)
                    for k in ('title', 'body', 'state', 'updated_at', 'assignees', 'comments', 'labels', 'priority')
                ):
                    changed += 1
                if before.get('state') != 'closed' and item.get('state') == 'closed':
                    newly_closed.append(item)
                before_logins = [a.get('login', '') for a in before.get('assignees') or [] if isinstance(a, dict)]
                cur_logins = [a.get('login', '') for a in item.get('assignees') or [] if isinstance(a, dict)]
                if before_logins != cur_logins:
                    assignee_changed.append((item, before_logins, cur_logins))
                if added_comment_ids:
                    added_comments = [
                        c for c in item.get('comments', [])
                        if isinstance(c, dict) and c.get('id') in added_comment_ids
                    ]
                    commented_issues.append((item, len(added_comment_ids), added_comments))
                if added_report_urls:
                    added_reports = [
                        r for r in item.get('reports', [])
                        if isinstance(r, dict) and r.get('url') in added_report_urls
                    ]
                    reported_issues.append((item, added_reports))
        warnings.extend(record.get('warnings', []))

    raw_counts = current.get('stats') or {}
    opened_total = sum(i.get('state') == 'open' for i in rows)
    closed_total = sum(i.get('state') == 'closed' for i in rows)
    counts = {
        'open': raw_counts.get('open', opened_total),
        'closed': raw_counts.get('closed', closed_total),
        'overdue': raw_counts.get('overdue', sum(bool((i.get('metrics') or {}).get('overdue')) for i in rows)),
        'due_soon': raw_counts.get('due_soon', sum(bool((i.get('metrics') or {}).get('due_soon')) for i in rows)),
        'unreplied': raw_counts.get('unreplied', sum(bool((i.get('metrics') or {}).get('unreplied')) for i in rows)),
        'no_internal_assignee': raw_counts.get(
            'no_internal_assignee',
            sum(bool((i.get('metrics') or {}).get('no_internal_assignee')) for i in rows),
        ),
        'unassigned': raw_counts.get('unassigned', sum(bool((i.get('metrics') or {}).get('unassigned')) for i in rows)),
        'has_report': raw_counts.get('has_report', sum(bool(i.get('reports')) for i in rows)),
    }

    global_sla = compute_official_sla(rows, snapshot_iso)
    repo_rows = []
    for repo, record in sorted(repos.items()):
        r_issues = record.get('issues', [])
        r_stats = record.get('stats') or {}
        r_sla = compute_official_sla(r_issues, snapshot_iso)
        repo_rows.append({
            'repo': repo,
            'record': record,
            'total': len(r_issues),
            'open': sum(i.get('state') == 'open' for i in r_issues),
            'closed': sum(i.get('state') == 'closed' for i in r_issues),
            'closure_rate': r_sla['closure_rate'],
            'first_resp_rate': r_sla['first_resp_qualified_rate'],
            'overdue': r_stats.get('overdue', sum(bool((i.get('metrics') or {}).get('overdue')) for i in r_issues)),
            'due_soon': r_stats.get('due_soon', sum(bool((i.get('metrics') or {}).get('due_soon')) for i in r_issues)),
            'unreplied': r_stats.get('unreplied', sum(bool((i.get('metrics') or {}).get('unreplied')) for i in r_issues)),
            'no_internal_assignee': r_stats.get(
                'no_internal_assignee',
                sum(bool((i.get('metrics') or {}).get('no_internal_assignee')) for i in r_issues),
            ),
        })

    # 重点风险待办清单（基于 metrics 与 SLA 识别）
    no_internal_list = [
        i for i in rows
        if i.get('state') == 'open' and (i.get('metrics') or {}).get('no_internal_assignee')
    ]
    no_internal_list.sort(key=lambda i: (i.get('created_at', ''), i.get('id', '')), reverse=True)

    due_soon_list = [
        i for i in rows
        if i.get('state') == 'open' and (i.get('metrics') or {}).get('due_soon')
    ]
    due_soon_list.sort(key=lambda i: (i.get('metrics') or {}).get('remaining_hours', 9999))

    open_soon_resp_list = []
    open_timeout_list = []
    for i in rows:
        if i.get('state') != 'open' or not i.get('metrics'):
            continue
        sla_detail = evaluate_issue_sla(i, snapshot_iso)
        if sla_detail['open_no_resp_timeout']:
            open_timeout_list.append((i, sla_detail['stay_work_hours']))
        elif sla_detail['open_no_resp']:
            rem_h = max(0.0, 24.0 - sla_detail['stay_work_hours'])
            open_soon_resp_list.append((i, sla_detail['stay_work_hours'], rem_h))
    open_soon_resp_list.sort(key=lambda item_tuple: (item_tuple[2], item_tuple[0].get('id', '')))
    open_timeout_list.sort(key=lambda pair: (pair[0].get('created_at', ''), pair[0].get('id', '')), reverse=True)

    # 内部维护人负载排行
    owners_data = current.get('owners') or []
    internal_owners = [
        o for o in owners_data
        if o.get('role') in ('internal', 'mixed') and (o.get('stats') or {}).get('open', 0) > 0
    ]
    internal_owners.sort(
        key=lambda o: (
            (o.get('stats') or {}).get('open', 0),
            (o.get('stats') or {}).get('overdue', 0),
            (o.get('stats') or {}).get('unreplied', 0),
        ),
        reverse=True,
    )

    subject = (
        f'[CANN] Issue 巡检 | 待处理 {counts["open"]} · 超期 {counts["overdue"]} · '
        f'新增 {len(new_issues)} / 更新 {changed}'
    )

    return {
        'subject': subject,
        'at': at,
        'snapshot_iso': snapshot_iso,
        'outcome': outcome,
        'has_baseline': has_baseline,
        'rows': rows,
        'repos': repos,
        'counts': counts,
        'global_sla': global_sla,
        'repo_rows': repo_rows,
        'new_issues': sorted(new_issues, key=lambda i: (i.get('repo', ''), i.get('created_at', ''), i.get('id', ''))),
        'changed': changed,
        'new_comments_total': new_comments_total,
        'new_reports_total': new_reports_total,
        'newly_closed': sorted(newly_closed, key=lambda i: (i.get('closed_at') or i.get('updated_at') or '', i.get('id', '')), reverse=True),
        'assignee_changed': assignee_changed,
        'commented_issues': commented_issues,
        'reported_issues': reported_issues,
        'no_internal_list': no_internal_list,
        'due_soon_list': due_soon_list,
        'open_soon_resp_list': open_soon_resp_list,
        'open_timeout_list': open_timeout_list,
        'internal_owners': internal_owners,
        'errors': current.get('errors') or [],
        'warnings': warnings,
    }


def _rate_status_label(rate, target, warn=50.0):
    if rate is None:
        return '无数据'
    if rate >= target:
        return f'达标 ≥{int(target)}%'
    if rate >= warn:
        return f'预警 {int(warn)}%–{int(target)}%'
    return f'未达标 <{int(warn)}%'


def render(previous, current, outcome='success'):
    ctx = _analyze(previous, current, outcome)
    counts = ctx['counts']
    sla = ctx['global_sla']

    closure_rate_str = f'{sla["closure_rate"]:.2f}%' if sla['closure_rate'] is not None else '—'
    first_resp_rate_str = (
        f'{sla["first_resp_qualified_rate"]:.2f}%' if sla['first_resp_qualified_rate'] is not None else '—'
    )
    avg_close_str = f'{sla["avg_close_days"]:.1f} 工作日' if sla['avg_close_days'] is not None else '—'
    avg_resp_str = f'{sla["avg_first_resp_hours"]:.1f} 工作日小时' if sla['avg_first_resp_hours'] is not None else '—'

    lines = [
        ctx['subject'],
        f'{ctx["at"]}（北京时间）',
        '',
        '【一、全局概况与官方 SLA 核心指标】',
        summary('全量', {'issues': ctx['rows'], 'stats': counts}, ctx['snapshot_iso']),
        (
            f'待关注：超期 {counts["overdue"]} / 临期 {counts["due_soon"]} / '
            f'未回复 {counts["unreplied"]} / 未分配内部维护人 {counts["no_internal_assignee"]} / '
            f'未分配责任人 {counts["unassigned"]}'
        ),
        (
            f'SLA 口径：剔除中国大陆法定节假日及周末，首次响应排除自处理（{sla["excluded_self_processed"]} 项）'
            f'及里程碑（{sla["excluded_milestone"]} 项）Issue'
        ),
        (
            f'- Issue 闭环率：{closure_rate_str}（{_rate_status_label(sla["closure_rate"], 90)}，'
            f'已闭环 {sla["closed"]} / 总数 {sla["total"]}，平均闭环耗时 {avg_close_str}）'
        ),
        (
            f'- 首次响应达标率（≤24h 工作日）：{first_resp_rate_str}（'
            f'{_rate_status_label(sla["first_resp_qualified_rate"], 80)}，'
            f'达标 {sla["first_resp_qualified_num"]} / 有效样本 {sla["resp_eligible_total"]}，'
            f'平均首响耗时 {avg_resp_str}）'
        ),
        f'- 首次响应未达标数：{sla["first_resp_unqualified_num"]} 项（首响 >24h 或未响应停留 >24h 工作日）',
        (
            f'- 开启未响应超时 / 总数：{sla["open_no_resp_timeout_num"]} / {sla["open_no_resp_total"]} 项'
            f'（Open 未响应且停留 >24h 工作日）'
        ),
        '',
        '【二、分仓多维统计明细】',
    ]

    for repo, record in sorted(ctx['repos'].items()):
        lines.append(summary(repo, record, ctx['snapshot_iso']))

    lines += [
        '',
        '【三、本次扫描变更明细】',
        (
            f'本次：新增 Issue {len(ctx["new_issues"])} / 更新 {ctx["changed"]} / '
            f'新评论 {ctx["new_comments_total"]} / 新 AI 报告 {ctx["new_reports_total"]} '
            f'（新闭环 {len(ctx["newly_closed"])} / 指派变更 {len(ctx["assignee_changed"])}）'
        ),
    ]
    if not ctx['has_baseline']:
        lines.append('首次扫描，无历史基线；以下为首次发现。')

    if ctx['new_issues']:
        lines.append('新增 Issue（首次扫描到）：')
        for item in ctx['new_issues']:
            title = _clean_text(item.get('title'))
            state = '待处理' if item.get('state') == 'open' else '已关闭'
            created = fmt_bjt(item.get('created_at'))
            author = _clean_text((item.get('author') or {}).get('login'))
            assignee_str = _format_assignees(item)
            priority = _clean_text(item.get('priority'), '')
            prio_tag = f' [{priority}]' if priority else ''
            lines += [
                f'- {item["id"]} [{state}]{prio_tag} {title}',
                f'  创建：{created}（北京时间） | 提交人：{author} | 指派：{assignee_str}',
                f'  {item["url"]}',
            ]
            if item.get('reports'):
                lines.append(f'  AI 诊断报告：{item["reports"][0]["url"]}')

    if ctx['has_baseline'] and ctx['newly_closed']:
        lines.append('本次新闭环 Issue：')
        for item in ctx['newly_closed'][:15]:
            title = _clean_text(item.get('title'))
            closed_at = fmt_bjt(item.get('closed_at') or item.get('updated_at'))
            owner = _owner_login(item)
            lines += [
                f'- {item["id"]} [已关闭] {title}',
                f'  闭环时间：{closed_at}（北京时间） | 责任人：{owner}',
                f'  {item["url"]}',
            ]
        if len(ctx['newly_closed']) > 15:
            lines.append(f'  …另有 {len(ctx["newly_closed"]) - 15} 项新闭环 Issue，详见看板。')

    if ctx['has_baseline'] and ctx['assignee_changed']:
        lines.append('本次指派变更 Issue：')
        for item, before_logins, cur_logins in ctx['assignee_changed'][:15]:
            title = _clean_text(item.get('title'))
            old_str = '、'.join(before_logins) if before_logins else '未分配'
            new_str = '、'.join(cur_logins) if cur_logins else '未分配'
            lines += [
                f'- {item["id"]} {title}',
                f'  指派变更：{old_str} -> {new_str} | {item["url"]}',
            ]

    if ctx['has_baseline'] and ctx['commented_issues']:
        lines.append('本次新增评论 Issue：')
        for item, count, added_comments in ctx['commented_issues'][:15]:
            title = _clean_text(item.get('title'))
            latest_commenter = _clean_text((added_comments[-1].get('author') or {}).get('login')) if added_comments else '未知'
            lines += [
                f'- {item["id"]} {title}（新增 {count} 条评论，最新评论人：{latest_commenter}）',
                f'  {item["url"]}',
            ]
        if len(ctx['commented_issues']) > 15:
            lines.append(f'  …另有 {len(ctx["commented_issues"]) - 15} 项新增评论 Issue，详见看板。')

    if ctx['has_baseline'] and ctx['reported_issues']:
        lines.append('本次新增 AI 诊断报告 Issue：')
        for item, added_reports in ctx['reported_issues'][:15]:
            title = _clean_text(item.get('title'))
            report_url = added_reports[0].get('url', '') if added_reports else ''
            lines += [
                f'- {item["id"]} {title}',
                f'  报告：{report_url} | Issue：{item["url"]}',
            ]

    if ctx['no_internal_list'] or ctx['due_soon_list'] or ctx['open_soon_resp_list'] or ctx['open_timeout_list']:
        lines += ['', '【四、重点风险待办清单】']
        if ctx['no_internal_list']:
            lines.append(f'1) 未分配内部维护人（共 {len(ctx["no_internal_list"])} 项，展示前 {min(8, len(ctx["no_internal_list"]))} 项）：')
            for item in ctx['no_internal_list'][:8]:
                title = _clean_text(item.get('title'))
                age_days = round(((item.get('metrics') or {}).get('age_hours') or 0) / 24.0, 1)
                assignee_str = _format_assignees(item)
                lines.append(
                    f'   - {item["id"]} {title}（已开启 {age_days} 天 | 当前指派：{assignee_str}） {item["url"]}'
                )
        if ctx['due_soon_list']:
            lines.append(f'2) 即将超期 11–14 天预警（共 {len(ctx["due_soon_list"])} 项，展示前 {min(8, len(ctx["due_soon_list"]))} 项）：')
            for item in ctx['due_soon_list'][:8]:
                title = _clean_text(item.get('title'))
                rem_hours = round((item.get('metrics') or {}).get('remaining_hours') or 0, 1)
                owner = _owner_login(item)
                lines.append(
                    f'   - {item["id"]} {title}（距 14 天超期仅剩 {rem_hours}h | 责任人：{owner}） {item["url"]}'
                )
        if ctx['open_soon_resp_list']:
            lines.append(f'3) 即将响应超时 ≤24h 工作日（共 {len(ctx["open_soon_resp_list"])} 项，展示最紧迫 {min(8, len(ctx["open_soon_resp_list"]))} 项）：')
            for item, stay_h, rem_h in ctx['open_soon_resp_list'][:8]:
                title = _clean_text(item.get('title'))
                owner = _owner_login(item)
                lines.append(
                    f'   - {item["id"]} {title}（距 24h 首响超时仅剩 {rem_h:.1f}h 工作日，已停留 {stay_h:.1f}h | 责任人：{owner}） {item["url"]}'
                )
        if ctx['open_timeout_list']:
            lines.append(f'4) 开启未响应超时 >24h 工作日（共 {len(ctx["open_timeout_list"])} 项，展示最新 {min(8, len(ctx["open_timeout_list"]))} 项）：')
            for item, stay_h in ctx['open_timeout_list'][:8]:
                title = _clean_text(item.get('title'))
                owner = _owner_login(item)
                lines.append(
                    f'   - {item["id"]} {title}（已停留 {stay_h:.1f} 工作日小时未首响 | 责任人：{owner}） {item["url"]}'
                )

    if ctx['internal_owners']:
        lines += ['', '【五、内部维护人待办负载 Top 排行】']
        for idx, owner_entry in enumerate(ctx['internal_owners'][:10], 1):
            login = _clean_text((owner_entry.get('person') or {}).get('login'))
            st = owner_entry.get('stats') or {}
            repos_str = '、'.join(
                f'{r.split("/")[-1]}({n})' for r, n in sorted((owner_entry.get('repos') or {}).items())
            )
            lines.append(
                f'{idx}. {login}：待处理 {st.get("open", 0)}（超期 {st.get("overdue", 0)} / '
                f'临期 {st.get("due_soon", 0)} / 未回复 {st.get("unreplied", 0)} / '
                f'含 AI 报告 {st.get("has_report", 0)}）| 仓库：{repos_str}'
            )

    errors = ctx['errors']
    if outcome != 'success' or errors:
        lines += ['', '扫描异常：部分数据为上次保留值。']
        lines.extend(' '.join(str(e).split())[:160] for e in errors[:3])
        if len(errors) > 3:
            lines.append(f'另有 {len(errors) - 3} 项异常，详见看板。')
    if ctx['warnings']:
        lines.append(f'数据提示：{len(ctx["warnings"])} 项采集警告，详见看板。')

    lines += [
        '',
        f'看板：{DASHBOARD_URL}',
        f'Issue 工作台：{DASHBOARD_URL}#/issues',
        f'内部维护人总表：{DASHBOARD_URL}#/members',
        f'GE 责任田查询：{DASHBOARD_URL}#/duty',
    ]
    return '\n'.join(lines) + '\n'


def _badge_html(text, tone='slate'):
    palettes = {
        'blue': ('#eff6ff', '#1d4ed8', '#bfdbfe'),
        'green': ('#f0fdf4', '#15803d', '#bbf7d0'),
        'amber': ('#fffbeb', '#b45309', '#fde68a'),
        'red': ('#fef2f2', '#b91c1c', '#fecaca'),
        'purple': ('#f5f3ff', '#6d28d9', '#ddd6fe'),
        'slate': ('#f1f5f9', '#475569', '#cbd5e1'),
    }
    bg, fg, border = palettes.get(tone, palettes['slate'])
    return (
        f'<span style="display:inline-block;padding:2px 8px;border-radius:999px;'
        f'background:{bg};color:{fg};border:1px solid {border};'
        f'font-size:11px;font-weight:600;line-height:1.4;white-space:nowrap;">'
        f'{html.escape(str(text))}</span>'
    )


def _rate_tone(rate, target, warn=50.0):
    if rate is None:
        return 'slate'
    if rate >= target:
        return 'green'
    if rate >= warn:
        return 'amber'
    return 'red'


def render_html(previous, current, outcome='success'):
    ctx = _analyze(previous, current, outcome)
    counts = ctx['counts']
    sla = ctx['global_sla']

    closure_rate_str = f'{sla["closure_rate"]:.2f}%' if sla['closure_rate'] is not None else '—'
    first_resp_rate_str = (
        f'{sla["first_resp_qualified_rate"]:.2f}%' if sla['first_resp_qualified_rate'] is not None else '—'
    )
    avg_close_str = f'{sla["avg_close_days"]:.1f} 工作日' if sla['avg_close_days'] is not None else '—'
    avg_resp_str = f'{sla["avg_first_resp_hours"]:.1f} 工作日小时' if sla['avg_first_resp_hours'] is not None else '—'

    closure_tone = _rate_tone(sla['closure_rate'], 90)
    resp_tone = _rate_tone(sla['first_resp_qualified_rate'], 80)
    unqual_tone = 'red' if sla['first_resp_unqualified_num'] > 0 else 'green'
    timeout_tone = 'amber' if sla['open_no_resp_timeout_num'] > 0 else 'green'

    # 异常与警告横幅
    alert_banners = []
    if outcome != 'success' or ctx['errors']:
        err_items = ''.join(
            f'<li style="margin:2px 0;">{html.escape(" ".join(str(e).split())[:160])}</li>'
            for e in ctx['errors'][:3]
        )
        more_err = (
            f'<div style="margin-top:4px;font-size:12px;">另有 {len(ctx["errors"]) - 3} 项异常，详见看板。</div>'
            if len(ctx['errors']) > 3
            else ''
        )
        alert_banners.append(
            '<div style="margin:0 0 16px 0;padding:12px 16px;background:#fef2f2;border:1px solid #fecaca;'
            'border-left:4px solid #dc2626;border-radius:8px;color:#991b1b;font-size:13px;">'
            '<strong>扫描异常：部分数据为上次保留值。</strong>'
            f'<ul style="margin:6px 0 0 18px;padding:0;">{err_items}</ul>{more_err}</div>'
        )
    if ctx['warnings']:
        alert_banners.append(
            '<div style="margin:0 0 16px 0;padding:10px 14px;background:#fffbeb;border:1px solid #fde68a;'
            'border-left:4px solid #d97706;border-radius:8px;color:#92400e;font-size:13px;">'
            f'<strong>数据提示：</strong>本次扫描有 {len(ctx["warnings"])} 项采集警告，详见看板。</div>'
        )
    if not ctx['has_baseline']:
        alert_banners.append(
            '<div style="margin:0 0 16px 0;padding:10px 14px;background:#eff6ff;border:1px solid #bfdbfe;'
            'border-left:4px solid #2563eb;border-radius:8px;color:#1e40af;font-size:13px;">'
            '首次扫描，无历史基线；以下新增列表为首次发现的全量 Issue。</div>'
        )

    # 分仓表格行
    repo_tr_list = []
    for idx, r in enumerate(ctx['repo_rows']):
        bg = '#ffffff' if idx % 2 == 0 else '#f8fafc'
        repo_url = f'{DASHBOARD_URL}#/issues?repo={quote(r["repo"], safe="")}'
        c_rate = f'{r["closure_rate"]:.2f}%' if r['closure_rate'] is not None else '—'
        f_rate = f'{r["first_resp_rate"]:.2f}%' if r['first_resp_rate'] is not None else '—'
        overdue_cell = (
            f'<strong style="color:#dc2626;">{r["overdue"]}</strong>' if r['overdue'] > 0 else '0'
        )
        soon_cell = (
            f'<strong style="color:#d97706;">{r["due_soon"]}</strong>' if r['due_soon'] > 0 else '0'
        )
        unrep_cell = (
            f'<strong style="color:#b45309;">{r["unreplied"]}</strong>' if r['unreplied'] > 0 else '0'
        )
        no_int_cell = (
            f'<strong style="color:#dc2626;">{r["no_internal_assignee"]}</strong>'
            if r['no_internal_assignee'] > 0
            else '0'
        )
        repo_tr_list.append(
            f'<tr style="background:{bg};">'
            f'<td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;">'
            f'<a href="{repo_url}" style="color:#2563eb;text-decoration:none;">{html.escape(r["repo"])}</a></td>'
            f'<td style="padding:10px 10px;border-bottom:1px solid #e2e8f0;text-align:right;color:#334155;">{r["total"]}</td>'
            f'<td style="padding:10px 10px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;color:#1d4ed8;">{r["open"]}</td>'
            f'<td style="padding:10px 10px;border-bottom:1px solid #e2e8f0;text-align:right;color:#15803d;">{r["closed"]}</td>'
            f'<td style="padding:10px 10px;border-bottom:1px solid #e2e8f0;text-align:right;">{_badge_html(c_rate, _rate_tone(r["closure_rate"], 90))}</td>'
            f'<td style="padding:10px 10px;border-bottom:1px solid #e2e8f0;text-align:right;">{_badge_html(f_rate, _rate_tone(r["first_resp_rate"], 80))}</td>'
            f'<td style="padding:10px 10px;border-bottom:1px solid #e2e8f0;text-align:right;">{overdue_cell}</td>'
            f'<td style="padding:10px 10px;border-bottom:1px solid #e2e8f0;text-align:right;">{soon_cell}</td>'
            f'<td style="padding:10px 10px;border-bottom:1px solid #e2e8f0;text-align:right;">{unrep_cell}</td>'
            f'<td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;text-align:right;">{no_int_cell}</td>'
            f'</tr>'
        )
    # 合计行
    repo_tr_list.append(
        '<tr style="background:#f1f5f9;font-weight:700;">'
        f'<td style="padding:10px 12px;border-top:2px solid #cbd5e1;color:#0f172a;">全量合计</td>'
        f'<td style="padding:10px 10px;border-top:2px solid #cbd5e1;text-align:right;color:#0f172a;">{len(ctx["rows"])}</td>'
        f'<td style="padding:10px 10px;border-top:2px solid #cbd5e1;text-align:right;color:#1d4ed8;">{counts["open"]}</td>'
        f'<td style="padding:10px 10px;border-top:2px solid #cbd5e1;text-align:right;color:#15803d;">{counts["closed"]}</td>'
        f'<td style="padding:10px 10px;border-top:2px solid #cbd5e1;text-align:right;">{_badge_html(closure_rate_str, closure_tone)}</td>'
        f'<td style="padding:10px 10px;border-top:2px solid #cbd5e1;text-align:right;">{_badge_html(first_resp_rate_str, resp_tone)}</td>'
        f'<td style="padding:10px 10px;border-top:2px solid #cbd5e1;text-align:right;color:#dc2626;">{counts["overdue"]}</td>'
        f'<td style="padding:10px 10px;border-top:2px solid #cbd5e1;text-align:right;color:#d97706;">{counts["due_soon"]}</td>'
        f'<td style="padding:10px 10px;border-top:2px solid #cbd5e1;text-align:right;color:#b45309;">{counts["unreplied"]}</td>'
        f'<td style="padding:10px 12px;border-top:2px solid #cbd5e1;text-align:right;color:#dc2626;">{counts["no_internal_assignee"]}</td>'
        '</tr>'
    )

    # 三、本次变更明细 HTML
    diff_blocks = []
    if ctx['new_issues']:
        items_html = []
        for item in ctx['new_issues'][:20]:
            title = html.escape(_clean_text(item.get('title')))
            state_badge = _badge_html('待处理', 'blue') if item.get('state') == 'open' else _badge_html('已关闭', 'green')
            prio = _clean_text(item.get('priority'), '')
            prio_badge = ' ' + _badge_html(prio, 'amber') if prio else ''
            created = html.escape(fmt_bjt(item.get('created_at')))
            author = html.escape(_clean_text((item.get('author') or {}).get('login')))
            assignee_str = html.escape(_format_assignees(item))
            url = html.escape(item.get('url', ''))
            report_link = ''
            if item.get('reports'):
                r_url = html.escape(item['reports'][0].get('url', ''))
                report_link = f' · <a href="{r_url}" style="color:#7c3aed;text-decoration:none;font-weight:600;">AI 诊断报告 ↗</a>'
            items_html.append(
                '<div style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">'
                f'<div style="font-size:13px;font-weight:600;color:#0f172a;">'
                f'<a href="{url}" style="color:#2563eb;text-decoration:none;">{html.escape(item["id"])}</a> '
                f'{state_badge}{prio_badge} {title}</div>'
                f'<div style="margin-top:4px;font-size:12px;color:#64748b;">'
                f'创建：{created}（北京时间） · 提交人：<strong>{author}</strong> · 指派：{assignee_str}{report_link}'
                f'</div></div>'
            )
        diff_blocks.append(
            '<div style="margin-top:12px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">'
            f'<div style="padding:8px 12px;background:#eff6ff;border-bottom:1px solid #bfdbfe;font-size:13px;font-weight:700;color:#1e40af;">'
            f'新增 Issue（共 {len(ctx["new_issues"])} 项）</div>'
            f'{"".join(items_html)}</div>'
        )

    if ctx['has_baseline'] and ctx['newly_closed']:
        items_html = []
        for item in ctx['newly_closed'][:15]:
            title = html.escape(_clean_text(item.get('title')))
            closed_at = html.escape(fmt_bjt(item.get('closed_at') or item.get('updated_at')))
            owner = html.escape(_owner_login(item))
            url = html.escape(item.get('url', ''))
            items_html.append(
                '<div style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;">'
                f'<a href="{url}" style="color:#15803d;font-weight:600;text-decoration:none;">{html.escape(item["id"])}</a> '
                f'{_badge_html("已闭环", "green")} <strong>{title}</strong>'
                f'<span style="color:#64748b;font-size:12px;margin-left:8px;">闭环：{closed_at} · 责任人：{owner}</span>'
                '</div>'
            )
        diff_blocks.append(
            '<div style="margin-top:12px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">'
            f'<div style="padding:8px 12px;background:#f0fdf4;border-bottom:1px solid #bbf7d0;font-size:13px;font-weight:700;color:#166534;">'
            f'本次新闭环 Issue（共 {len(ctx["newly_closed"])} 项）</div>'
            f'{"".join(items_html)}</div>'
        )

    if ctx['has_baseline'] and ctx['assignee_changed']:
        items_html = []
        for item, before_logins, cur_logins in ctx['assignee_changed'][:15]:
            title = html.escape(_clean_text(item.get('title')))
            old_str = html.escape('、'.join(before_logins) if before_logins else '未分配')
            new_str = html.escape('、'.join(cur_logins) if cur_logins else '未分配')
            url = html.escape(item.get('url', ''))
            items_html.append(
                '<div style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;">'
                f'<a href="{url}" style="color:#2563eb;font-weight:600;text-decoration:none;">{html.escape(item["id"])}</a> '
                f'<strong>{title}</strong> '
                f'<span style="color:#64748b;font-size:12px;">指派：{old_str} &rarr; <strong style="color:#0f172a;">{new_str}</strong></span>'
                '</div>'
            )
        diff_blocks.append(
            '<div style="margin-top:12px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">'
            f'<div style="padding:8px 12px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:700;color:#334155;">'
            f'本次指派变更 Issue（共 {len(ctx["assignee_changed"])} 项）</div>'
            f'{"".join(items_html)}</div>'
        )

    if ctx['has_baseline'] and ctx['commented_issues']:
        items_html = []
        for item, count, added_comments in ctx['commented_issues'][:15]:
            title = html.escape(_clean_text(item.get('title')))
            latest_commenter = (
                html.escape(_clean_text((added_comments[-1].get('author') or {}).get('login')))
                if added_comments
                else '未知'
            )
            url = html.escape(item.get('url', ''))
            items_html.append(
                '<div style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;">'
                f'<a href="{url}" style="color:#2563eb;font-weight:600;text-decoration:none;">{html.escape(item["id"])}</a> '
                f'<strong>{title}</strong> '
                f'{_badge_html(f"+{count} 条评论", "blue")} '
                f'<span style="color:#64748b;font-size:12px;">最新评论人：{latest_commenter}</span>'
                '</div>'
            )
        diff_blocks.append(
            '<div style="margin-top:12px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">'
            f'<div style="padding:8px 12px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:700;color:#334155;">'
            f'本次新增评论 Issue（共 {len(ctx["commented_issues"])} 项）</div>'
            f'{"".join(items_html)}</div>'
        )

    if ctx['has_baseline'] and ctx['reported_issues']:
        items_html = []
        for item, added_reports in ctx['reported_issues'][:15]:
            title = html.escape(_clean_text(item.get('title')))
            url = html.escape(item.get('url', ''))
            r_url = html.escape(added_reports[0].get('url', '')) if added_reports else ''
            items_html.append(
                '<div style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;">'
                f'<a href="{url}" style="color:#2563eb;font-weight:600;text-decoration:none;">{html.escape(item["id"])}</a> '
                f'<strong>{title}</strong> · '
                f'<a href="{r_url}" style="color:#7c3aed;font-weight:600;text-decoration:none;">查看新 AI 诊断报告 ↗</a>'
                '</div>'
            )
        diff_blocks.append(
            '<div style="margin-top:12px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">'
            f'<div style="padding:8px 12px;background:#f5f3ff;border-bottom:1px solid #ddd6fe;font-size:13px;font-weight:700;color:#5b21b6;">'
            f'本次新增 AI 诊断报告（共 {len(ctx["reported_issues"])} 项）</div>'
            f'{"".join(items_html)}</div>'
        )

    if not diff_blocks:
        diff_blocks.append(
            '<div style="margin-top:10px;padding:12px;background:#f8fafc;border:1px dashed #cbd5e1;'
            'border-radius:8px;color:#64748b;font-size:13px;text-align:center;">'
            '本次扫描周期内无新增 Issue、新闭环、指派变更或新增评论/报告。</div>'
        )

    # 四、重点风险待办清单 HTML
    risk_sections_html = []
    if ctx['no_internal_list']:
        rows_html = []
        for item in ctx['no_internal_list'][:8]:
            title = html.escape(_clean_text(item.get('title')))
            age_days = round(((item.get('metrics') or {}).get('age_hours') or 0) / 24.0, 1)
            assignee_str = html.escape(_format_assignees(item))
            url = html.escape(item.get('url', ''))
            rows_html.append(
                f'<tr>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;">'
                f'<a href="{url}" style="color:#2563eb;font-weight:600;text-decoration:none;">{html.escape(item["id"])}</a></td>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;color:#0f172a;">{title}</td>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;color:#64748b;">{age_days} 天</td>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;color:#b45309;">{assignee_str}</td>'
                f'</tr>'
            )
        risk_sections_html.append(
            '<div style="margin-top:12px;border:1px solid #fde68a;border-radius:8px;overflow:hidden;">'
            '<div style="padding:8px 12px;background:#fffbeb;border-bottom:1px solid #fde68a;font-size:13px;font-weight:700;color:#92400e;">'
            f'1. 未分配内部维护人（共 {len(ctx["no_internal_list"])} 项，展示最新 {min(8, len(ctx["no_internal_list"]))} 项）'
            f'<a href="{DASHBOARD_URL}#/issues?state=open&amp;internal=missing" style="float:right;color:#b45309;text-decoration:none;font-weight:600;">查看全部 ↗</a>'
            '</div>'
            '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;">'
            '<tr style="background:#fefce8;color:#713f12;text-align:left;">'
            '<th style="padding:6px 10px;">Issue</th><th style="padding:6px 10px;">标题</th>'
            '<th style="padding:6px 10px;">已开启</th><th style="padding:6px 10px;">当前指派</th></tr>'
            f'{"".join(rows_html)}</table></div>'
        )

    if ctx['due_soon_list']:
        rows_html = []
        for item in ctx['due_soon_list'][:8]:
            title = html.escape(_clean_text(item.get('title')))
            rem_h = round((item.get('metrics') or {}).get('remaining_hours') or 0, 1)
            owner = html.escape(_owner_login(item))
            url = html.escape(item.get('url', ''))
            rows_html.append(
                f'<tr>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;">'
                f'<a href="{url}" style="color:#2563eb;font-weight:600;text-decoration:none;">{html.escape(item["id"])}</a></td>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;color:#0f172a;">{title}</td>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;color:#dc2626;font-weight:600;">剩余 {rem_h}h</td>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;color:#334155;">{owner}</td>'
                f'</tr>'
            )
        risk_sections_html.append(
            '<div style="margin-top:12px;border:1px solid #fed7aa;border-radius:8px;overflow:hidden;">'
            '<div style="padding:8px 12px;background:#fff7ed;border-bottom:1px solid #fed7aa;font-size:13px;font-weight:700;color:#9a3412;">'
            f'2. 即将超期 11–14 天预警（共 {len(ctx["due_soon_list"])} 项）'
            f'<a href="{DASHBOARD_URL}#/issues?state=open&amp;risk=soon" style="float:right;color:#c2410c;text-decoration:none;font-weight:600;">查看全部 ↗</a>'
            '</div>'
            '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;">'
            '<tr style="background:#ffedd5;color:#7c2d12;text-align:left;">'
            '<th style="padding:6px 10px;">Issue</th><th style="padding:6px 10px;">标题</th>'
            '<th style="padding:6px 10px;">距 14 天超期</th><th style="padding:6px 10px;">责任人</th></tr>'
            f'{"".join(rows_html)}</table></div>'
        )

    if ctx['open_soon_resp_list']:
        rows_html = []
        for item, stay_h, rem_h in ctx['open_soon_resp_list'][:8]:
            title = html.escape(_clean_text(item.get('title')))
            owner = html.escape(_owner_login(item))
            url = html.escape(item.get('url', ''))
            rows_html.append(
                f'<tr>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;">'
                f'<a href="{url}" style="color:#2563eb;font-weight:600;text-decoration:none;">{html.escape(item["id"])}</a></td>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;color:#0f172a;">{title}</td>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;color:#d97706;font-weight:600;">剩余 {rem_h:.1f}h <span style="color:#64748b;font-weight:400;">（已停留 {stay_h:.1f}h）</span></td>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;color:#334155;">{owner}</td>'
                f'</tr>'
            )
        risk_sections_html.append(
            '<div style="margin-top:12px;border:1px solid #fde68a;border-radius:8px;overflow:hidden;">'
            '<div style="padding:8px 12px;background:#fffbeb;border-bottom:1px solid #fde68a;font-size:13px;font-weight:700;color:#b45309;">'
            f'3. 即将响应超时 &le;24h 工作日（共 {len(ctx["open_soon_resp_list"])} 项，展示最紧迫 {min(8, len(ctx["open_soon_resp_list"]))} 项）'
            f'<a href="{DASHBOARD_URL}#/issues?state=open&amp;first_resp=open_soon" style="float:right;color:#b45309;text-decoration:none;font-weight:600;">查看全部 ↗</a>'
            '</div>'
            '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;">'
            '<tr style="background:#fefce8;color:#713f12;text-align:left;">'
            '<th style="padding:6px 10px;">Issue</th><th style="padding:6px 10px;">标题</th>'
            '<th style="padding:6px 10px;">距 24h 首响超时</th><th style="padding:6px 10px;">责任人</th></tr>'
            f'{"".join(rows_html)}</table></div>'
        )

    if ctx['open_timeout_list']:
        rows_html = []
        for item, stay_h in ctx['open_timeout_list'][:8]:
            title = html.escape(_clean_text(item.get('title')))
            owner = html.escape(_owner_login(item))
            url = html.escape(item.get('url', ''))
            rows_html.append(
                f'<tr>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;">'
                f'<a href="{url}" style="color:#2563eb;font-weight:600;text-decoration:none;">{html.escape(item["id"])}</a></td>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;color:#0f172a;">{title}</td>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;color:#dc2626;font-weight:600;">{stay_h:.1f}h 工作日</td>'
                f'<td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap;color:#334155;">{owner}</td>'
                f'</tr>'
            )
        risk_sections_html.append(
            '<div style="margin-top:12px;border:1px solid #fecaca;border-radius:8px;overflow:hidden;">'
            '<div style="padding:8px 12px;background:#fef2f2;border-bottom:1px solid #fecaca;font-size:13px;font-weight:700;color:#991b1b;">'
            f'4. 开启未响应超时 &gt;24h 工作日（共 {len(ctx["open_timeout_list"])} 项，展示最新 {min(8, len(ctx["open_timeout_list"]))} 项）'
            f'<a href="{DASHBOARD_URL}#/issues?state=open&amp;first_resp=open_timeout" style="float:right;color:#b91c1c;text-decoration:none;font-weight:600;">查看全部 ↗</a>'
            '</div>'
            '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;">'
            '<tr style="background:#fee2e2;color:#7f1d1d;text-align:left;">'
            '<th style="padding:6px 10px;">Issue</th><th style="padding:6px 10px;">标题</th>'
            '<th style="padding:6px 10px;">未首响停留</th><th style="padding:6px 10px;">责任人</th></tr>'
            f'{"".join(rows_html)}</table></div>'
        )

    # 五、内部维护人负载 Top 排行 HTML
    owners_html_block = ''
    if ctx['internal_owners']:
        owner_trs = []
        for idx, owner_entry in enumerate(ctx['internal_owners'][:10], 1):
            bg = '#ffffff' if idx % 2 == 1 else '#f8fafc'
            login = _clean_text((owner_entry.get('person') or {}).get('login'))
            owner_url = f'{DASHBOARD_URL}#/issues?owner={quote(login, safe="")}'
            st = owner_entry.get('stats') or {}
            repos_str = '、'.join(
                f'{r.split("/")[-1]}({n})' for r, n in sorted((owner_entry.get('repos') or {}).items())
            )
            ov = st.get('overdue', 0)
            soon = st.get('due_soon', 0)
            unrep = st.get('unreplied', 0)
            rep_cnt = st.get('has_report', 0)
            owner_trs.append(
                f'<tr style="background:{bg};">'
                f'<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;color:#64748b;font-weight:600;">#{idx}</td>'
                f'<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-weight:600;">'
                f'<a href="{owner_url}" style="color:#2563eb;text-decoration:none;">{html.escape(login)}</a></td>'
                f'<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;color:#475569;font-size:12px;">{html.escape(repos_str)}</td>'
                f'<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;color:#1d4ed8;">{st.get("open", 0)}</td>'
                f'<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;color:{"#dc2626" if ov else "#64748b"};font-weight:{"700" if ov else "400"};">{ov}</td>'
                f'<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;color:{"#d97706" if soon else "#64748b"};">{soon}</td>'
                f'<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;color:{"#b45309" if unrep else "#64748b"};font-weight:{"700" if unrep else "400"};">{unrep}</td>'
                f'<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;color:#6d28d9;">{rep_cnt}</td>'
                f'</tr>'
            )
        owners_html_block = (
            '<div style="margin-top:24px;">'
            '<div style="margin-bottom:10px;font-size:15px;font-weight:700;color:#0f172a;border-left:4px solid #2563eb;padding-left:10px;">'
            '五、内部维护人待办负载 Top 10'
            f'<a href="{DASHBOARD_URL}#/members" style="float:right;font-size:12px;font-weight:600;color:#2563eb;text-decoration:none;">内部维护人总表 ↗</a>'
            '</div>'
            '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">'
            '<tr style="background:#f1f5f9;color:#334155;text-align:left;font-size:12px;">'
            '<th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;">排名</th>'
            '<th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;">内部维护人</th>'
            '<th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;">仓库分布</th>'
            '<th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;text-align:right;">待处理</th>'
            '<th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;text-align:right;">已超期</th>'
            '<th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;text-align:right;">即将超期</th>'
            '<th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;text-align:right;">未回复</th>'
            '<th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;text-align:right;">含 AI 报告</th>'
            '</tr>'
            f'{"".join(owner_trs)}</table></div>'
        )

    risk_block_html = ''
    if risk_sections_html:
        risk_block_html = (
            '<div style="margin-top:24px;">'
            '<div style="margin-bottom:10px;font-size:15px;font-weight:700;color:#0f172a;border-left:4px solid #dc2626;padding-left:10px;">'
            '四、重点风险待办清单'
            '</div>'
            f'{"".join(risk_sections_html)}</div>'
        )

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(ctx["subject"])}</title>
</head>
<body style="margin:0;padding:20px 12px;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:#0f172a;line-height:1.5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:860px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #cbd5e1;overflow:hidden;box-shadow:0 2px 8px rgba(15,23,42,0.06);">
    <!-- 顶部品牌横幅 -->
    <tr>
      <td style="padding:20px 24px;background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);color:#ffffff;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td>
              <div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#93c5fd;font-weight:700;">CANN ISSUE OBSERVATORY · 闭环监控巡检报告</div>
              <div style="margin-top:4px;font-size:20px;font-weight:800;color:#ffffff;">四仓公共 Issue 态势与 SLA 巡检汇总</div>
              <div style="margin-top:4px;font-size:12px;color:#cbd5e1;">快照时间：{html.escape(ctx["at"])}（北京时间 UTC+8） · 本次新增 <strong>{len(ctx["new_issues"])}</strong> / 更新 <strong>{ctx["changed"]}</strong> / 新评论 <strong>{ctx["new_comments_total"]}</strong> / 新 AI 报告 <strong>{ctx["new_reports_total"]}</strong></div>
            </td>
            <td align="right" valign="top" style="white-space:nowrap;">
              <a href="{DASHBOARD_URL}" style="display:inline-block;padding:8px 14px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:12px;font-weight:600;">打开监控看板 ↗</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- 快捷导航栏 -->
    <tr>
      <td style="padding:10px 24px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:12px;color:#475569;">
        <strong>快捷直达：</strong>
        <a href="{DASHBOARD_URL}#/dashboard" style="color:#2563eb;text-decoration:none;margin-right:12px;">运行总览</a>
        <a href="{DASHBOARD_URL}#/issues" style="color:#2563eb;text-decoration:none;margin-right:12px;">Issue 工作台</a>
        <a href="{DASHBOARD_URL}#/members" style="color:#2563eb;text-decoration:none;margin-right:12px;">内部维护人总表</a>
        <a href="{DASHBOARD_URL}#/duty" style="color:#2563eb;text-decoration:none;margin-right:12px;">GE 责任田查询</a>
        <a href="{DASHBOARD_URL}#/issues?state=open&amp;internal=missing" style="color:#d97706;text-decoration:none;font-weight:600;margin-right:12px;">未分配内部维护人 ({counts["no_internal_assignee"]})</a>
        <a href="{DASHBOARD_URL}#/issues?state=open&amp;risk=overdue" style="color:#dc2626;text-decoration:none;font-weight:600;">已超期 ({counts["overdue"]})</a>
      </td>
    </tr>

    <!-- 主体内容 -->
    <tr>
      <td style="padding:20px 24px;">
        {"".join(alert_banners)}

        <!-- 一、全局概况与官方 SLA 核心指标 -->
        <div style="margin-bottom:10px;font-size:15px;font-weight:700;color:#0f172a;border-left:4px solid #2563eb;padding-left:10px;">
          一、全局概况与官方 SLA 核心指标
        </div>
        <div style="margin-bottom:12px;font-size:12px;color:#64748b;">
          统计口径：剔除中国大陆法定节假日及周末，首次响应排除自处理（<strong>{sla["excluded_self_processed"]}</strong> 项）及里程碑（<strong>{sla["excluded_milestone"]}</strong> 项）Issue。
        </div>

        <!-- 4 列 SLA 卡片 -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:8px 0;margin:0 -8px 12px -8px;">
          <tr>
            <td width="25%" valign="top" style="padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
              <div style="font-size:12px;color:#475569;font-weight:600;">Issue 闭环率 {_badge_html(_rate_status_label(sla["closure_rate"], 90), closure_tone)}</div>
              <div style="margin:6px 0 4px 0;font-size:22px;font-weight:800;color:#0f172a;">{closure_rate_str}</div>
              <div style="font-size:11px;color:#64748b;">已闭环 {sla["closed"]} / 总数 {sla["total"]}<br>平均闭环：{avg_close_str}</div>
            </td>
            <td width="25%" valign="top" style="padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
              <div style="font-size:12px;color:#475569;font-weight:600;">24h 首响达标率 {_badge_html(_rate_status_label(sla["first_resp_qualified_rate"], 80), resp_tone)}</div>
              <div style="margin:6px 0 4px 0;font-size:22px;font-weight:800;color:#0f172a;">{first_resp_rate_str}</div>
              <div style="font-size:11px;color:#64748b;">达标 {sla["first_resp_qualified_num"]} / 样本 {sla["resp_eligible_total"]}<br>平均首响：{avg_resp_str}</div>
            </td>
            <td width="25%" valign="top" style="padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
              <div style="font-size:12px;color:#475569;font-weight:600;">首次响应未达标数 {_badge_html("有效样本池", unqual_tone)}</div>
              <div style="margin:6px 0 4px 0;font-size:22px;font-weight:800;color:{"#dc2626" if sla["first_resp_unqualified_num"] > 0 else "#15803d"};">{sla["first_resp_unqualified_num"]}</div>
              <div style="font-size:11px;color:#64748b;">首响 &gt;24h 或未响应停留 &gt;24h<br><a href="{DASHBOARD_URL}#/issues?state=all&amp;first_resp=unqualified" style="color:#2563eb;text-decoration:none;">查看未达标明细 ↗</a></div>
            </td>
            <td width="25%" valign="top" style="padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
              <div style="font-size:12px;color:#475569;font-weight:600;">开启未响应超时 / 总数 {_badge_html("Open 未响应", timeout_tone)}</div>
              <div style="margin:6px 0 4px 0;font-size:22px;font-weight:800;color:{"#d97706" if sla["open_no_resp_timeout_num"] > 0 else "#15803d"};">{sla["open_no_resp_timeout_num"]} <span style="font-size:14px;font-weight:600;color:#64748b;">/ {sla["open_no_resp_total"]}</span></div>
              <div style="font-size:11px;color:#64748b;">Open 未响应且停留 &gt;24h 工作日<br><a href="{DASHBOARD_URL}#/issues?state=open&amp;first_resp=open_timeout" style="color:#2563eb;text-decoration:none;">查看超时 Issue ↗</a></div>
            </td>
          </tr>
        </table>

        <!-- 待关注风险指标条 -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;font-size:12px;">
          <tr>
            <td><strong>全量分布：</strong>共 <strong>{len(ctx["rows"])}</strong> · 待处理 <strong style="color:#1d4ed8;">{counts["open"]}</strong> · 已关闭 <strong style="color:#15803d;">{counts["closed"]}</strong> · 含 AI 报告 <strong style="color:#6d28d9;">{counts["has_report"]}</strong></td>
            <td align="right">
              <strong>风险预警：</strong>
              已超期 <strong style="color:#dc2626;">{counts["overdue"]}</strong> ·
              即将超期 <strong style="color:#d97706;">{counts["due_soon"]}</strong> ·
              未获维护人回复 <strong style="color:#b45309;">{counts["unreplied"]}</strong> ·
              未分配内部维护人 <strong style="color:#dc2626;">{counts["no_internal_assignee"]}</strong> ·
              未分配责任人 <strong>{counts["unassigned"]}</strong>
            </td>
          </tr>
        </table>

        <!-- 二、分仓多维明细表 -->
        <div style="margin-top:24px;">
          <div style="margin-bottom:10px;font-size:15px;font-weight:700;color:#0f172a;border-left:4px solid #2563eb;padding-left:10px;">
            二、分仓多维统计明细
          </div>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
            <tr style="background:#f1f5f9;color:#334155;text-align:left;">
              <th style="padding:9px 12px;border-bottom:1px solid #cbd5e1;">仓库</th>
              <th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;text-align:right;">总数</th>
              <th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;text-align:right;">待处理</th>
              <th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;text-align:right;">已关闭</th>
              <th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;text-align:right;">闭环率</th>
              <th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;text-align:right;">24h 首响达标</th>
              <th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;text-align:right;">已超期</th>
              <th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;text-align:right;">即将超期</th>
              <th style="padding:9px 10px;border-bottom:1px solid #cbd5e1;text-align:right;">未回复</th>
              <th style="padding:9px 12px;border-bottom:1px solid #cbd5e1;text-align:right;">未分配内部维护人</th>
            </tr>
            {"".join(repo_tr_list)}
          </table>
        </div>

        <!-- 三、本次扫描变更明细 -->
        <div style="margin-top:24px;">
          <div style="margin-bottom:8px;font-size:15px;font-weight:700;color:#0f172a;border-left:4px solid #2563eb;padding-left:10px;">
            三、本次扫描变更明细
          </div>
          <div style="font-size:12px;color:#475569;">
            本次汇总：新增 Issue <strong>{len(ctx["new_issues"])}</strong> / 更新 <strong>{ctx["changed"]}</strong> / 新闭环 <strong>{len(ctx["newly_closed"])}</strong> / 指派变更 <strong>{len(ctx["assignee_changed"])}</strong> / 新评论 <strong>{ctx["new_comments_total"]}</strong> / 新 AI 报告 <strong>{ctx["new_reports_total"]}</strong>
          </div>
          {"".join(diff_blocks)}
        </div>

        {risk_block_html}
        {owners_html_block}
      </td>
    </tr>

    <!-- 底部栏 -->
    <tr>
      <td style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;text-align:center;">
        CANN Issue 闭环监控系统自动发送 · 看板地址：<a href="{DASHBOARD_URL}" style="color:#2563eb;text-decoration:none;">{DASHBOARD_URL}</a>
      </td>
    </tr>
  </table>
</body>
</html>
"""


def send_report(body, config, env, html_body=None):
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
    if html_body:
        message.add_alternative(html_body, subtype='html', charset='utf-8')
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
    parser.add_argument('--html-output', type=Path, default=None)
    parser.add_argument('--outcome', default='success')
    args = parser.parse_args()
    html_output = args.html_output or args.output.with_suffix('.html')
    if args.send:
        try:
            text_body = args.output.read_text(encoding='utf-8')
            html_body = html_output.read_text(encoding='utf-8') if html_output.exists() else None
            send_report(
                text_body,
                json.loads((ROOT / 'config/mail.json').read_text()),
                os.environ,
                html_body=html_body,
            )
        except (ValueError, OSError, smtplib.SMTPException, RuntimeError) as exc:
            # SMTP responses can contain credentials/addresses; do not log raw server responses.
            print(f'Mail delivery failed ({type(exc).__name__}); check SMTP configuration and service.')
            raise SystemExit(1)
        print('Report delivered to configured recipients.')
    else:
        previous = json.loads(args.previous.read_text()) if args.previous.exists() else {}
        current = json.loads(args.current.read_text())
        body = render(previous, current, args.outcome)
        html_body = render_html(previous, current, args.outcome)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(body, encoding='utf-8')
        html_output.parent.mkdir(parents=True, exist_ok=True)
        html_output.write_text(html_body, encoding='utf-8')
        print(body)


if __name__ == '__main__':
    main()
