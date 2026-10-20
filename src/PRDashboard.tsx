import { useState } from "react";
import type { Data, Issue, PullRequest } from "./types";
import type { DutyData } from "./duty";
import { fmt, short, go } from "./shared";
import { Chart, Bars, Lines } from "./Charts";
import {
  TIME_PRESETS,
  resolveTimeRange,
  toBeijingDateStr,
} from "./sla";
import {
  GRANULARITY_LABELS,
  autoGranularity,
  type Granularity,
} from "./trends";
import {
  PR_ROLE_LABELS,
  computeOfficialPrSla,
  computePrPersonWorkloads,
  earliestPrDay,
  evaluatePrSla,
  filterPrsByDateRange,
  prClosureRateTrend,
  prCreatedClosedTrend,
  type PrRoleKind,
} from "./pr";

const TREND_PRESETS: { key: string; label: string; days?: number }[] = [
  { key: "1m", label: "近 30 天", days: 30 },
  { key: "3m", label: "近 90 天", days: 90 },
  { key: "6m", label: "近半年", days: 182 },
  { key: "1y", label: "近一年", days: 365 },
  { key: "all", label: "全部" },
  { key: "custom", label: "自定义" },
];
const REPO_COLORS = [
  "#50a9ff",
  "#38cdb3",
  "#fbbf24",
  "#fb7185",
  "#a78bfa",
  "#f472b6",
];

