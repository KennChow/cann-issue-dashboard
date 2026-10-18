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
import {
  TIME_PRESETS,
  resolveTimeRange,
  filterIssuesByDateRange,
  computeDynamicStats,
  computeOfficialSla,
} from "./sla";

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
    name: "未分配内部责任人",
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
    name: "未获维护者回复",
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

function App() {
  const [data, setData] = useState<Data>();
  const [error, setError] = useState("");
  const [hash, setHash] = useState(location.hash);
  const [ownerSort, setOwnerSort] = useState("open");
  const [ownerSearch, setOwnerSearch] = useState("");
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
  const view = hash.split("?")[0];
  const selected = all.find((i) => i.id === p.get("id"));
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
              !view.includes("members") &&
              !view.includes("duty")
                ? "active"
                : ""
            }
            href="#/dashboard"
          >
            运行总览
          </a>
          <a
            className={view.includes("issues") ? "active" : ""}
            href="#/issues"
          >
            Issue 工作台
          </a>
          <a
            href="#/members"
            className={view.includes("members") ? "active" : ""}
          >
            内部责任人总表
          </a>
          <a href="#/duty" className={view.includes("duty") ? "active" : ""}>
            GE 责任田
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
                ? "GE 责任田查询"
                : view.includes("members")
                  ? "内部责任人总表"
                  : view.includes("issues")
                    ? "Issue 工作台"
                    : "让每一个问题得到回应"}
            </h1>
            <p className="muted">
              四仓公共 Issue · 责任归属 · 响应追踪 · 14 天闭环预警
            </p>
          </div>
          <div className="heading-actions">
            {!view.includes("issues") && !view.includes("duty") && (
              <button
                className="btn-export"
                data-no-export
                onClick={() =>
                  exportView(
                    view.includes("members") ? "内部责任人总表" : "大屏总览",
                    "main",
                    data.generated_at,
                  )
                }
              >
                <ExportIcon />
                {view.includes("members") ? "导出总表 HTML" : "导出大屏 HTML"}
              </button>
            )}
            <button className="sync" onClick={() => go({ state: "all" })}>
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
          <InternalMembers data={data} />
        ) : view.includes("issues") ? (
          <IssueList issues={all} hash={hash} at={data.generated_at} />
        ) : (
          <>
            <div className="toolbar dashboard-bar">
              <h2>
                全局态势 <span className="muted">/ OPERATIONS</span>
              </h2>
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
            <div className="cards">
              {cards.map((c) => (
                <button
                  key={c.key}
                  className={`metric ${c.color}`}
                  onClick={() =>
                    go({
                      ...c.filter,
                      ...(repo ? { repo } : {}),
                      ...dateDrillParams,
                    })
                  }
                >
                  <span>{c.name}</span>
                  <strong>
                    {stat[c.key] ?? "—"}
                    {c.key === "closure_rate" && stat[c.key] !== null
                      ? "%"
                      : ""}
                  </strong>
                  <small>查看 Issue ↗</small>
                </button>
              ))}
            </div>
            <p className="muted">
              当前统计周期：<strong>{activeRange.label}</strong>（共 {scope.length}{" "}
              条 Issue） · 回复身份无法确认：{stat.unknown} 项（不计入未回复） ·
              快照计算于 {fmt(data.generated_at)}。
            </p>

            <section className="panel sla-section">
              <div className="toolbar">
                <div>
                  <h2>
                    CANN 官网 SLA 核心指标 · 闭环率与首次响应达标率{" "}
                    <span className="tag blue">对齐 digital.hicann.cn</span>
                  </h2>
                  <p className="muted">
                    严格遵循 CANN 数字化协作平台（digital.hicann.cn）统计口径：剔除中国大陆法定节假日及周末，首次响应排除自处理（{sla.excludedSelfProcessed} 项）及里程碑 Issue。
                  </p>
                </div>
              </div>
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
                    <span>Issue 闭环率（官方口径）</span>
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
                    <span>首次响应达标率（≤24h 工作日）</span>
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
                    达标 {sla.firstRespQualifiedNum} / 有效总数{" "}
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
                    <span>开启未响应超时数 / 总数</span>
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

              <details className="sla-rules-box" open>
                <summary>
                  📖 官方统计规则说明（对齐 CANN 数字化协作平台 digital.hicann.cn）
                </summary>
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
              <Chart title="仓库压力 / Open 与超期">
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
                      overdue: rStats.overdue,
                    };
                  })}
                  keys={[
                    { key: "open", name: "Open", color: "#50a9ff" },
                    { key: "overdue", name: "已超期", color: "#fb7185" },
                  ]}
                />
              </Chart>
              <Chart title="Open Issue 年龄分布">
                <Bars
                  data={ageBins}
                  keys={[{ key: "count", name: "Issue 数", color: "#38cdb3" }]}
                />
              </Chart>
              <Chart
                title="Open 回复状态分布"
                note="维护者回复独立于指派和超期状态，三项按回复状态互斥。"
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
                        "未分配内部责任人",
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
            <div className="grid two">
              <Chart
                title="创建与关闭 / 最近 60 个活动日"
                note="来自真实 created_at / closed_at；关闭为当前 Closed Issue 的最终关闭日期，不等同全部历史关闭事件。"
              >
                <Lines
                  data={data.activity.slice(-60)}
                  keys={[
                    { key: "created", name: "创建", color: "#50a9ff" },
                    { key: "closed", name: "关闭", color: "#38cdb3" },
                  ]}
                />
              </Chart>
              <Chart
                title="累计闭环率趋势"
                note="每天最后一次完整快照，最多保留 365 天；首次采集只有一个真实观测点。"
              >
                <Lines
                  data={data.snapshots}
                  keys={[
                    { key: "closure_rate", name: "闭环率 %", color: "#a78bfa" },
                  ]}
                />
              </Chart>
            </div>
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
                    <option value="internal">内部责任人</option>
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
                仅计入首位内部责任人；无内部成员时计入首位责任人。顺序以 GitCode
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
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
