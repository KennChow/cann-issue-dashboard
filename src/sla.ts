import type { Issue, Stats } from "./types";

const BJT_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

// 中国大陆国务院办公厅法定节假日（休假）与调休补班日（2024 - 2026）
const CN_HOLIDAYS = new Set([
  // 2024
  "2024-01-01",
  "2024-02-10", "2024-02-11", "2024-02-12", "2024-02-13", "2024-02-14", "2024-02-15", "2024-02-16", "2024-02-17",
  "2024-04-04", "2024-04-05", "2024-04-06",
  "2024-05-01", "2024-05-02", "2024-05-03", "2024-05-04", "2024-05-05",
  "2024-06-08", "2024-06-09", "2024-06-10",
  "2024-09-15", "2024-09-16", "2024-09-17",
  "2024-10-01", "2024-10-02", "2024-10-03", "2024-10-04", "2024-10-05", "2024-10-06", "2024-10-07",
  // 2025
  "2025-01-01",
  "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31", "2025-02-01", "2025-02-02", "2025-02-03", "2025-02-04",
  "2025-04-04", "2025-04-05", "2025-04-06",
  "2025-05-01", "2025-05-02", "2025-05-03", "2025-05-04", "2025-05-05",
  "2025-05-31", "2025-06-01", "2025-06-02",
  "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-04", "2025-10-05", "2025-10-06", "2025-10-07", "2025-10-08",
  // 2026
  "2026-01-01", "2026-01-02", "2026-01-03",
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  "2026-04-04", "2026-04-05", "2026-04-06",
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  "2026-06-19", "2026-06-20", "2026-06-21",
  "2026-09-25", "2026-09-26", "2026-09-27",
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07",
]);

const CN_MAKEUP_WORKDAYS = new Set([
  // 2024
  "2024-02-04", "2024-02-18", "2024-04-07", "2024-04-28", "2024-05-11", "2024-09-14", "2024-09-29", "2024-10-12",
  // 2025
  "2025-01-26", "2025-02-08", "2025-04-27", "2025-09-28", "2025-10-11",
  // 2026
  "2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10",
]);

const BOT_LOGINS = new Set(["cann-robot", "gitcode-bot", "openeuler-ci-bot", "ascend-robot"]);

