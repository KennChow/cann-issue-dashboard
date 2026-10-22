import { useMemo } from "react";
import { RelatedPrs, indexRelatedPrs } from "./RelatedLinks";
import type { Issue, PullRequest } from "./types";
import { fmt, short, go } from "./shared";
import { Badges } from "./Badges";
import { exportIssues } from "./export";
import {
  TIME_PRESETS,
  resolveTimeRange,
  evaluateIssueSla,
  toBeijingDateStr,
} from "./sla";

const filterLabels: Record<string, string> = {
  q: "关键词",
  repo: "仓库",
  author: "提出人",
  owner: "责任人",
  workload_owner: "内部维护人",
  workload_role: "维护人身份",
  state: "状态",
  assignment: "是否已分配责任人",
  internal: "是否已分配内部维护人",
  reply: "维护人回复",
  first_resp: "首次响应 SLA",
  risk: "期限预警",
  ai: "AI 分析",
  from: "创建自",
  to: "创建至",
};

const filterValueLabels: Record<string, Record<string, string>> = {
  workload_role: { internal: "内部成员", external: "外部开发者" },
  state: { open: "Open", closed: "Closed", all: "全部" },
  assignment: { yes: "已分配", no: "未分配" },
  internal: {
    missing: "未分配内部维护人",
    assigned: "已分配内部维护人",
    unknown: "无法确认",
  },
  reply: { replied: "已回复", unreplied: "未回复", unknown: "无法确认" },
  first_resp: {
    qualified: "首次响应达标 (≤24h)",
    unqualified: "首次响应未达标 (>24h)",
    open_soon: "即将响应超时 (≤24h)",
    open_timeout: "开启未响应超时 (>24h)",
    self: "自处理 Issue",
  },
  risk: { normal: "正常", soon: "即将超期", overdue: "已超期" },
  ai: { yes: "存在报告", no: "无报告" },
};

const presets: { label: string; params: Record<string, string> }[] = [
  { label: "全部 Open", params: {} },
  { label: "🔥 已超期", params: { risk: "overdue" } },
  { label: "⚡ 即将超期", params: { risk: "soon" } },
  {
    label: "⏱️ 首响未达标",
    params: { state: "all", first_resp: "unqualified" },
  },
  { label: "👤 缺内部维护人", params: { internal: "missing" } },
  { label: "💬 待维护人回复", params: { reply: "unreplied" } },
  { label: "🤖 含 AI 报告", params: { ai: "yes" } },
];