export function PRDashboard({
  data,
  prs,
  dutyData,
  issueMap,
  hash,
}: {
  data: Data;
  prs: PullRequest[];
  dutyData?: DutyData;
  issueMap: Map<string, Issue>;
  hash: string;
}) {
  const [personSearch, setPersonSearch] = useState("");
  const [personSort, setPersonSort] = useState<
    "openPrs" | "totalPrs" | "readyPrs" | "unqualifiedPrs"
  >("openPrs");

  const p = new URLSearchParams(hash.split("?")[1] || "");
  const repo = p.get("repo") || "";
  const roleFilter = (p.get("pr_role") || "") as PrRoleKind | "";
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
  const dateFilteredAll = filterPrsByDateRange(
    prs,
    activeRange.from,
    activeRange.to,
  );
  const scope = repo
    ? dateFilteredAll.filter((pr) => pr.repo === repo)
    : dateFilteredAll;
  const sla = computeOfficialPrSla(scope, data.generated_at);

  const dateDrillParams: Record<string, string> = {
    ...(activeRange.from ? { from: activeRange.from } : {}),
    ...(activeRange.to ? { to: activeRange.to } : {}),
    ...(rangePreset ? { range: rangePreset } : {}),
  };

  const setPrDashParams = (updates: Record<string, string>) => {
    const next = new URLSearchParams(p);
    for (const [k, v] of Object.entries(updates)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    go(Object.fromEntries(next), "pr-dashboard");
  };

  const repoNames = Object.keys(data.repositories);
  const trendRange = p.get("t_range") || "3m";
  const trendTo0 = toBeijingDateStr(data.generated_at);
  const trendPreset = TREND_PRESETS.find((t) => t.key === trendRange);
  const trendEarliest = earliestPrDay(prs) || trendTo0;
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

  const stayBins = [
    { name: "≤3 天", min: 0, max: 3 },
    { name: "3–7 天", min: 3, max: 7 },
    { name: "7–14 天", min: 7, max: 14 },
    { name: "14–30 天", min: 14, max: 30 },
    { name: ">30 天", min: 30, max: Infinity },
  ].map((b, n) => ({
    name: b.name,
    count: scope.filter((pr) => {
      if (pr.state !== "open") return false;
      const days = evaluatePrSla(pr, data.generated_at).stayWorkDays;
      return days > b.min - (n === 0 ? 1 : 0) && days <= b.max;
    }).length,
  }));

  const openPrs = scope.filter((pr) => pr.state === "open");
  const readinessBars = [
    {
      name: "合入就绪",
      count: openPrs.filter(
        (pr) => !pr.draft && pr.mergeable && pr.ci_status === "passed",
      ).length,
    },
    {
      name: "CI 未通过/待跑",
      count: openPrs.filter(
        (pr) => !pr.draft && pr.mergeable && pr.ci_status !== "passed",
      ).length,
    },
    {
      name: "草稿或冲突",
      count: openPrs.filter((pr) => pr.draft || !pr.mergeable).length,
    },
  ];

  const allPersonWorkloads = computePrPersonWorkloads(
    scope,
    dutyData,
    issueMap,
    data.generated_at,
    roleFilter,
  );
  const visibleWorkloads = allPersonWorkloads.filter(
    (w) =>
      !personSearch.trim() ||
      w.name.toLowerCase().includes(personSearch.trim().toLowerCase()) ||
      w.subFields.some((sf) =>
        sf.toLowerCase().includes(personSearch.trim().toLowerCase()),
      ),
  );
  const maxPersonCount = Math.max(
    ...visibleWorkloads.map((w) =>
      personSort === "totalPrs" ? w.totalPrs : Math.max(w.openPrs, 1),
    ),
    1,
  );

  return (
    <>
      <section className="panel sla-section overview-panel">
        <div className="toolbar dashboard-bar">
          <div>
            <h2>外部 PR 全局数据概览</h2>
            <p className="muted">
              统计范围：全局总览、各仓总览与趋势统计全量 Pull
              Request（含内部与外部，与官方看板一致）；下方「个人名下外部 PR
              统计」仅统计外部贡献者 PR（内部 PR 无需值班人跟踪）。时长按中国大陆法定节假日及周末校准工作日计算。
            </p>
          </div>
          <div className="dashboard-filters" data-no-export>
            <div
              className="time-range-pills"
              role="group"
              aria-label="PR 统计时间范围"
            >
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
                        setPrDashParams({ range: "custom" });
                      } else {
                        setPrDashParams({
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
                  aria-label="PR 统计起始日期"
                  className={customFrom ? "active-filter" : ""}
                  value={customFrom}
                  onChange={(e) =>
                    setPrDashParams({
                      range: "custom",
                      from: e.target.value,
                    })
                  }
                />
                <span className="muted">至</span>
                <input
                  type="date"
                  aria-label="PR 统计结束日期"
                  className={customTo ? "active-filter" : ""}
                  value={customTo}
                  onChange={(e) =>
                    setPrDashParams({
                      range: "custom",
                      to: e.target.value,
                    })
                  }
                />
              </div>
            )}
            <select
              aria-label="PR 总览仓库"
              className={repo ? "active-filter" : ""}
              value={repo}
              onChange={(e) => setPrDashParams({ repo: e.target.value })}
            >
              <option value="">全部仓库</option>
              {repoNames.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="muted overview-period">
          当前统计周期：<strong>{activeRange.label}</strong>（共 {sla.total} 条
          PR，其中外部 PR{" "}
          {scope.filter((pr) => pr.author_role !== "internal").length} 条 · 开启{" "}
          {sla.open} · 已合入 {sla.merged} · 已关闭 {sla.closed}） ·
          外部 PR 已关联 Issue：{sla.withLinkedIssueNum} 条 · 快照计算于{" "}
          {fmt(data.generated_at)}。
        </p>

        <h3 className="overview-group-title">PR SLA 核心指标</h3>
        <div className="sla-cards">
          <button
            type="button"
            className={`metric sla-card ${sla.closureColor}`}
            onClick={() =>
              go(
                {
                  state: "closed_loop",
                  ...(repo ? { repo } : {}),
                  ...dateDrillParams,
                },
                "prs",
              )
            }
          >
            <div className="sla-card-head">
              <span>PR 闭环率</span>
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
              已闭环 {sla.closedLoop}（合入 {sla.merged} / 关闭 {sla.closed}） /
              总数 {sla.total} ↗
            </small>
          </button>

          <button
            type="button"
            className={`metric sla-card ${sla.firstRespColor}`}
            onClick={() =>
              go(
                {
                  state: "all",
                  first_resp: "qualified",
                  ...(repo ? { repo } : {}),
                  ...dateDrillParams,
                },
                "prs",
              )
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
              CI 通过后 ≤24h 工作日 · {sla.firstRespQualifiedNum} /{" "}
              {sla.respEligibleTotal} · 查看达标 ↗
            </small>
          </button>

          <button
            type="button"
            className={`metric sla-card ${sla.firstRespUnqualifiedNum > 0 ? "red" : "green"}`}
            onClick={() =>
              go(
                {
                  state: "all",
                  first_resp: "unqualified",
                  ...(repo ? { repo } : {}),
                  ...dateDrillParams,
                },
                "prs",
              )
            }
          >
            <div className="sla-card-head">
              <span>首次响应未达标数</span>
              <em className="tag">就绪 &amp; CI 通过</em>
            </div>
            <strong>{sla.firstRespUnqualifiedNum}</strong>
            <small>CI 通过后首响 &gt;24h 或未响应滞留 &gt;24h · 查看明细 ↗</small>
          </button>

          <button
            type="button"
            className={`metric sla-card ${sla.openNoRespTimeoutNum > 0 ? "amber" : "green"}`}
            onClick={() =>
              go(
                {
                  state: "open",
                  first_resp: "open_timeout",
                  ...(repo ? { repo } : {}),
                  ...dateDrillParams,
                },
                "prs",
              )
            }
          >
            <div className="sla-card-head">
              <span>开启未响应超时数 / 开启且未响应数</span>
              <em className="tag">Open 待响应</em>
            </div>
            <strong>
              {sla.openNoRespTimeoutNum}{" "}
              <small className="fraction-inline">/ {sla.openNoRespTotal}</small>
            </strong>
            <small>就绪无冲突且 CI 通过后未响应 &gt;24h 工作日 · 查看 ↗</small>
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
            <small>CI 首次通过至非作者真实用户首条评论均值</small>
          </div>

          <div className="metric sla-card static-card purple">
            <div className="sla-card-head">
              <span>平均闭环时长</span>
              <em className="tag purple">有效工作日</em>
            </div>
            <strong>
              {sla.avgCloseDays !== null ? `${sla.avgCloseDays}d` : "—"}
            </strong>
            <small>已合入或已关闭 PR 从创建至闭环平均工作日天数</small>
          </div>
        </div>

        <h3 className="overview-group-title">外部 PR 处理状态</h3>
        <div className="status-strip">
          {(
            [
              {
                name: "PR 总数",
                val: sla.total,
                color: "purple",
                filter: { state: "all" },
              },
              {
                name: "PR 开启数",
                val: sla.open,
                color: "blue",
                filter: { state: "open" },
              },
              {
                name: "合入就绪数",
                val: sla.readyToMergeNum,
                color: "green",
                filter: { state: "open", merge_readiness: "ready" },
              },
              {
                name: "合入阻塞数",
                val: sla.blockedMergeNum,
                color: "amber",
                filter: { state: "open", merge_readiness: "blocked" },
              },
              {
                name: "已合入 PR",
                val: sla.merged,
                color: "green",
                filter: { state: "merged" },
              },
              {
                name: "已关闭(未合入)",
                val: sla.closed,
                color: "amber",
                filter: { state: "closed" },
              },
              {
                name: "已关联 Issue",
                val: sla.withLinkedIssueNum,
                color: "blue",
                filter: { state: "all", has_issue: "yes" },
              },
            ] as {
              name: string;
              val: number;
              color: string;
              filter: Record<string, string>;
            }[]
          ).map((c) => (
            <button
              key={c.name}
              type="button"
              className={`status-item ${c.color}`}
              onClick={() =>
                go(
                  {
                    ...c.filter,
                    ...(repo ? { repo } : {}),
                    ...dateDrillParams,
                  },
                  "prs",
                )
              }
            >
              <span>{c.name}</span>
              <strong>{c.val}</strong>
              <small>查看 PR ↗</small>
            </button>
          ))}
        </div>

        <details className="sla-rules-box">
          <summary>📖 外部 PR 统计规则与个人归属说明</summary>
          <div className="sla-rules-grid">
            <div>
              <h4>1. 外部 PR 判定与个人归属（田主 / Committer / 关联 Issue）</h4>
              <p>
                <strong>外部 PR 口径</strong>：PR 提交者（Author）不在四仓联合内部维护人总表及自动化机器人名单中的 PR，统一认定为外部开发者提交的外部 PR。
              </p>
              <p>
                <strong>责任田归属（田主 &amp; Committer）</strong>：根据 PR 修改的文件路径按最长目录前缀匹配责任田配置（多文件命中多个责任田时全部关联并去重，未命中显式前缀时回退至仓库兜底责任人）。
              </p>
              <p>
                <strong>关联 Issue 内部维护人</strong>：若 PR 关联了 Issue（通过平台关联或描述引用），自动穿透关联该 Issue 名下的<strong>内部维护人</strong>，同步计入个人 PR 统计。
              </p>
            </div>
            <div>
              <h4>2. PR 闭环率、合入就绪数 &amp; 合入阻塞数</h4>
              <p>
                <strong>PR 闭环率</strong>：统计周期内，<code>(已合入 + 已关闭) PR 数量 ÷ 全部外部 PR 数量 × 100%</code>。阈值：<span className="tag blue">蓝色 ≥ 90%</span> <span className="tag amber">橙色 50% ~ 90%</span> <span className="tag red">红色 &lt; 50%</span>。
              </p>
              <p>
                <strong>合入就绪数</strong>：处于开启状态、非草稿（就绪）、代码无冲突且 CI 门禁通过（<code>ci-pipeline-passed</code>）的 PR 数量。
              </p>
              <p>
                <strong>合入阻塞数</strong>：处于开启状态，但为草稿、存在代码冲突或 CI 门禁未通过的 PR 数量。
              </p>
            </div>
            <div>
              <h4>3. 首次响应达标率 &amp; 评审滞留时长</h4>
              <p>
                <strong>有效样本池</strong>：只统计开启或已合入，且处于就绪状态、无代码冲突、CI 流水线通过的 PR。
              </p>
              <p>
                <strong>首次响应达标</strong>：从 CI 流水线首次通过时间起，到收到非创建者（真实用户，排除机器人）首次评论耗时 <code>≤ 24h</code>（若流水线通过前已有评审意见则视为达标），或虽无评论但滞留时长 <code>≤ 24h</code>。阈值：<span className="tag blue">蓝色 ≥ 80%</span> <span className="tag amber">橙色 50% ~ 80%</span> <span className="tag red">红色 &lt; 50%</span>。
              </p>
              <p>
                <strong>评审滞留时长</strong>：就绪且无代码冲突的开启 PR，自 CI 首次通过且所有评审意见均已解决起至当前时间的有效工作日时长。
              </p>
            </div>
          </div>
        </details>
      </section>

      <div className="grid three">
        <Chart title="各仓外部 PR 开启与闭环数量">
          <Bars
            data={Object.entries(data.repositories).map(([name, r]) => {
              const rPrs = hasDateFilter
                ? filterPrsByDateRange(
                    r.prs || [],
                    activeRange.from,
                    activeRange.to,
                  )
                : r.prs || [];
              const rSla = computeOfficialPrSla(rPrs, data.generated_at);
              return {
                name: short(name),
                open: rSla.open,
                closedLoop: rSla.closedLoop,
              };
            })}
            keys={[
              { key: "open", name: "开启", color: "#50a9ff" },
              { key: "closedLoop", name: "已闭环(合入/关闭)", color: "#38cdb3" },
            ]}
          />
        </Chart>
        <Chart title="未闭环外部 PR 停留时长（工作日）">
          <Bars
            data={stayBins}
            keys={[{ key: "count", name: "PR 数", color: "#38cdb3" }]}
          />
        </Chart>
        <Chart
          title="未闭环外部 PR 合入就绪状态"
          note="开启 PR 按就绪无冲突且 CI 通过 vs CI 未通过 vs 草稿/代码冲突三类互斥统计。"
        >
          <Bars
            data={readinessBars}
            keys={[{ key: "count", name: "PR 数", color: "#a78bfa" }]}
          />
        </Chart>
      </div>

      <section className="panel">
        <h2>各仓外部 PR 总览</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {[
                  "归属仓",
                  "总数",
                  "开启总数",
                  "合入就绪数",
                  "合入阻塞数",
                  "已闭环",
                  "闭环率",
                  "开启未响应超时数/总数",
                  "首次响应未达标数",
                  "首次响应达标率",
                  "平均首次响应(H)",
                  "关联 Issue PR",
                ].map((x) => (
                  <th key={x}>{x}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.repositories).map(([name, r]) => {
                const rPrs = hasDateFilter
                  ? filterPrsByDateRange(
                      r.prs || [],
                      activeRange.from,
                      activeRange.to,
                    )
                  : r.prs || [];
                const rSla = computeOfficialPrSla(rPrs, data.generated_at);
                return (
                  <tr key={name}>
                    <td>
                      <button
                        className="text repo-link"
                        onClick={() =>
                          go(
                            { repo: name, state: "all", ...dateDrillParams },
                            "prs",
                          )
                        }
                      >
                        {short(name)}
                      </button>
                    </td>
                    <td>
                      <button
                        className="text"
                        onClick={() =>
                          go(
                            { repo: name, state: "all", ...dateDrillParams },
                            "prs",
                          )
                        }
                      >
                        {rSla.total}
                      </button>
                    </td>
                    <td>
                      <button
                        className={`text ${rSla.open > 0 ? "blue" : "zero"}`}
                        onClick={() =>
                          go(
                            { repo: name, state: "open", ...dateDrillParams },
                            "prs",
                          )
                        }
                      >
                        {rSla.open}
                      </button>
                    </td>
                    <td>
                      <button
                        className={`text ${rSla.readyToMergeNum > 0 ? "green" : "zero"}`}
                        onClick={() =>
                          go(
                            {
                              repo: name,
                              state: "open",
                              merge_readiness: "ready",
                              ...dateDrillParams,
                            },
                            "prs",
                          )
                        }
                      >
                        {rSla.readyToMergeNum}
                      </button>
                    </td>
                    <td>
                      <button
                        className={`text ${rSla.blockedMergeNum > 0 ? "amber" : "zero"}`}
                        onClick={() =>
                          go(
                            {
                              repo: name,
                              state: "open",
                              merge_readiness: "blocked",
                              ...dateDrillParams,
                            },
                            "prs",
                          )
                        }
                      >
                        {rSla.blockedMergeNum}
                      </button>
                    </td>
                    <td>
                      <button
                        className="text green"
                        onClick={() =>
                          go(
                            {
                              repo: name,
                              state: "closed_loop",
                              ...dateDrillParams,
                            },
                            "prs",
                          )
                        }
                      >
                        {rSla.closedLoop}
                      </button>
                    </td>
                    <td>
                      <div className="rate-cell">
                        <span className={rSla.closureColor}>
                          {rSla.closureRate !== null
                            ? `${rSla.closureRate}%`
                            : "—"}
                        </span>
                        {rSla.closureRate !== null && (
                          <span className="mini-bar" aria-hidden="true">
                            <i style={{ width: `${rSla.closureRate}%` }} />
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <button
                        className={`text ${rSla.openNoRespTimeoutNum > 0 ? "red" : rSla.openNoRespTotal > 0 ? "amber" : "zero"}`}
                        onClick={() =>
                          go(
                            {
                              repo: name,
                              state: "open",
                              first_resp:
                                rSla.openNoRespTimeoutNum > 0
                                  ? "open_timeout"
                                  : "open_noresp",
                              ...dateDrillParams,
                            },
                            "prs",
                          )
                        }
                      >
                        {rSla.openNoRespTimeoutNum} / {rSla.openNoRespTotal}
                      </button>
                    </td>
                    <td>
                      <button
                        className={`text ${rSla.firstRespUnqualifiedNum > 0 ? "red" : "zero"}`}
                        onClick={() =>
                          go(
                            {
                              repo: name,
                              state: "all",
                              first_resp: "unqualified",
                              ...dateDrillParams,
                            },
                            "prs",
                          )
                        }
                      >
                        {rSla.firstRespUnqualifiedNum}
                      </button>
                    </td>
                    <td>
                      <button
                        className={`text ${rSla.firstRespColor}`}
                        onClick={() =>
                          go(
                            {
                              repo: name,
                              state: "all",
                              first_resp: "qualified",
                              ...dateDrillParams,
                            },
                            "prs",
                          )
                        }
                      >
                        {rSla.firstRespQualifiedRate !== null
                          ? `${rSla.firstRespQualifiedRate}%`
                          : "—"}
                        <small className="muted">
                          {rSla.firstRespQualifiedNum}/{rSla.respEligibleTotal}
                        </small>
                      </button>
                    </td>
                    <td>
                      {rSla.avgFirstRespHours !== null
                        ? `${rSla.avgFirstRespHours}h`
                        : "—"}
                    </td>
                    <td>
                      <button
                        className={`text ${rSla.withLinkedIssueNum > 0 ? "blue" : "zero"}`}
                        onClick={() =>
                          go(
                            {
                              repo: name,
                              state: "all",
                              has_issue: "yes",
                              ...dateDrillParams,
                            },
                            "prs",
                          )
                        }
                      >
                        {rSla.withLinkedIssueNum}
                      </button>
                    </td>
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
            外部 PR 趋势{" "}
            <span className="muted trend-range-label">
              {trendFrom} ~ {trendTo} · {GRANULARITY_LABELS[trendGran]}
            </span>
          </h2>
          <div className="dashboard-filters" data-no-export>
            <div
              className="time-range-pills"
              role="group"
              aria-label="PR 趋势统计区间"
            >
              {TREND_PRESETS.map((tp) => (
                <button
                  key={tp.key}
                  type="button"
                  className={`chip-btn ${trendRange === tp.key ? "active" : ""}`}
                  onClick={() =>
                    setPrDashParams(
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
            <select
              aria-label="PR 趋势统计粒度"
              value={p.get("t_gran") || ""}
              onChange={(e) => setPrDashParams({ t_gran: e.target.value })}
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
            title="外部 PR 创建与闭环趋势"
            note={`${repo ? short(repo) : "全部仓库"}；按北京时间 created_at / merged_at(closed_at) 统计。`}
          >
            <Lines
              data={prCreatedClosedTrend(
                repo ? prs.filter((pr) => pr.repo === repo) : prs,
                trendFrom,
                trendTo,
                trendGran,
              )}
              keys={[
                { key: "created", name: "创建", color: "#50a9ff" },
                { key: "closed", name: "闭环(合入/关闭)", color: "#38cdb3" },
              ]}
            />
          </Chart>
          <Chart
            title="外部 PR 累计闭环率趋势"
            note="截至各时间点前创建且已合入/关闭的外部 PR ÷ 该时间点前创建的外部 PR 总数。"
          >
            <Lines
              percent
              data={prClosureRateTrend(
                prs,
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
            个人名下外部 PR 统计（田主 / Committer / 关联 Issue 维护人）{" "}
            <span className="count">{visibleWorkloads.length}</span>
          </h2>
          <div className="owner-controls" data-no-export>
            <input
              aria-label="搜索 PR 责任人"
              placeholder="搜索姓名、GitCode 账号或责任田…"
              value={personSearch}
              onChange={(e) => setPersonSearch(e.target.value)}
            />
            <select
              aria-label="PR 个人角色类型"
              className={roleFilter ? "active-filter" : ""}
              value={roleFilter}
              onChange={(e) => setPrDashParams({ pr_role: e.target.value })}
            >
              <option value="">全部角色（去重汇总）</option>
              <option value="owner">作为田主 (Owner)</option>
              <option value="committer">作为 Committer</option>
              <option value="issue_maintainer">作为关联 Issue 维护人</option>
            </select>
            <select
              aria-label="PR 责任人排序"
              value={personSort}
              onChange={(e) =>
                setPersonSort(
                  e.target.value as
                    | "openPrs"
                    | "totalPrs"
                    | "readyPrs"
                    | "unqualifiedPrs",
                )
              }
            >
              <option value="openPrs">按开启 PR 数</option>
              <option value="totalPrs">按名下 PR 总数</option>
              <option value="readyPrs">按合入就绪待处理数</option>
              <option value="unqualifiedPrs">按首响未达标数</option>
            </select>
          </div>
        </div>
        <p className="muted">
          归属规则：① 按 PR 修改文件路径匹配责任田<strong>田主</strong>与{" "}
          <strong>Committer</strong>（跨多个责任田时同时关联对应负责人并按人去重，未命中显式路径时回退至仓库兜底）；② 若 PR 关联了 Issue，同时关联该{" "}
          <strong>Issue 对应的内部维护人</strong>。支持按三类角色筛选与下钻。
        </p>
        {!dutyData && (
          <p className="notice amber">
            提示：当前环境尚未加载责任田配置（<code>data/duty.json</code>
            ），田主与 Committer 归属待责任田加载后自动计算；关联 Issue 内部维护人归属正常展示。
          </p>
        )}
        {!visibleWorkloads.length && (
          <p className="empty">当前筛选条件下暂无匹配的责任人记录</p>
        )}
        <div className="owner-grid">
          {[...visibleWorkloads]
            .sort(
              (a, b) =>
                b[personSort] - a[personSort] ||
                b.openPrs - a.openPrs ||
                b.totalPrs - a.totalPrs,
            )
            .map((w) => {
              const readyPct = (w.readyPrs / maxPersonCount) * 100;
              const blockedOpen = Math.max(0, w.openPrs - w.readyPrs);
              const blockedPct = (blockedOpen / maxPersonCount) * 100;
              const unqualPct = (w.unqualifiedPrs / maxPersonCount) * 100;
              const drillFilter: Record<string, string> =
                roleFilter === "owner"
                  ? { pr_owner: w.name }
                  : roleFilter === "committer"
                    ? { pr_committer: w.name }
                    : roleFilter === "issue_maintainer"
                      ? { issue_maintainer: w.name }
                      : { person: w.name };
              return (
                <div
                  key={w.name}
                  className="owner"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest("button")) return;
                    go(
                      {
                        state: w.openPrs > 0 ? "open" : "all",
                        ...drillFilter,
                        ...(repo ? { repo } : {}),
                        ...dateDrillParams,
                      },
                      "prs",
                    );
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      go(
                        {
                          state: w.openPrs > 0 ? "open" : "all",
                          ...drillFilter,
                          ...(repo ? { repo } : {}),
                          ...dateDrillParams,
                        },
                        "prs",
                      );
                    }
                  }}
                >
                  <div className="owner-name">
                    <b className="avatar">{w.name.slice(0, 1).toUpperCase()}</b>
                    <strong>{w.name}</strong>
                    {w.roles.map((r) => (
                      <span
                        key={r}
                        className={`tag ${r === "owner" ? "blue" : r === "committer" ? "purple" : "green"}`}
                      >
                        {PR_ROLE_LABELS[r]}
                      </span>
                    ))}
                    <b title="开启 PR 数 / 去重总 PR 数">
                      {w.openPrs}{" "}
                      <small className="muted">/ {w.totalPrs}</small>
                    </b>
                  </div>
                  <div className="workbar" aria-hidden="true">
                    {readyPct > 0 && (
                      <i
                        className="seg-normal"
                        style={{ width: `${Math.min(100, readyPct)}%` }}
                      />
                    )}
                    {blockedPct > 0 && (
                      <i
                        className="seg-soon"
                        style={{ width: `${Math.min(100, blockedPct)}%` }}
                      />
                    )}
                    {unqualPct > 0 && (
                      <i
                        className="seg-overdue"
                        style={{ width: `${Math.min(100, unqualPct)}%` }}
                      />
                    )}
                  </div>
                  <div className="tags">
                    {w.asOwnerTotal > 0 && (
                      <button
                        type="button"
                        className="tag blue"
                        onClick={() =>
                          go(
                            {
                              state: "all",
                              pr_owner: w.name,
                              ...(repo ? { repo } : {}),
                              ...dateDrillParams,
                            },
                            "prs",
                          )
                        }
                      >
                        田主: 开启 {w.asOwnerOpen} / 总 {w.asOwnerTotal} ↗
                      </button>
                    )}
                    {w.asCommitterTotal > 0 && (
                      <button
                        type="button"
                        className="tag purple"
                        onClick={() =>
                          go(
                            {
                              state: "all",
                              pr_committer: w.name,
                              ...(repo ? { repo } : {}),
                              ...dateDrillParams,
                            },
                            "prs",
                          )
                        }
                      >
                        Committer: 开启 {w.asCommitterOpen} / 总{" "}
                        {w.asCommitterTotal} ↗
                      </button>
                    )}
                    {w.asIssueMaintainerTotal > 0 && (
                      <button
                        type="button"
                        className="tag green"
                        onClick={() =>
                          go(
                            {
                              state: "all",
                              issue_maintainer: w.name,
                              ...(repo ? { repo } : {}),
                              ...dateDrillParams,
                            },
                            "prs",
                          )
                        }
                      >
                        关联 Issue 维护人: 开启 {w.asIssueMaintainerOpen} / 总{" "}
                        {w.asIssueMaintainerTotal} ↗
                      </button>
                    )}
                  </div>
                  <div className="tags">
                    <span className={w.readyPrs > 0 ? "green" : "muted"}>
                      就绪待合入 {w.readyPrs}
                    </span>
                    <span
                      className={w.openNoRespTimeoutPrs > 0 ? "amber" : "muted"}
                    >
                      未响应超时 {w.openNoRespTimeoutPrs}
                    </span>
                    <span className={w.unqualifiedPrs > 0 ? "red" : "muted"}>
                      首响未达标 {w.unqualifiedPrs}
                    </span>
                  </div>
                  <small>
                    {w.subFields.length > 0 && (
                      <span>{w.subFields.slice(0, 3).join("、")} · </span>
                    )}
                    {Object.entries(w.repos)
                      .map(([r, n]) => `${short(r)} ${n}`)
                      .join(" / ")}
                  </small>
                </div>
              );
            })}
        </div>
      </section>
    </>
  );
}