export function toBeijingDateStr(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms + BJT_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isCnWorkday(bjtDayIndex: number): boolean {
  const d = new Date(bjtDayIndex * DAY_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const dateStr = `${y}-${m}-${day}`;
  if (CN_MAKEUP_WORKDAYS.has(dateStr)) return true;
  if (CN_HOLIDAYS.has(dateStr)) return false;
  const dow = d.getUTCDay();
  return dow !== 0 && dow !== 6;
}

/**
 * 计算两个时间点之间的有效工作日小时数（自动剔除中国大陆法定节假日及周末）
 */
export function workdayHours(startIso: string, endIso: string): number {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return 0;

  const bjtStart = startMs + BJT_OFFSET_MS;
  const bjtEnd = endMs + BJT_OFFSET_MS;
  const startDay = Math.floor(bjtStart / DAY_MS);
  const endDay = Math.floor(bjtEnd / DAY_MS);

  let validMs = 0;
  for (let day = startDay; day <= endDay; day++) {
    if (!isCnWorkday(day)) continue;
    const segStart = Math.max(bjtStart, day * DAY_MS);
    const segEnd = Math.min(bjtEnd, (day + 1) * DAY_MS);
    if (segEnd > segStart) validMs += segEnd - segStart;
  }
  return validMs / 3600000;
}

export type IssueSlaDetail = {
  isSelfProcessed: boolean;
  isMilestone: boolean;
  excludedFromRespSla: boolean;
  firstHumanReplyAt: string | null;
  firstRespWorkHours: number | null;
  stayWorkHours: number;
  closeWorkDays: number | null;
  firstRespQualified: boolean;
  firstRespUnqualified: boolean;
  openNoResp: boolean;
  openNoRespTimeout: boolean;
};

export function evaluateIssueSla(issue: Issue, snapshotIso: string): IssueSlaDetail {
  const authorLogin = (issue.author?.login || "").toLowerCase();
  const isSelfProcessed =
    Boolean(authorLogin) &&
    issue.assignees.some((a) => a.login.toLowerCase() === authorLogin);
  const isMilestone =
    issue.source_status?.toLowerCase().includes("milestone") ||
    issue.source_status?.includes("里程碑") ||
    issue.labels.some(
      (l) => l.toLowerCase().includes("milestone") || l.includes("里程碑"),
    );
  const excludedFromRespSla = isSelfProcessed || isMilestone;

  const createdMs = Date.parse(issue.created_at);
  let firstHumanReplyAt: string | null = null;
  for (const c of issue.comments || []) {
    if (c.system) continue;
    const body = (c.body || "").trim();
    if (!body || body.startsWith("/")) continue;
    const commenter = (c.author?.login || "").toLowerCase();
    if (!commenter || commenter === authorLogin) continue;
    if (BOT_LOGINS.has(commenter) || commenter.endsWith("[bot]") || commenter.endsWith("-bot")) {
      continue;
    }
    if (Date.parse(c.created_at) >= createdMs) {
      firstHumanReplyAt = c.created_at;
      break;
    }
  }
  if (!firstHumanReplyAt && issue.first_reply_at) {
    firstHumanReplyAt = issue.first_reply_at;
  }

  const endIso = issue.closed_at || snapshotIso;
  const stayWorkHours = workdayHours(issue.created_at, endIso);
  const firstRespWorkHours = firstHumanReplyAt
    ? workdayHours(issue.created_at, firstHumanReplyAt)
    : null;
  const closeWorkDays =
    issue.state === "closed" && issue.closed_at
      ? workdayHours(issue.created_at, issue.closed_at) / 24
      : null;

  const firstRespQualified = !excludedFromRespSla
    ? firstRespWorkHours !== null
      ? firstRespWorkHours <= 24
      : stayWorkHours <= 24
    : false;
  const firstRespUnqualified = !excludedFromRespSla && !firstRespQualified;
  const openNoResp =
    !excludedFromRespSla && issue.state === "open" && firstHumanReplyAt === null;
  const openNoRespTimeout = openNoResp && stayWorkHours > 24;

  return {
    isSelfProcessed,
    isMilestone,
    excludedFromRespSla,
    firstHumanReplyAt,
    firstRespWorkHours,
    stayWorkHours,
    closeWorkDays,
    firstRespQualified,
    firstRespUnqualified,
    openNoResp,
    openNoRespTimeout,
  };
}

export type OfficialSlaStats = {
  total: number;
  open: number;
  closed: number;
  closureRate: number | null;
  closureColor: "blue" | "amber" | "red";
  avgCloseDays: number | null;
  respEligibleTotal: number;
  excludedSelfProcessed: number;
  excludedMilestone: number;
  firstRespQualifiedNum: number;
  firstRespUnqualifiedNum: number;
  firstRespQualifiedRate: number | null;
  firstRespColor: "blue" | "amber" | "red";
  avgFirstRespHours: number | null;
  openNoRespTotal: number;
  openNoRespTimeoutNum: number;
};

export function closureRateColor(rate: number | null): "blue" | "amber" | "red" {
  if (rate === null) return "blue";
  if (rate >= 90) return "blue";
  if (rate >= 50) return "amber";
  return "red";
}

export function firstRespRateColor(rate: number | null): "blue" | "amber" | "red" {
  if (rate === null) return "blue";
  if (rate >= 80) return "blue";
  if (rate >= 50) return "amber";
  return "red";
}

export function computeOfficialSla(
  issues: Issue[],
  snapshotIso: string,
): OfficialSlaStats {
  const total = issues.length;
  let open = 0;
  let closed = 0;
  let closeDaysSum = 0;
  let closeDaysCount = 0;

  let respEligibleTotal = 0;
  let excludedSelfProcessed = 0;
  let excludedMilestone = 0;
  let firstRespQualifiedNum = 0;
  let firstRespUnqualifiedNum = 0;
  let firstRespHoursSum = 0;
  let firstRespHoursCount = 0;
  let openNoRespTotal = 0;
  let openNoRespTimeoutNum = 0;

  for (const issue of issues) {
    if (issue.state === "open") open++;
    else if (issue.state === "closed") closed++;

    const sla = evaluateIssueSla(issue, snapshotIso);
    if (sla.closeWorkDays !== null) {
      closeDaysSum += sla.closeWorkDays;
      closeDaysCount++;
    }
    if (sla.isSelfProcessed) excludedSelfProcessed++;
    if (sla.isMilestone) excludedMilestone++;
    if (sla.excludedFromRespSla) continue;

    respEligibleTotal++;
    if (sla.firstRespQualified) firstRespQualifiedNum++;
    else firstRespUnqualifiedNum++;

    if (sla.firstRespWorkHours !== null) {
      firstRespHoursSum += sla.firstRespWorkHours;
      firstRespHoursCount++;
    }
    if (sla.openNoResp) {
      openNoRespTotal++;
      if (sla.openNoRespTimeout) openNoRespTimeoutNum++;
    }
  }

  const closureRate = total > 0 ? Number(((closed / total) * 100).toFixed(2)) : null;
  const firstRespQualifiedRate =
    respEligibleTotal > 0
      ? Number(((firstRespQualifiedNum / respEligibleTotal) * 100).toFixed(2))
      : null;

  return {
    total,
    open,
    closed,
    closureRate,
    closureColor: closureRateColor(closureRate),
    avgCloseDays:
      closeDaysCount > 0 ? Number((closeDaysSum / closeDaysCount).toFixed(1)) : null,
    respEligibleTotal,
    excludedSelfProcessed,
    excludedMilestone,
    firstRespQualifiedNum,
    firstRespUnqualifiedNum,
    firstRespQualifiedRate,
    firstRespColor: firstRespRateColor(firstRespQualifiedRate),
    avgFirstRespHours:
      firstRespHoursCount > 0
        ? Number((firstRespHoursSum / firstRespHoursCount).toFixed(1))
        : null,
    openNoRespTotal,
    openNoRespTimeoutNum,
  };
}

export function computeDynamicStats(issues: Issue[]): Stats {
  const open = issues.filter((i) => i.state === "open").length;
  const closed = issues.filter((i) => i.state === "closed").length;
  const unassigned = issues.filter((i) => i.metrics.unassigned).length;
  const no_internal_assignee = issues.filter(
    (i) => i.metrics.no_internal_assignee,
  ).length;
  const unreplied = issues.filter((i) => i.metrics.unreplied).length;
  const overdue = issues.filter((i) => i.metrics.overdue).length;
  const due_soon = issues.filter((i) => i.metrics.due_soon).length;
  const unknown = issues.filter(
    (i) => i.state === "open" && i.reply_status === "unknown",
  ).length;
  const normal = issues.filter(
    (i) => i.state === "open" && !i.metrics.overdue && !i.metrics.due_soon,
  ).length;
  const has_report = issues.filter((i) => i.metrics.has_report).length;
  const closure_rate = issues.length
    ? Number(((closed / issues.length) * 100).toFixed(2))
    : null;
  return {
    open,
    closed,
    unassigned,
    no_internal_assignee,
    unreplied,
    overdue,
    due_soon,
    unknown,
    normal,
    has_report,
    closure_rate,
  };
}

export type TimePresetKey = "" | "1y" | "3m" | "1m" | "2w" | "1w" | "custom";

export const TIME_PRESETS: { key: TimePresetKey; label: string; days?: number }[] = [
  { key: "", label: "全部时间" },
  { key: "1y", label: "近一年", days: 365 },
  { key: "3m", label: "近三个月", days: 90 },
  { key: "1m", label: "近一个月", days: 30 },
  { key: "2w", label: "近两周", days: 14 },
  { key: "1w", label: "近一周", days: 7 },
  { key: "custom", label: "自定义时间" },
];

export function resolveTimeRange(
  preset: string,
  customFrom: string,
  customTo: string,
  referenceIso: string,
): { from: string; to: string; label: string } {
  if (preset === "custom" || (!preset && (customFrom || customTo))) {
    const label =
      customFrom && customTo
        ? `${customFrom} 至 ${customTo}`
        : customFrom
          ? `自 ${customFrom} 起`
          : customTo
            ? `截至 ${customTo}`
            : "自定义时间";
    return { from: customFrom, to: customTo, label };
  }
  const found = TIME_PRESETS.find((p) => p.key === preset);
  if (!found || !found.days) {
    return { from: "", to: "", label: "全部时间" };
  }
  const refMs = Date.parse(referenceIso) || Date.now();
  const toStr = toBeijingDateStr(new Date(refMs).toISOString());
  const fromStr = toBeijingDateStr(
    new Date(refMs - (found.days - 1) * DAY_MS).toISOString(),
  );
  return { from: fromStr, to: toStr, label: `${found.label}（${fromStr} ~ ${toStr}）` };
}

export function filterIssuesByDateRange(
  issues: Issue[],
  from: string,
  to: string,
): Issue[] {
  if (!from && !to) return issues;
  return issues.filter((i) => {
    const day = toBeijingDateStr(i.created_at);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });
}