export function IssueList({
  issues,
  prs,
  hash,
  at,
}: {
  issues: Issue[];
  prs: PullRequest[];
  hash: string;
  at: string;
}) {
  const relatedPrs = useMemo(() => indexRelatedPrs(prs), [prs]);
  const p = new URLSearchParams(hash.split("?")[1] || "");
  const value = (k: string, d = "") => p.get(k) || d;
  const set = (k: string, v: string) => {
    v ? p.set(k, v) : p.delete(k);
    p.delete("page");
    go(Object.fromEntries(p));
  };
  const setMulti = (updates: Record<string, string>) => {
    for (const [k, v] of Object.entries(updates)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    p.delete("page");
    go(Object.fromEntries(p));
  };

  const rangePreset = value("range");
  const authorQuery = value("author").toLowerCase();
  const authorExact =
    !!authorQuery &&
    issues.some((i) => i.author?.login?.toLowerCase() === authorQuery);
  const filtered = issues.filter((i) => {
    const m = i.metrics;
    const day = toBeijingDateStr(i.created_at);
    const sla = value("first_resp") ? evaluateIssueSla(i, at) : null;
    return (
      (!value("workload_role") ||
        i.assignees.find((a) => a.login === i.workload_owner)?.membership ===
          value("workload_role")) &&
      (!value("workload_owner") ||
        i.workload_owner === value("workload_owner")) &&
      (!value("repo") || i.repo === value("repo")) &&
      (!authorQuery ||
        (authorExact
          ? i.author.login.toLowerCase() === authorQuery
          : i.author.login.toLowerCase().includes(authorQuery))) &&
      (!value("owner") ||
        (value("owner") === "未分配"
          ? !i.assignees.length
          : i.assignees.some((a) => a.login === value("owner")))) &&
      (value("state", "open") === "all" ||
        i.state === value("state", "open")) &&
      (!value("assignment") ||
        (value("assignment") === "yes"
          ? i.assignees.length > 0
          : i.assignees.length === 0)) &&
      (!value("internal") ||
        (value("internal") === "missing"
          ? i.metrics.no_internal_assignee
          : (i.internal_assignment || "unknown") === value("internal"))) &&
      (!value("reply") || i.reply_status === value("reply")) &&
      (!value("first_resp") ||
        (value("first_resp") === "qualified"
          ? sla!.firstRespQualified
          : value("first_resp") === "unqualified"
            ? sla!.firstRespUnqualified
            : value("first_resp") === "open_soon"
              ? sla!.openNoResp && !sla!.openNoRespTimeout
              : value("first_resp") === "open_timeout"
                ? sla!.openNoRespTimeout
                : value("first_resp") === "self"
                  ? sla!.isSelfProcessed
                  : true)) &&
      (!value("risk") ||
        (value("risk") === "overdue"
          ? m.overdue
          : value("risk") === "soon"
            ? m.due_soon
            : i.state === "open" && !m.overdue && !m.due_soon)) &&
      (!value("ai") ||
        (value("ai") === "yes" ? i.reports.length > 0 : !i.reports.length)) &&
      (!value("from") || day >= value("from")) &&
      (!value("to") || day <= value("to")) &&
      (!value("q") ||
        `${i.title} #${i.number} ${i.author.login} ${i.assignees.map((a) => a.login).join(" ")}`
          .toLowerCase()
          .includes(value("q").toLowerCase()))
    );
  });
  const sort = value("sort", "age_desc");
  filtered.sort((a, b) =>
    sort === "updated"
      ? Date.parse(b.updated_at) - Date.parse(a.updated_at)
      : sort === "title"
        ? a.title.localeCompare(b.title)
        : sort === "age_asc"
          ? a.metrics.age_hours - b.metrics.age_hours
          : b.metrics.age_hours - a.metrics.age_hours,
  );
  const page = Math.max(
    1,
    Math.min(
      Math.ceil(filtered.length / 25) || 1,
      Number(value("page", "1")) || 1,
    ),
  );
  const select = (key: string, label: string, options: [string, string][]) => {
    const def = key === "state" ? "open" : "";
    const cur = value(key, def);
    const isActive = cur !== def;
    return (
      <label className={isActive ? "active-label" : ""}>
        {label}
        <select
          aria-label={label}
          className={isActive ? "active-filter" : ""}
          value={cur}
          onChange={(e) => set(key, e.target.value)}
        >
          {options.map(([v, n]) => (
            <option key={v} value={v}>
              {n}
            </option>
          ))}
        </select>
      </label>
    );
  };

  const activeEntries = Object.keys(filterLabels).flatMap((k) => {
    const def = k === "state" ? "open" : "";
    const v = value(k, def);
    if (v === def) return [];
    const displayVal = k === "repo" ? short(v) : filterValueLabels[k]?.[v] || v;
    return [{ key: k, label: filterLabels[k], value: displayVal }];
  });

  const selectedId = value("id");

  return (
    <>
      <section className="panel filters-panel">
        <div className="presets-row" data-no-export>
          <div className="presets-bar">
            <span className="muted">快捷视角：</span>
            {presets.map((pr) => {
              const entries = Object.entries(pr.params);
              const isMatch =
                entries.length === 0
                  ? activeEntries.length === 0
                  : activeEntries.length === entries.length &&
                    entries.every(([k, v]) => value(k) === v);
              return (
                <button
                  key={pr.label}
                  type="button"
                  className={`chip-btn ${isMatch ? "active" : ""}`}
                  onClick={() => go(pr.params)}
                >
                  {pr.label}
                </button>
              );
            })}
          </div>
          <div className="presets-bar">
            <span className="muted">创建时间范围：</span>
            {TIME_PRESETS.filter((tp) => tp.key !== "custom").map((tp) => {
              const isMatch =
                tp.key === ""
                  ? !rangePreset && !value("from") && !value("to")
                  : rangePreset === tp.key;
              return (
                <button
                  key={tp.key || "all"}
                  type="button"
                  className={`chip-btn ${isMatch ? "active" : ""}`}
                  onClick={() => {
                    if (!tp.key) {
                      setMulti({ range: "", from: "", to: "" });
                    } else {
                      const r = resolveTimeRange(tp.key, "", "", at);
                      setMulti({ range: tp.key, from: r.from, to: r.to });
                    }
                  }}
                >
                  {tp.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="filters">
          <label className={`search ${value("q") ? "active-label" : ""}`}>
            搜索标题关键词 / 编号 / 提出人 / 责任人
            <div className="input-clear-wrap">
              <input
                className={value("q") ? "active-filter" : ""}
                placeholder="搜索标题关键词 / 编号 / 提出人 / 责任人..."
                value={value("q")}
                onChange={(e) => set("q", e.target.value)}
              />
              {value("q") && (
                <button
                  type="button"
                  className="input-clear"
                  aria-label="清空搜索"
                  onClick={() => set("q", "")}
                >
                  ×
                </button>
              )}
            </div>
          </label>
          {select("repo", "仓库", [
            ["", "全部仓库"],
            ...Array.from(new Set(issues.map((i) => i.repo))).map(
              (r) => [r, short(r)] as [string, string],
            ),
          ])}
          {select("owner", "责任人", [
            ["", "全部责任人"],
            ["未分配", "未分配"],
            ...Array.from(
              new Set(issues.flatMap((i) => i.assignees.map((a) => a.login))),
            )
              .sort()
              .map((a) => [a, a] as [string, string]),
          ])}
          {select("workload_owner", "内部维护人", [
            ["", "全部"],
            ...Array.from(
              new Set(issues.map((i) => i.workload_owner || "未分配")),
            )
              .sort()
              .map((n) => [n, n] as [string, string]),
          ])}
          {select("state", "状态", [
            ["open", "Open"],
            ["closed", "Closed"],
            ["all", "全部"],
          ])}
          {select("assignment", "是否已分配责任人", [
            ["", "全部"],
            ["yes", "已分配"],
            ["no", "未分配"],
          ])}
          {select("internal", "是否已分配内部维护人", [
            ["", "全部"],
            ["missing", "未分配内部维护人"],
            ["assigned", "已分配内部维护人"],
            ["unknown", "无法确认"],
          ])}
          {select("reply", "维护人回复", [
            ["", "全部"],
            ["replied", "已回复"],
            ["unreplied", "未回复"],
            ["unknown", "无法确认"],
          ])}
          {select("first_resp", "首次响应 SLA", [
            ["", "全部"],
            ["qualified", "首次响应达标 (≤24h)"],
            ["unqualified", "首次响应未达标 (>24h)"],
            ["open_soon", "即将响应超时 (≤24h)"],
            ["open_timeout", "开启未响应超时 (>24h)"],
            ["self", "自处理 Issue"],
          ])}
          {select("risk", "期限预警", [
            ["", "全部"],
            ["normal", "正常"],
            ["soon", "即将超期"],
            ["overdue", "已超期"],
          ])}
          {select("ai", "AI 分析", [
            ["", "全部"],
            ["yes", "存在报告"],
            ["no", "无报告"],
          ])}
          <label className={value("from") ? "active-label" : ""}>
            创建自
            <input
              type="date"
              className={value("from") ? "active-filter" : ""}
              value={value("from")}
              onChange={(e) =>
                setMulti({ range: "custom", from: e.target.value })
              }
            />
          </label>
          <label className={value("to") ? "active-label" : ""}>
            创建至
            <input
              type="date"
              className={value("to") ? "active-filter" : ""}
              value={value("to")}
              onChange={(e) =>
                setMulti({ range: "custom", to: e.target.value })
              }
            />
          </label>
          <button onClick={() => go()}>重置筛选</button>
        </div>
        {activeEntries.length > 0 && (
          <div className="active-chips" data-no-export>
            <span className="muted">当前条件：</span>
            {activeEntries.map((item) => (
              <button
                key={item.key}
                type="button"
                className="filter-chip"
                onClick={() => {
                  if (item.key === "from" || item.key === "to") {
                    setMulti({ [item.key]: "", range: "" });
                  } else {
                    set(item.key, item.key === "state" ? "open" : "");
                  }
                }}
              >
                <span>{item.label}：</span>
                <strong>{item.value}</strong>
                <i aria-hidden="true">×</i>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="panel">
        <div className="toolbar">
          <button
            className="btn-export"
            data-no-export
            onClick={() => exportIssues(filtered, at, p.toString())}
          >
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
            导出筛选结果 HTML（{filtered.length} 项）
          </button>
          <h2>
            Issue 列表 <span className="count">{filtered.length}</span>
          </h2>
          <select
            aria-label="Issue 排序"
            value={sort}
            onChange={(e) => set("sort", e.target.value)}
          >
            <option value="age_desc">处理时长：最长优先</option>
            <option value="age_asc">处理时长：最短优先</option>
            <option value="updated">最近更新</option>
            <option value="title">按标题</option>
          </select>
        </div>
        <div className="table-wrap">
          <table className="issues detail-table issue-detail-table">
            <colgroup>
              {[24, 14, 15, 15, 12, 9, 11].map((width, index) => (
                <col key={index} style={{ width: `${width}%` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {[
                  "仓库 / 编号 / 标题",
                  "责任人与提出人",
                  "关联PR",
                  "独立状态",
                  "创建 / 更新（北京）",
                  "处理时长 / 期限",
                  "原始标签 / AI",
                ].map((x) => (
                  <th key={x}>{x}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice((page - 1) * 25, page * 25).map((i) => (
                <tr
                  key={i.id}
                  className={`issue-row ${selectedId === i.id ? "active-row" : ""}`}
                  onClick={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest("a, button")) return;
                    p.set("id", i.id);
                    go(Object.fromEntries(p));
                  }}
                >
                  <td>
                    <small className="blue">
                      {short(i.repo)} #{i.number}
                    </small>
                    <button
                      className="text title"
                      onClick={() => {
                        p.set("id", i.id);
                        go(Object.fromEntries(p));
                      }}
                    >
                      {i.title}
                    </button>
                    <a href={i.url} target="_blank" rel="noreferrer">
                      原始 Issue ↗
                    </a>
                  </td>
                  <td>
                    {i.assignees.map((a) => a.login).join(", ") || (
                      <span className="amber">未分配</span>
                    )}
                    <small className="muted">
                      提出人{" "}
                      <button
                        type="button"
                        className="text author-btn"
                        onClick={() => set("author", i.author.login)}
                      >
                        {i.author.login}
                      </button>
                    </small>
                  </td>
                  <td>
                    <RelatedPrs prs={relatedPrs.get(i.id) || []} />
                  </td>
                  <td>
                    <Badges i={i} />
                  </td>
                  <td>
                    <small>{fmt(i.created_at)}</small>
                    <small className="muted">{fmt(i.updated_at)}</small>
                  </td>
                  <td>
                    <strong>{(i.metrics.age_hours / 24).toFixed(1)}</strong> 天
                    <small
                      className={
                        i.metrics.overdue
                          ? "red"
                          : i.metrics.due_soon
                            ? "amber"
                            : "muted"
                      }
                    >
                      {i.state === "closed"
                        ? "已关闭"
                        : i.metrics.overdue
                          ? `超期 ${i.metrics.overdue_hours.toFixed(1)}h`
                          : `剩余 ${i.metrics.remaining_hours.toFixed(1)}h`}
                    </small>
                  </td>
                  <td>
                    <div className="tags">
                      {i.labels.map((l) => (
                        <span className="tag" key={l}>
                          {l}
                        </span>
                      ))}
                    </div>
                    {i.reports[0] && (
                      <a
                        className="purple report-link"
                        href={i.reports[0].url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        AI 分析报告 ↗
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <p className="empty">
            没有符合条件的 Issue。可以重置筛选或等待首次成功同步。
          </p>
        )}
        <div className="pagination">
          <span className="muted">每页 25 项 · 共 {filtered.length} 项</span>
          <button
            disabled={page <= 1}
            onClick={() => {
              p.set("page", String(page - 1));
              go(Object.fromEntries(p));
            }}
          >
            上一页
          </button>
          <span>
            {page} / {Math.ceil(filtered.length / 25) || 1}
          </span>
          <button
            disabled={page * 25 >= filtered.length}
            onClick={() => {
              p.set("page", String(page + 1));
              go(Object.fromEntries(p));
            }}
          >
            下一页
          </button>
        </div>
      </section>
    </>
  );
}
