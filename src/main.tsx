import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Data, Stats } from "./types";
import { fmt, short, params, go, memberLabel } from "./shared";
import { Chart, Bars, Lines } from "./Charts";
import { IssueList } from "./IssueList";
import { Detail } from "./Detail";
import { exportView } from "./export";
import "./style.css";
import { InternalMembers } from "./InternalMembers";
import { filterOwners } from "./owners";
import { Duty } from "./DutyView";
import { parseDuty, type DutyData } from "./duty";
import { PRDashboard } from "./PRDashboard";
import { PRList } from "./PRList";
import { PRDetail } from "./PRDetail";
import {
  TIME_PRESETS,
  resolveTimeRange,
  filterIssuesByDateRange,
  computeDynamicStats,
  computeOfficialSla,
  toBeijingDateStr,
} from "./sla";
import {
  GRANULARITY_LABELS,
  autoGranularity,
  closureRateTrend,
  createdClosedTrend,
  earliestIssueDay,
  type Granularity,
} from "./trends";

const ExportIcon = () => (
  <svg
    className="btn-icon"
    aria-hidden="true"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M8 2.5v7.5M5 7.2L8 10.2l3-3M3 13h10" />
  </svg>
);

const cards: {
  key: keyof Stats;
  name: string;
  color: string;
  filter: Record<string, string>;
}[] = [
  {
    key: "no_internal_assignee",
    name: "未分配内部维护人",
    color: "amber",
    filter: { internal: "missing" },
  },
  { key: "open", name: "Open Issue", color: "blue", filter: { state: "open" } },
  {
    key: "unassigned",
    name: "未分配责任人",
    color: "amber",
    filter: { assignment: "no" },
  },
  {
    key: "unreplied",
    name: "未获维护人回复",
    color: "amber",
    filter: { reply: "unreplied" },
  },
  { key: "overdue", name: "已超期", color: "red", filter: { risk: "overdue" } },
  {
    key: "due_soon",
    name: "即将超期",
    color: "amber",
    filter: { risk: "soon" },
  },
  {
    key: "closed",
    name: "已关闭",
    color: "green",
    filter: { state: "closed" },
  },
  {
    key: "closure_rate",
    name: "累计闭环率",
    color: "purple",
    filter: { state: "all" },
  },
];

const TREND_PRESETS: { key: string; label: string; days?: number }[] = [
  { key: "1m", label: "近 30 天", days: 30 },
  { key: "3m", label: "近 90 天", days: 90 },
  { key: "6m", label: "近半年", days: 182 },
  { key: "1y", label: "近一年", days: 365 },
  { key: "all", label: "全部" },
  { key: "custom", label: "自定义" },
];
const REPO_COLORS = ["#50a9ff", "#38cdb3", "#fbbf24", "#fb7185", "#a78bfa", "#f472b6"];

