import type { Issue } from "./types";
import { toBeijingDateStr } from "./sla";

export type Granularity = "day" | "week" | "month";

export const GRANULARITY_LABELS: Record<Granularity, string> = {
  day: "按日",
  week: "按周",
  month: "按月",
};

const DAY_MS = 86400000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** 区间跨度超过 62 天按周、超过 370 天按月，避免点位过密。 */
export function autoGranularity(from: string, to: string): Granularity {
  const days = (toMs(to) - toMs(from)) / DAY_MS + 1;
  return days <= 62 ? "day" : days <= 370 ? "week" : "month";
}

function bucketStart(day: string, g: Granularity): string {
  if (g === "day") return day;
  if (g === "month") return `${day.slice(0, 7)}-01`;
  const ms = toMs(day);
  const dow = (new Date(ms).getUTCDay() + 6) % 7; // 周一为一周起点
  return toDay(ms - dow * DAY_MS);
}

function nextBucket(start: string, g: Granularity): string {
  if (g === "day") return toDay(toMs(start) + DAY_MS);
  if (g === "week") return toDay(toMs(start) + 7 * DAY_MS);
  const [y, m] = start.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

function label(start: string, g: Granularity): string {
  return g === "month" ? start.slice(0, 7) : start.slice(5);
}

type Bucket = { start: string; end: string; label: string };

/** 生成 [from, to] 内的统计桶，首尾桶裁剪到区间边界（北京时间日期）。 */
export function buildBuckets(from: string, to: string, g: Granularity): Bucket[] {
  const out: Bucket[] = [];
  if (!from || !to || from > to) return out;
  let s = bucketStart(from, g);
  while (s <= to && out.length < 1000) {
    const n = nextBucket(s, g);
    const lastDay = toDay(toMs(n) - DAY_MS);
    out.push({
      start: s < from ? from : s,
      end: lastDay > to ? to : lastDay,
      label: label(s, g),
    });
    s = n;
  }
  return out;
}

type Norm = { repo: string; created: string; closed: string | null };

function normalize(issues: Issue[]): Norm[] {
  return issues.map((i) => ({
    repo: i.repo,
    created: toBeijingDateStr(i.created_at),
    closed:
      i.state === "closed" && i.closed_at ? toBeijingDateStr(i.closed_at) : null,
  }));
}

export function earliestIssueDay(issues: Issue[]): string {
  let min = "";
  for (const i of issues) {
    const d = toBeijingDateStr(i.created_at);
    if (!min || d < min) min = d;
  }
  return min;
}

/** 每个统计桶内新创建 / 关闭的 Issue 数（关闭以当前 Closed Issue 的 closed_at 为准）。 */
export function createdClosedTrend(
  issues: Issue[],
  from: string,
  to: string,
  g: Granularity,
) {
  const rows = normalize(issues);
  return buildBuckets(from, to, g).map((b) => ({
    date: b.label,
    created: rows.filter((r) => r.created >= b.start && r.created <= b.end)
      .length,
    closed: rows.filter(
      (r) => r.closed && r.closed >= b.start && r.closed <= b.end,
    ).length,
  }));
}

/**
 * 截至每个统计桶末日的累计闭环率：
 * 当日及之前创建且已关闭的 Issue 数 ÷ 当日及之前创建的 Issue 总数。
 * 总体为 "all"，分仓库键为仓库名。
 */
export function closureRateTrend(
  issues: Issue[],
  repos: string[],
  from: string,
  to: string,
  g: Granularity,
) {
  const rows = normalize(issues);
  const rate = (subset: Norm[], end: string) => {
    let total = 0;
    let closed = 0;
    for (const r of subset) {
      if (r.created > end) continue;
      total++;
      if (r.closed && r.closed <= end) closed++;
    }
    return total ? Math.round((closed / total) * 10000) / 100 : null;
  };
  const byRepo = Object.fromEntries(
    repos.map((name) => [name, rows.filter((r) => r.repo === name)]),
  );
  return buildBuckets(from, to, g).map((b) => {
    const point: Record<string, string | number | null> = {
      date: b.label,
      all: rate(rows, b.end),
    };
    for (const name of repos) point[name] = rate(byRepo[name], b.end);
    return point;
  });
}