function App() {
  const [data, setData] = useState<Data>();
  const [dutyData, setDutyData] = useState<DutyData>();
  const [error, setError] = useState("");
  const [hash, setHash] = useState(location.hash);
  const [ownerSort, setOwnerSort] = useState("open");
  const [ownerSearch, setOwnerSearch] = useState("");
  const view = hash.split("?")[0];
  const needsDuty =
    view.includes("pr-dashboard") ||
    view.includes("/prs") ||
    view.includes("members");

  useEffect(() => {
    const fn = () => setHash(location.hash);
    addEventListener("hashchange", fn);
    fetch("./data/dashboard.json")
      .then((r) => {
        if (!r.ok) throw Error("数据文件暂不可用");
        return r.json();
      })
      .then((d) => {
        if (d.schema_version !== 1) throw Error("不支持的数据版本");
        setData(d);
      })
      .catch((e) => setError(e.message));
    return () => removeEventListener("hashchange", fn);
  }, []);

  useEffect(() => {
    if (!needsDuty || dutyData) return;
    fetch("./data/duty.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => {
        if (v) setDutyData(parseDuty(v));
      })
      .catch(() => {});
  }, [needsDuty, dutyData]);

  if (error)
    return (
      <main>
        <div className="state-box error">
          <h1>数据加载失败</h1>
          <p>{error}</p>
          <button onClick={() => location.reload()}>重试</button>
        </div>
      </main>
    );
  if (!data)
    return (
      <main>
        <div className="state-box">
          <h1>CANN · Issue 闭环监控</h1>
          <p role="status">正在读取同步数据…</p>
        </div>
      </main>
    );
  const all = Object.values(data.repositories).flatMap((r) => r.issues);
  const allPrs = Object.values(data.repositories).flatMap((r) => r.prs || []);
  const issueMap = new Map(all.map((i) => [i.id, i]));
  const p = params();
  const ownerRole = p.get("owner_role") || "";
  const rangePreset = p.get("range") || "";
  const customFrom = p.get("from") || "";
  const customTo = p.get("to") || "";
  const activeRange = resolveTimeRange(
    rangePreset,
    customFrom,
    customTo,
    data.generated_at,
  );
  const hasDateFilter = Boolean(activeRange.from || activeRange.to);
  const dateFilteredAll = filterIssuesByDateRange(
    all,
    activeRange.from,
    activeRange.to,
  );
  const allowedIds = hasDateFilter
    ? new Set(dateFilteredAll.map((i) => i.id))
    : undefined;

  const visibleOwners = filterOwners(data, ownerRole, allowedIds).filter(
    (o) =>
      !ownerSearch.trim() ||
      o.person.login.toLowerCase().includes(ownerSearch.trim().toLowerCase()),
  );
  const selected = all.find((i) => i.id === p.get("id"));
  const selectedPr = allPrs.find((pr) => pr.id === p.get("id"));
  const repo = p.get("repo") || "";
  const scope = repo
    ? dateFilteredAll.filter((i) => i.repo === repo)
    : dateFilteredAll;
  const stat = hasDateFilter
    ? computeDynamicStats(scope)
    : repo
      ? data.repositories[repo]?.stats || data.stats
      : data.stats;
  const sla = computeOfficialSla(scope, data.generated_at);

  const dateDrillParams: Record<string, string> = {
    ...(activeRange.from ? { from: activeRange.from } : {}),
    ...(activeRange.to ? { to: activeRange.to } : {}),
    ...(rangePreset ? { range: rangePreset } : {}),
  };

  const setDashboardParams = (updates: Record<string, string>) => {
    const next = new URLSearchParams(p);
    for (const [k, v] of Object.entries(updates)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    go(Object.fromEntries(next), "dashboard");
  };

  const repoNames = Object.keys(data.repositories);
  const trendRange = p.get("t_range") || "3m";
  const trendTo0 = toBeijingDateStr(data.generated_at);
  const trendPreset = TREND_PRESETS.find((t) => t.key === trendRange);
  const trendEarliest = earliestIssueDay(all) || trendTo0;
  let trendFrom =
    trendRange === "custom"
      ? p.get("t_from") || trendEarliest
      : trendPreset?.days
        ? toBeijingDateStr(
            new Date(
              Date.parse(data.generated_at) - (trendPreset.days - 1) * 86400000,
            ).toISOString(),
          )
        : trendEarliest;
  const trendTo = (trendRange === "custom" && p.get("t_to")) || trendTo0;
  if (trendFrom < trendEarliest) trendFrom = trendEarliest;
  if (trendFrom > trendTo) trendFrom = trendTo;
  const trendGran =
    (p.get("t_gran") as Granularity | null) ||
    autoGranularity(trendFrom, trendTo);

  const ageBins = [
    { name: "≤3 天", min: 0, max: 72 },
    { name: "3–7 天", min: 72, max: 168 },
    { name: "7–11 天", min: 168, max: 264 },
    { name: "11–14 天", min: 264, max: 336 },
    { name: ">14 天", min: 336, max: Infinity },
  ].map((b, n) => ({
    name: b.name,
    count: scope.filter(
      (i) =>
        i.state === "open" &&
        i.metrics.age_hours > b.min - (n === 0 ? 1 : 0) &&
        i.metrics.age_hours <= b.max,
    ).length,
  }));
  const maxOwnerOpen = Math.max(...visibleOwners.map((o) => o.stats.open), 1);
  const isPrDash = view.includes("pr-dashboard");
  const isPrList = !isPrDash && view.includes("/prs");
  return (
    <>
      <header>
        <a className="brand" href="#/dashboard">
          <b className="brand-icon">C</b>
          <span>
            CANN <em>ISSUE OBSERVATORY</em>
          </span>
        </a>
        <nav>
          <a
            className={
              !view.includes("issues") &&
              !isPrDash &&
              !isPrList &&
              !view.includes("members") &&
              !view.includes("duty")
                ? "active"
                : ""
            }
            href="#/dashboard"
          >
            Issue数据总览
          </a>
          <a
            className={view.includes("issues") ? "active" : ""}
            href="#/issues"
          >
            Issue详情
          </a>
          <a
            className={isPrDash ? "active" : ""}
            href="#/pr-dashboard"
          >
            PR数据总览
          </a>
          <a
            className={isPrList ? "active" : ""}
            href="#/prs"
          >
            PR详情
          </a>
          <a
            href="#/members"
            className={view.includes("members") ? "active" : ""}
          >
            内部维护人总表
          </a>
          <a href="#/duty" className={view.includes("duty") ? "active" : ""}>
            责任田查询
          </a>
        </nav>
        <span className="live">
          <i /> 北京时间 UTC+8
        </span>
      </header>
      <main>
        <div className="heading">
          <div>
            <p className="eyebrow">COMMUNITY OPERATIONS / 闭环监控</p>
            <h1>
              {view.includes("duty")
                ? "责任田查询"
                : view.includes("members")
                  ? "内部维护人总表"
                  : isPrDash
                    ? "PR数据总览"
                    : isPrList
                      ? "PR详情"
                      : view.includes("issues")
                        ? "Issue详情"
                        : "Issue数据总览"}
            </h1>
            <p className="muted">
              {isPrDash || isPrList
                ? "四仓外部贡献者 PR · 田主与 Committer 归属 · 关联 Issue 内部维护人 · 24h 首次响应监控"
                : "四仓公共 Issue · 责任归属 · 响应追踪 · 14 天闭环预警"}
            </p>
          </div>
          <div className="heading-actions">
            {!view.includes("issues") && !isPrList && !view.includes("duty") && (
              <button
                className="btn-export"
                data-no-export
                onClick={() =>
                  exportView(
                    view.includes("members")
                      ? "内部维护人总表"
                      : isPrDash
                        ? "PR数据总览"
                        : "Issue数据总览",
                    "main",
                    data.generated_at,
                  )
                }
              >
                <ExportIcon />
                {view.includes("members")
                  ? "导出总表 HTML"
                  : isPrDash
                    ? "导出 PR 总览 HTML"
                    : "导出大屏 HTML"}
              </button>
            )}
            <button
              className="sync"
              onClick={() =>
                go({ state: "all" }, isPrDash || isPrList ? "prs" : "issues")
              }
            >
              最近成功同步
              <br />
              <strong>{fmt(data.last_success)}</strong>
            </button>
          </div>
        </div>
        {(!data.complete || data.errors.length > 0) && (
          <div className="notice red">
            部分数据同步失败，保留上次成功数据。{data.errors.join("；")}
          </div>
        )}
        {Date.now() - Date.parse(data.generated_at) > 86400000 && (
          <div className="notice amber">
            数据已超过 24 小时未刷新，指标按最后采集时刻计算。
          </div>
        )}
        {Object.entries(data.repositories).some(
          ([, r]) => r.warnings?.length > 0,
        ) && (
          <details className="notice amber">
            <summary>数据质量提示：部分成员或评论信息未能确认</summary>
            {Object.entries(data.repositories).flatMap(([n, r]) =>
              (r.warnings || []).map((w) => (
                <p key={n + w}>
                  {n}: {w}
                </p>
              )),
            )}
          </details>
        )}
        {view.includes("duty") ? (
          <Duty />
        ) : view.includes("members") ? (
          <InternalMembers data={data} dutyData={dutyData} />
        ) : isPrDash ? (
          <PRDashboard
            data={data}
            prs={allPrs}
            dutyData={dutyData}
            issueMap={issueMap}
            hash={hash}
          />
        ) : isPrList ? (
          <PRList
            prs={allPrs}
            dutyData={dutyData}
            issueMap={issueMap}
            hash={hash}
            at={data.generated_at}
          />
        ) : view.includes("issues") ? (
          <IssueList issues={all} prs={allPrs} hash={hash} at={data.generated_at} />
        ) : (
          <>
            <section className="panel sla-section overview-panel">
            <div className="toolbar dashboard-bar">
              <div>
                <h2>全局数据概览</h2>
                <p className="muted">
                  统计口径：剔除中国大陆法定节假日及周末，首次响应排除自处理（
                  {sla.excludedSelfProcessed} 项）及里程碑 Issue。
                </p>
              </div>
              <div className="dashboard-filters" data-no-export>
                <div className="time-range-pills" role="group" aria-label="统计时间范围">
                  {TIME_PRESETS.map((tp) => {
                    const isActive =
                      tp.key === "custom"
                        ? rangePreset === "custom" ||
                          (!rangePreset && Boolean(customFrom || customTo))
                        : rangePreset === tp.key && !customFrom && !customTo;
                    return (
                      <button
                        key={tp.key || "all"}
                        type="button"
                        className={`chip-btn ${isActive ? "active" : ""}`}
                        onClick={() => {
                          if (tp.key === "custom") {
                            setDashboardParams({ range: "custom" });
                          } else {
                            setDashboardParams({
                              range: tp.key,
                              from: "",
                              to: "",
                            });
                          }
                        }}
                      >
                        {tp.label}
                      </button>
                    );
                  })}
                </div>
                {(rangePreset === "custom" || customFrom || customTo) && (
                  <div className="custom-date-inline">
                    <input
                      type="date"
                      aria-label="统计起始日期"
                      className={customFrom ? "active-filter" : ""}
                      value={customFrom}
                      onChange={(e) =>
                        setDashboardParams({
                          range: "custom",
                          from: e.target.value,
                        })
                      }
                    />
                    <span className="muted">至</span>
                    <input
                      type="date"
                      aria-label="统计结束日期"
                      className={customTo ? "active-filter" : ""}
                      value={customTo}
                      onChange={(e) =>
                        setDashboardParams({
                          range: "custom",
                          to: e.target.value,
                        })
                      }
                    />
                  </div>
                )}
                <select
                  aria-label="总览仓库"
                  className={repo ? "active-filter" : ""}
                  value={repo}
                  onChange={(e) =>
                    setDashboardParams({ repo: e.target.value })
                  }
                >
                  <option value="">全部仓库</option>
                  {Object.keys(data.repositories).map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </div>
            </div>
            <p className="muted overview-period">
              当前统计周期：<strong>{activeRange.label}</strong>（共 {scope.length}{" "}
              条 Issue） · 回复身份无法确认：{stat.unknown} 项（不计入未回复） ·
              快照计算于 {fmt(data.generated_at)}。
            </p>
            <h3 className="overview-group-title">SLA 核心指标</h3>
              <div className="sla-cards">
                <button
                  type="button"
                  className={`metric sla-card ${sla.closureColor}`}
                  onClick={() =>
                    go({
                      state: "closed",
                      ...(repo ? { repo } : {}),
                      ...dateDrillParams,
                    })
                  }
                >
                  <div className="sla-card-head">
                    <span>Issue 闭环率</span>
                    <em className={`tag ${sla.closureColor}`}>
                      {sla.closureRate === null
                        ? "无数据"
                        : sla.closureRate >= 90
                          ? "达标 ≥90%"
                          : sla.closureRate >= 50
                            ? "预警 50%~90%"
                            : "低于 50%"}
                    </em>
                  </div>
                  <strong>
                    {sla.closureRate !== null ? `${sla.closureRate}%` : "—"}
                  </strong>
                  <small>
                    已闭环 {sla.closed} / 总数 {sla.total} · 查看已闭环 ↗
                  </small>
                </button>

                <button
                  type="button"
                  className={`metric sla-card ${sla.firstRespColor}`}
                  onClick={() =>
                    go({
                      state: "all",
                      first_resp: "qualified",
                      ...(repo ? { repo } : {}),
                      ...dateDrillParams,
                    })
                  }
                >
                  <div className="sla-card-head">
                    <span>首次响应达标率</span>
                    <em className={`tag ${sla.firstRespColor}`}>
                      {sla.firstRespQualifiedRate === null
                        ? "无数据"
                        : sla.firstRespQualifiedRate >= 80
                          ? "达标 ≥80%"
                          : sla.firstRespQualifiedRate >= 50
                            ? "预警 50%~80%"
                            : "低于 50%"}
                    </em>
                  </div>
                  <strong>
                    {sla.firstRespQualifiedRate !== null
                      ? `${sla.firstRespQualifiedRate}%`
                      : "—"}
                  </strong>
                  <small>
                    ≤24h 工作日 · 达标 {sla.firstRespQualifiedNum} / {" "}
                    {sla.respEligibleTotal} · 查看达标 ↗
                  </small>
                </button>

                <button
                  type="button"
                  className={`metric sla-card ${sla.firstRespUnqualifiedNum > 0 ? "red" : "green"}`}
                  onClick={() =>
                    go({
                      state: "all",
                      first_resp: "unqualified",
                      ...(repo ? { repo } : {}),
                      ...dateDrillParams,
                    })
                  }
                >
                  <div className="sla-card-head">
                    <span>首次响应未达标数</span>
                    <em className="tag">有效样本池</em>
                  </div>
                  <strong>{sla.firstRespUnqualifiedNum}</strong>
                  <small>
                    首响 &gt;24h 或未响应停留 &gt;24h · 查看明细 ↗
                  </small>
                </button>

                <button
                  type="button"
                  className={`metric sla-card ${sla.openNoRespTimeoutNum > 0 ? "amber" : "green"}`}
                  onClick={() =>
                    go({
                      state: "open",
                      first_resp: "open_timeout",
                      ...(repo ? { repo } : {}),
                      ...dateDrillParams,
                    })
                  }
                >
                  <div className="sla-card-head">
                    <span>开启未响应超时 / 总数</span>
                    <em className="tag">Open 未响应</em>
                  </div>
                  <strong>
                    {sla.openNoRespTimeoutNum}{" "}
                    <small className="fraction-inline">
                      / {sla.openNoRespTotal}
                    </small>
                  </strong>
                  <small>开启未响应且停留 &gt;24h 工作日 · 查看 ↗</small>
                </button>

                <div className="metric sla-card static-card blue">
                  <div className="sla-card-head">
                    <span>平均首次响应时长</span>
                    <em className="tag blue">有效工作日</em>
                  </div>
                  <strong>
                    {sla.avgFirstRespHours !== null
                      ? `${sla.avgFirstRespHours}h`
                      : "—"}
                  </strong>
                  <small>非创建者真实用户首条评论平均耗时</small>
                </div>

                <div className="metric sla-card static-card purple">
                  <div className="sla-card-head">
                    <span>平均闭环时长</span>
                    <em className="tag purple">有效工作日</em>
                  </div>
                  <strong>
                    {sla.avgCloseDays !== null ? `${sla.avgCloseDays}d` : "—"}
                  </strong>
                  <small>已闭环 Issue 从创建至关闭平均工作日天数</small>
                </div>
              </div>

            <h3 className="overview-group-title">Issue 处理状态</h3>
            <div className="status-strip">
              {cards
                .filter((c) => c.key !== "closure_rate")
                .map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={`status-item ${c.color}`}
                    onClick={() =>
                      go({
                        ...c.filter,
                        ...(repo ? { repo } : {}),
                        ...dateDrillParams,
                      })
                    }
                  >
                    <span>{c.name}</span>
                    <strong>{stat[c.key] ?? "—"}</strong>
                    <small>查看 Issue ↗</small>
                  </button>
                ))}
            </div>

              <details className="sla-rules-box">
                <summary>📖 统计规则说明</summary>
                <div className="sla-rules-grid">
                  <div>
                    <h4>1. Issue 闭环率 & 平均闭环时长</h4>
                    <p>
                      <strong>计算公式</strong>：统计周期内，
                      <code>已闭环 Issue 数量 ÷ 全部 Issue 数量 × 100%</code>。
                    </p>
                    <p>
                      <strong>官方健康度阈值</strong>：
                      <span className="tag blue">蓝色 ≥ 90%</span>{" "}
                      <span className="tag amber">橙色 50% ~ 90%</span>{" "}
                      <span className="tag red">红色 &lt; 50%</span>。
                    </p>
                    <p>
                      <strong>平均闭环时长(D)</strong>：已闭环 Issue 从创建到关闭的有效工作日间隔均值（剔除中国大陆法定节假日及周末）。
                    </p>
                  </div>
                  <div>
                    <h4>2. 首次响应达标率 & 首次响应未达标数</h4>
                    <p>
                      <strong>达标判定</strong>：统计周期内，Issue 从创建完成到收到
                      <strong>非创建者（真实用户，排除机器人）</strong>
                      首条评论的时长 <code>≤ 24 小时</code>，或虽未响应但停留时长{" "}
                      <code>≤ 24 小时</code>，即视为首次响应达标。
                    </p>
                    <p>
                      <strong>官方健康度阈值</strong>：
                      <span className="tag blue">蓝色 ≥ 80%</span>{" "}
                      <span className="tag amber">橙色 50% ~ 80%</span>{" "}
                      <span className="tag red">红色 &lt; 50%</span>。
                    </p>
                    <p>
                      <strong>未达标条件</strong>：① 首次响应有效工作日时长{" "}
                      <code>&gt; 24 小时</code>；或 ② 未响应且有效工作日停留时长{" "}
                      <code>&gt; 24 小时</code>。
                    </p>
                  </div>
                  <div>
                    <h4>3. 样本排除与有效工作日计时规则</h4>
                    <p>
                      <strong>排除自处理与里程碑</strong>：首次响应相关指标自动排除
                      <strong>自处理 Issue</strong>（Issue 创建者与当前任意一位责任人为同一用户）和
                      <strong>里程碑（Milestone）类型 Issue</strong>。
                    </p>
                    <p>
                      <strong>有效工作日计时</strong>：所有时长计算均按北京时间（UTC+8）自动剔除
                      <strong>中国大陆法定节假日及周末</strong>（含国务院调休补班日历校准），仅累计有效工作日时长。
                    </p>
                  </div>
                </div>
              </details>
            </section>

            <div className="grid three">
              <Chart title="Issue 开启和关闭数量">
                <Bars
                  data={Object.entries(data.repositories).map(([name, r]) => {
                    const rIssues = hasDateFilter
                      ? filterIssuesByDateRange(
                          r.issues,
                          activeRange.from,
                          activeRange.to,
                        )
                      : r.issues;
                    const rStats = hasDateFilter
                      ? computeDynamicStats(rIssues)
                      : r.stats;
                    return {
                      name: short(name),
                      open: rStats.open,
                      closed: rStats.closed,
                    };
                  })}
                  keys={[
                    { key: "open", name: "开启", color: "#50a9ff" },
                    { key: "closed", name: "已关闭", color: "#38cdb3" },
                  ]}
                />
              </Chart>
              <Chart title="未关闭 Issue 时长">
                <Bars
                  data={ageBins}
                  keys={[{ key: "count", name: "Issue 数", color: "#38cdb3" }]}
                />
              </Chart>
              <Chart
                title="未关闭 Issue 回复状态"
                note="维护人回复独立于指派和超期状态，三项按回复状态互斥。"
              >
                <Bars
                  data={[
                    {
                      name: "已回复",
                      count: scope.filter(
                        (i) =>
                          i.state === "open" && i.reply_status === "replied",
                      ).length,
                    },
                    { name: "未回复", count: stat.unreplied },
                    { name: "无法确认", count: stat.unknown },
                  ]}
                  keys={[{ key: "count", name: "Issue 数", color: "#a78bfa" }]}
                />
              </Chart>
            </div>
            <section className="panel">
              <h2>仓库闭环概览</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {[
                        "仓库",
                        "未分配内部维护人",
                        "Open",
                        "未分配",
                        "未回复",
                        "超期",
                        "即将超期",
                        "Closed",
                        "闭环率",
                        "首次响应达标率",
                        "平均首响(H)",
                        "成功同步",
                      ].map((x) => (
                        <th key={x}>{x}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.repositories).map(([name, r]) => {
                      const rIssues = hasDateFilter
                        ? filterIssuesByDateRange(
                            r.issues,
                            activeRange.from,
                            activeRange.to,
                          )
                        : r.issues;
                      const rStats = hasDateFilter
                        ? computeDynamicStats(rIssues)
                        : r.stats;
                      const rSla = computeOfficialSla(
                        rIssues,
                        data.generated_at,
                      );
                      return (
                        <tr key={name}>
                          <td>
                            <button
                              className="text repo-link"
                              onClick={() =>
                                go({ repo: name, ...dateDrillParams })
                              }
                            >
                              {short(name)}
                            </button>
                          </td>
                          {cards.slice(0, 7).map((c) => {
                            const val = rStats[c.key];
                            const isZeroRisk =
                              val === 0 &&
                              (c.color === "red" || c.color === "amber");
                            return (
                              <td key={c.key}>
                                <button
                                  className={`text ${isZeroRisk ? "zero" : c.color}`}
                                  onClick={() =>
                                    go({
                                      repo: name,
                                      ...c.filter,
                                      ...dateDrillParams,
                                    })
                                  }
                                >
                                  {val}
                                </button>
                              </td>
                            );
                          })}
                          <td>
                            <div className="rate-cell">
                              <span className={rSla.closureColor}>
                                {rStats.closure_rate ?? "—"}%
                              </span>
                              {rStats.closure_rate !== null && (
                                <span className="mini-bar" aria-hidden="true">
                                  <i
                                    style={{
                                      width: `${rStats.closure_rate}%`,
                                    }}
                                  />
                                </span>
                              )}
                            </div>
                          </td>
                          <td>
                            <button
                              className={`text ${rSla.firstRespColor}`}
                              onClick={() =>
                                go({
                                  repo: name,
                                  state: "all",
                                  first_resp: "qualified",
                                  ...dateDrillParams,
                                })
                              }
                            >
                              {rSla.firstRespQualifiedRate !== null
                                ? `${rSla.firstRespQualifiedRate}%`
                                : "—"}
                              <small className="muted">
                                {rSla.firstRespQualifiedNum}/
                                {rSla.respEligibleTotal}
                              </small>
                            </button>
                          </td>
                          <td>
                            {rSla.avgFirstRespHours !== null
                              ? `${rSla.avgFirstRespHours}h`
                              : "—"}
                          </td>
                          <td className="muted">{fmt(r.last_success)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="panel trend-panel">
              <div className="toolbar trend-bar">
                <h2>
                  Issue 趋势{" "}
                  <span className="muted trend-range-label">
                    {trendFrom} ~ {trendTo} · {GRANULARITY_LABELS[trendGran]}
                  </span>
                </h2>
                <div className="dashboard-filters" data-no-export>
                  <div
                    className="time-range-pills"
                    role="group"
                    aria-label="趋势统计区间"
                  >
                    {TREND_PRESETS.map((tp) => (
                      <button
                        key={tp.key}
                        type="button"
                        className={`chip-btn ${trendRange === tp.key ? "active" : ""}`}
                        onClick={() =>
                          setDashboardParams(
                            tp.key === "custom"
                              ? {
                                  t_range: "custom",
                                  t_from: trendFrom,
                                  t_to: trendTo,
                                }
                              : { t_range: tp.key, t_from: "", t_to: "" },
                          )
                        }
                      >
                        {tp.label}
                      </button>
                    ))}
                  </div>
                  {trendRange === "custom" && (
                    <div className="custom-date-inline">
                      <input
                        type="date"
                        aria-label="趋势起始日期"
                        value={trendFrom}
                        max={trendTo}
                        onChange={(e) =>
                          setDashboardParams({
                            t_range: "custom",
                            t_from: e.target.value,
                          })
                        }
                      />
                      <span className="muted">至</span>
                      <input
                        type="date"
                        aria-label="趋势结束日期"
                        value={trendTo}
                        min={trendFrom}
                        onChange={(e) =>
                          setDashboardParams({
                            t_range: "custom",
                            t_to: e.target.value,
                          })
                        }
                      />
                    </div>
                  )}
                  <select
                    aria-label="趋势统计粒度"
                    value={p.get("t_gran") || ""}
                    onChange={(e) =>
                      setDashboardParams({ t_gran: e.target.value })
                    }
                  >
                    <option value="">
                      自动（{GRANULARITY_LABELS[autoGranularity(trendFrom, trendTo)]}）
                    </option>
                    <option value="day">按日</option>
                    <option value="week">按周</option>
                    <option value="month">按月</option>
                  </select>
                </div>
              </div>
              <div className="grid two">
                <Chart
                  title="Issue 创建与关闭趋势"
                  note={`${repo ? short(repo) : "全部仓库"}；按北京时间 created_at / closed_at 统计，关闭为当前 Closed Issue 的最终关闭日期。`}
                >
                  <Lines
                    data={createdClosedTrend(
                      repo ? all.filter((i) => i.repo === repo) : all,
                      trendFrom,
                      trendTo,
                      trendGran,
                    )}
                    keys={[
                      { key: "created", name: "创建", color: "#50a9ff" },
                      { key: "closed", name: "关闭", color: "#38cdb3" },
                    ]}
                  />
                </Chart>
                <Chart
                  title="Issue 闭环率趋势"
                  note="截至各时间点的累计闭环率 = 该时间点前创建且已关闭的 Issue ÷ 该时间点前创建的 Issue 总数；总体与分仓库对比。"
                >
                  <Lines
                    percent
                    data={closureRateTrend(
                      all,
                      repoNames,
                      trendFrom,
                      trendTo,
                      trendGran,
                    )}
                    keys={[
                      { key: "all", name: "总体", color: "#e2ecfc", width: 3 },
                      ...repoNames.map((name, n) => ({
                        key: name,
                        name: short(name),
                        color: REPO_COLORS[n % REPO_COLORS.length],
                        width: 1.8,
                      })),
                    ]}
                  />
                </Chart>
              </div>
            </section>
            <section className="panel">
              <div className="toolbar">
                <h2>
                  责任人名下 Issue 数量{" "}
                  <span className="count">{visibleOwners.length}</span>
                </h2>
                <div className="owner-controls">
                  <input
                    aria-label="搜索责任人"
                    placeholder="过滤责任人用户名…"
                    value={ownerSearch}
                    onChange={(e) => setOwnerSearch(e.target.value)}
                  />
                  <select
                    aria-label="责任人类型"
                    className={ownerRole ? "active-filter" : ""}
                    value={ownerRole}
                    onChange={(e) => {
                      e.target.value
                        ? p.set("owner_role", e.target.value)
                        : p.delete("owner_role");
                      go(Object.fromEntries(p), "dashboard");
                    }}
                  >
                    <option value="">全部</option>
                    <option value="internal">内部维护人</option>
                    <option value="external">外部开发者</option>
                  </select>
                  <select
                    aria-label="责任人排序"
                    value={ownerSort}
                    onChange={(e) => setOwnerSort(e.target.value)}
                  >
                    <option value="open">按 Open 数量</option>
                    <option value="overdue">按超期数量</option>
                    <option value="due_soon">按即将超期</option>
                  </select>
                </div>
              </div>
              <p className="muted">
                每条 Open Issue
                仅计入首位内部维护人；无内部成员时计入首位责任人。顺序以 GitCode
                Assignee 列表为准，人员合计等于 Open
                总数。内部身份采用四仓成员并集及人工补充总表，跨仓统一认定。
              </p>
              {!visibleOwners.length && (
                <p className="empty">当前筛选下没有责任人</p>
              )}
              <div className="owner-grid">
                {[...visibleOwners]
                  .sort(
                    (a, b) =>
                      Number(b.stats[ownerSort as keyof Stats]) -
                      Number(a.stats[ownerSort as keyof Stats]),
                  )
                  .map((o) => {
                    const normalPct = (o.stats.normal / maxOwnerOpen) * 100;
                    const soonPct = (o.stats.due_soon / maxOwnerOpen) * 100;
                    const overduePct = (o.stats.overdue / maxOwnerOpen) * 100;
                    return (
                      <button
                        key={o.person.login}
                        className="owner"
                        onClick={() =>
                          go({
                            workload_owner: o.person.login,
                            ...(ownerRole ? { workload_role: ownerRole } : {}),
                            ...dateDrillParams,
                          })
                        }
                      >
                        <div className="owner-name">
                          {o.person.avatar ? (
                            <img
                              src={o.person.avatar}
                              alt=""
                              loading="lazy"
                              onError={(e) => {
                                e.currentTarget.style.display = "none";
                              }}
                            />
                          ) : (
                            <b className="avatar">
                              {o.person.login.slice(0, 1).toUpperCase()}
                            </b>
                          )}
                          <strong>{o.person.login}</strong>
                          <span
                            className={`tag ${o.role === "external" ? "amber" : "blue"}`}
                          >
                            {memberLabel[o.role] || memberLabel.unknown}
                          </span>
                          <b>{o.stats.open}</b>
                        </div>
                        <div className="workbar" aria-hidden="true">
                          {normalPct > 0 && (
                            <i
                              className="seg-normal"
                              style={{ width: `${normalPct}%` }}
                            />
                          )}
                          {soonPct > 0 && (
                            <i
                              className="seg-soon"
                              style={{ width: `${soonPct}%` }}
                            />
                          )}
                          {overduePct > 0 && (
                            <i
                              className="seg-overdue"
                              style={{ width: `${overduePct}%` }}
                            />
                          )}
                        </div>
                        <div className="tags">
                          <span className="green">正常 {o.stats.normal}</span>
                          <span
                            className={
                              o.stats.unreplied || o.stats.due_soon
                                ? "amber"
                                : "muted"
                            }
                          >
                            未回复 {o.stats.unreplied} · 临期 {o.stats.due_soon}
                          </span>
                          <span className={o.stats.overdue ? "red" : "muted"}>
                            超期 {o.stats.overdue}
                          </span>
                        </div>
                        <small>
                          {Object.entries(o.repos)
                            .map(([r, n]) => `${short(r)} ${n}`)
                            .join(" / ")}
                        </small>
                      </button>
                    );
                  })}
              </div>
            </section>
          </>
        )}
        <footer>
          GitCode 是 Issue 状态的唯一事实来源 · AI 报告仅供辅助分析 ·{" "}
          <a
            href="https://github.com/KennChow/cann-radar"
            target="_blank"
            rel="noreferrer"
          >
            设计参考 cann-radar
          </a>
        </footer>
      </main>
      {selected && (
        <Detail
          issue={selected}
          prs={allPrs}
          issues={all}
          at={data.generated_at}
          onSelect={(id) => {
            p.set("id", id);
            go(Object.fromEntries(p));
          }}
          close={() => {
            p.delete("id");
            go(Object.fromEntries(p));
          }}
        />
      )}
      {selectedPr && (
        <PRDetail
          pr={selectedPr}
          prs={allPrs}
          dutyData={dutyData}
          issueMap={issueMap}
          at={data.generated_at}
          onSelect={(id) => {
            p.set("id", id);
            go(Object.fromEntries(p), "prs");
          }}
          close={() => {
            p.delete("id");
            go(Object.fromEntries(p), "prs");
          }}
        />
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
