import type { Issue, PullRequest } from "./types";
import type { DutyData } from "./duty";
import { fmt, short, go } from "./shared";
import { exportPrs } from "./export";
import {
  TIME_PRESETS,
  resolveTimeRange,
  toBeijingDateStr,
} from "./sla";
import {
  evaluatePrSla,
  resolvePrAttribution,
  type PrAttribution,
  type PrSlaDetail,
} from "./pr";

const filterLabels: Record<string, string> = {
  q: "关键词",
  repo: "归属仓",
  author_role: "作者类型",
  author: "作者",
  person: "责任人(全角色)",
  pr_owner: "田主",
  pr_committer: "Committer",
  issue_maintainer: "关联 Issue 维护人",
  state: "状态",
  ci: "CI 状态",
  draft: "提交状态",
  conflict: "代码冲突",
  merge_readiness: "合入条件",
  first_resp: "首次响应 SLA",
  review_status: "评审意见状态",
  has_issue: "关联 Issue",
  from: "创建自",
  to: "创建至",
};

const filterValueLabels: Record<string, Record<string, string>> = {
  author_role: {
    external: "外部贡献者 PR",
    internal: "内部开发者 PR",
  },
  state: {
    open: "开启 (Open)",
    merged: "已合入 (Merged)",
    closed: "已关闭 (Closed)",
    closed_loop: "已闭环 (合入+关闭)",
    all: "全部",
  },
  ci: {
    passed: "通过",
    failed: "未通过",
    running: "执行中",
    not_executed: "未执行",
  },
  draft: {
    ready: "就绪",
    draft: "草稿",
  },
  conflict: {
    no: "否 (无冲突)",
    yes: "是 (有冲突)",
  },
  merge_readiness: {
    ready: "合入就绪",
    blocked: "合入阻塞",
  },
  first_resp: {
    qualified: "首次响应达标 (≤24h)",
    unqualified: "首次响应未达标 (>24h)",
    open_noresp: "开启且未响应",
    open_timeout: "开启未响应超时 (>24h)",
  },
  review_status: {
    resolved: "已解决",
    unresolved: "未解决",
    no_opinion: "无意见",
  },
  has_issue: {
    yes: "已关联 Issue",
    no: "未关联 Issue",
  },
};

export const CI_LABELS: Record<string, { label: string; color: string }> = {
  passed: { label: "CI 通过", color: "green" },
  failed: { label: "CI 未通过", color: "red" },
  running: { label: "CI 执行中", color: "blue" },
  not_executed: { label: "CI 未执行", color: "" },
};

export const REVIEW_STATUS_LABELS: Record<
  string,
  { label: string; color: string }
> = {
  resolved: { label: "评审已解决", color: "green" },
  unresolved: { label: "评审未解决", color: "amber" },
  no_opinion: { label: "无评审意见", color: "" },
};

const presets: { label: string; params: Record<string, string> }[] = [
  { label: "全部 Open", params: {} },
  {
    label: "✅ 合入就绪",
    params: { state: "open", merge_readiness: "ready" },
  },
  {
    label: "🚧 合入阻塞",
    params: { state: "open", merge_readiness: "blocked" },
  },
  {
    label: "⏱️ 首响未达标",
    params: { state: "all", first_resp: "unqualified" },
  },
  {
    label: "🔥 开启未响应超时",
    params: { state: "open", first_resp: "open_timeout" },
  },
  {
    label: "🔗 已关联 Issue",
    params: { state: "all", has_issue: "yes" },
  },
  {
    label: "💬 评审未解决",
    params: { state: "open", review_status: "unresolved" },
  },
];

export function PRList({
  prs,
  dutyData,
  issueMap,
  hash,
  at,
}: {
  prs: PullRequest[];
  dutyData?: DutyData;
  issueMap: Map<string, Issue>;
  hash: string;
  at: string;
}) {
  const p = new URLSearchParams(hash.split("?")[1] || "");
  const value = (k: string, d = "") => p.get(k) || d;
  const set = (k: string, v: string) => {
    v ? p.set(k, v) : p.delete(k);
    p.delete("page");
    go(Object.fromEntries(p), "prs");
  };
  const setMulti = (updates: Record<string, string>) => {
    for (const [k, v] of Object.entries(updates)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    p.delete("page");
    go(Object.fromEntries(p), "prs");
  };

  const rangePreset = value("range");
  const authorQuery = value("author").toLowerCase();
  const authorExact =
    !!authorQuery &&
    prs.some((pr) => pr.author?.login?.toLowerCase() === authorQuery);

  const enriched: {
    pr: PullRequest;
    sla: PrSlaDetail;
    attr: PrAttribution;
  }[] = prs.map((pr) => ({
    pr,
    sla: evaluatePrSla(pr, at),
    attr: resolvePrAttribution(pr, dutyData, issueMap),
  }));

  const allOwners = Array.from(
    new Set(enriched.flatMap((x) => x.attr.owners)),
  ).sort();
  const allCommitters = Array.from(
    new Set(enriched.flatMap((x) => x.attr.committers)),
  ).sort();
  const allIssueMaintainers = Array.from(
    new Set(enriched.flatMap((x) => x.attr.issueMaintainers)),
  ).sort();
  const allPeople = Array.from(
    new Set([...allOwners, ...allCommitters, ...allIssueMaintainers]),
  ).sort();

  const filtered = enriched.filter(({ pr, sla, attr }) => {
    const day = toBeijingDateStr(pr.created_at);
    const st = value("state", "open");
    const stateMatch =
      st === "all"
        ? true
        : st === "closed_loop"
          ? pr.state === "merged" || pr.state === "closed"
          : pr.state === st;
    if (!stateMatch) return false;
    if (value("repo") && pr.repo !== value("repo")) return false;
    if (
      value("author_role") &&
      (pr.author_role || "external") !== value("author_role")
    )
      return false;
    if (
      authorQuery &&
      !(authorExact
        ? pr.author.login.toLowerCase() === authorQuery
        : pr.author.login.toLowerCase().includes(authorQuery))
    )
      return false;
    if (
      value("person") &&
      !attr.owners.includes(value("person")) &&
      !attr.committers.includes(value("person")) &&
      !attr.issueMaintainers.includes(value("person"))
    )
      return false;
    if (value("pr_owner") && !attr.owners.includes(value("pr_owner")))
      return false;
    if (
      value("pr_committer") &&
      !attr.committers.includes(value("pr_committer"))
    )
      return false;
    if (
      value("issue_maintainer") &&
      !attr.issueMaintainers.includes(value("issue_maintainer"))
    )
      return false;
    if (value("ci") && pr.ci_status !== value("ci")) return false;
    if (
      value("draft") &&
      (value("draft") === "draft" ? !pr.draft : pr.draft)
    )
      return false;
    if (
      value("conflict") &&
      (value("conflict") === "yes" ? pr.mergeable : !pr.mergeable)
    )
      return false;
    if (
      value("merge_readiness") &&
      (value("merge_readiness") === "ready"
        ? !sla.isReadyToMerge
        : !sla.isBlockedMerge)
    )
      return false;
    if (value("first_resp")) {
      const fr = value("first_resp");
      if (fr === "qualified" && !sla.firstRespQualified) return false;
      if (fr === "unqualified" && !sla.firstRespUnqualified) return false;
      if (fr === "open_noresp" && !sla.openNoResp) return false;
      if (fr === "open_timeout" && !sla.openNoRespTimeout) return false;
    }
    if (value("review_status") && sla.reviewStatus !== value("review_status"))
      return false;
    if (
      value("has_issue") &&
      (value("has_issue") === "yes"
        ? attr.linkedIssues.length === 0
        : attr.linkedIssues.length > 0)
    )
      return false;
    if (value("from") && day < value("from")) return false;
    if (value("to") && day > value("to")) return false;
    if (value("q")) {
      const q = value("q").toLowerCase();
      const hay = [
        pr.title,
        `!${pr.number}`,
        `#${pr.number}`,
        pr.author.login,
        ...attr.owners,
        ...attr.committers,
        ...attr.issueMaintainers,
        ...attr.fields.map((f) => `${f.module} ${f.sub_field}`),
        ...attr.linkedIssues.map((li) => `${li.id} ${li.title}`),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const sort = value("sort", "stay_desc");
  filtered.sort((a, b) =>
    sort === "updated"
      ? Date.parse(b.pr.updated_at) - Date.parse(a.pr.updated_at)
      : sort === "created_desc"
        ? Date.parse(b.pr.created_at) - Date.parse(a.pr.created_at)
        : sort === "first_resp_desc"
          ? (b.sla.firstRespWorkHours ?? -1) - (a.sla.firstRespWorkHours ?? -1)
          : sort === "stay_asc"
            ? a.sla.stayWorkHours - b.sla.stayWorkHours
            : b.sla.stayWorkHours - a.sla.stayWorkHours,
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
    const displayVal =
      k === "repo" ? short(v) : filterValueLabels[k]?.[v] || v;
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
                  onClick={() => go(pr.params, "prs")}
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
            搜索标题关键词 / 编号 / 作者 / 田主 / Committer / 关联 Issue
            <div className="input-clear-wrap">
              <input
                className={value("q") ? "active-filter" : ""}
                placeholder="搜索标题关键词 / 编号 / 作者 / 田主 / Committer / 关联 Issue..."
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
          {select("repo", "归属仓", [
            ["", "全部仓库"],
            ...Array.from(new Set(prs.map((pr) => pr.repo))).map(
              (r) => [r, short(r)] as [string, string],
            ),
          ])}
          {select("author_role", "作者类型", [
            ["", "全部 PR"],
            ["external", "外部贡献者 PR"],
            ["internal", "内部开发者 PR"],
          ])}
          {select("state", "状态", [
            ["open", "开启 (Open)"],
            ["merged", "已合入 (Merged)"],
            ["closed", "已关闭 (Closed)"],
            ["closed_loop", "已闭环 (合入+关闭)"],
            ["all", "全部"],
          ])}
          {select("ci", "CI 状态", [
            ["", "全部"],
            ["passed", "通过"],
            ["failed", "未通过"],
            ["running", "执行中"],
            ["not_executed", "未执行"],
          ])}
          {select("draft", "提交状态", [
            ["", "全部"],
            ["ready", "就绪"],
            ["draft", "草稿"],
          ])}
          {select("conflict", "代码冲突", [
            ["", "全部"],
            ["no", "否 (无冲突)"],
            ["yes", "是 (有冲突)"],
          ])}
          {select("merge_readiness", "合入条件", [
            ["", "全部"],
            ["ready", "合入就绪"],
            ["blocked", "合入阻塞"],
          ])}
          {select("first_resp", "首次响应 SLA", [
            ["", "全部"],
            ["qualified", "首次响应达标 (≤24h)"],
            ["unqualified", "首次响应未达标 (>24h)"],
            ["open_noresp", "开启且未响应"],
            ["open_timeout", "开启未响应超时 (>24h)"],
          ])}
          {select("review_status", "评审意见状态", [
            ["", "全部"],
            ["resolved", "已解决"],
            ["unresolved", "未解决"],
            ["no_opinion", "无意见"],
          ])}
          {select("person", "责任人(全角色)", [
            ["", "全部"],
            ...allPeople.map((n) => [n, n] as [string, string]),
          ])}
          {select("pr_owner", "田主", [
            ["", "全部田主"],
            ...allOwners.map((n) => [n, n] as [string, string]),
          ])}
          {select("pr_committer", "Committer", [
            ["", "全部 Committer"],
            ...allCommitters.map((n) => [n, n] as [string, string]),
          ])}
          {select("issue_maintainer", "关联 Issue 维护人", [
            ["", "全部"],
            ...allIssueMaintainers.map((n) => [n, n] as [string, string]),
          ])}
          {select("has_issue", "关联 Issue", [
            ["", "全部"],
            ["yes", "已关联 Issue"],
            ["no", "未关联 Issue"],
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
          <button onClick={() => go({}, "prs")}>重置筛选</button>
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
            onClick={() => exportPrs(filtered, at, p.toString())}
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
            外部 PR 列表 <span className="count">{filtered.length}</span>
          </h2>
          <select
            aria-label="PR 排序"
            value={sort}
            onChange={(e) => set("sort", e.target.value)}
          >
            <option value="stay_desc">停留时长：最长优先</option>
            <option value="stay_asc">停留时长：最短优先</option>
            <option value="first_resp_desc">首次响应时长：最长优先</option>
            <option value="created_desc">最新创建</option>
            <option value="updated">最近更新</option>
          </select>
        </div>

        <div className="table-wrap">
          <table className="issues prs-table">
            <thead>
              <tr>
                {[
                  "代码仓 / 序号 / 标题",
                  "作者 (外部贡献者)",
                  "田主 / Committer (责任田)",
                  "关联 Issue & 内部维护人",
                  "状态 / CI / 提交 / 冲突 / 评审",
                  "停留 / 首次响应 / 评审滞留 / 时间",
                ].map((x) => (
                  <th key={x}>{x}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered
                .slice((page - 1) * 25, page * 25)
                .map(({ pr, sla, attr }) => {
                  const ciMeta =
                    CI_LABELS[pr.ci_status] || CI_LABELS.not_executed;
                  const revMeta =
                    REVIEW_STATUS_LABELS[sla.reviewStatus] ||
                    REVIEW_STATUS_LABELS.no_opinion;
                  return (
                    <tr
                      key={pr.id}
                      className={`issue-row ${selectedId === pr.id ? "active-row" : ""}`}
                      onClick={(e) => {
                        const target = e.target as HTMLElement;
                        if (target.closest("a, button")) return;
                        p.set("id", pr.id);
                        go(Object.fromEntries(p), "prs");
                      }}
                    >
                      <td>
                        <small className="blue">
                          {short(pr.repo)} !{pr.number}
                          {(pr.added_lines > 0 || pr.removed_lines > 0) && (
                            <span className="muted">
                              {" "}
                              (+{pr.added_lines} / -{pr.removed_lines})
                            </span>
                          )}
                        </small>
                        <button
                          className="text title"
                          onClick={() => {
                            p.set("id", pr.id);
                            go(Object.fromEntries(p), "prs");
                          }}
                        >
                          {pr.title}
                        </button>
                        <a href={pr.url} target="_blank" rel="noreferrer">
                          原始 PR ↗
                        </a>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="text author-btn"
                          onClick={() => set("author", pr.author.login)}
                        >
                          {pr.author.login}
                        </button>
                        <small className="muted">
                          修改文件 {pr.files?.length || 0} 个
                        </small>
                      </td>
                      <td>
                        {attr.fields.length > 0 ? (
                          <div className="tags">
                            {attr.owners.map((owner) => (
                              <button
                                key={"o-" + owner}
                                type="button"
                                className="tag blue"
                                onClick={() => set("pr_owner", owner)}
                              >
                                田主: {owner}
                              </button>
                            ))}
                            {attr.committers.map((committer) => (
                              <button
                                key={"c-" + committer}
                                type="button"
                                className="tag purple"
                                onClick={() => set("pr_committer", committer)}
                              >
                                Committer: {committer}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <span className="muted">—</span>
                        )}
                        {attr.fields.length > 0 && (
                          <small className="muted">
                            {attr.fields
                              .map(
                                (f) =>
                                  `${f.module}·${f.sub_field}${f.isFallback ? "(兜底)" : ""}`,
                              )
                              .join("、")}
                          </small>
                        )}
                      </td>
                      <td>
                        {attr.linkedIssues.length > 0 ? (
                          <>
                            <div className="tags">
                              {attr.linkedIssues.map((li) => (
                                <button
                                  key={li.id}
                                  type="button"
                                  className="tag green"
                                  title={li.title}
                                  onClick={() =>
                                    go(
                                      { state: "all", id: li.id },
                                      "issues",
                                    )
                                  }
                                >
                                  {short(li.repo)}#{li.number} ↗
                                </button>
                              ))}
                            </div>
                            {attr.issueMaintainers.length > 0 ? (
                              <small>
                                内部维护人：
                                {attr.issueMaintainers.map((m, idx) => (
                                  <span key={m}>
                                    {idx > 0 && "、"}
                                    <button
                                      type="button"
                                      className="text author-btn"
                                      onClick={() =>
                                        set("issue_maintainer", m)
                                      }
                                    >
                                      {m}
                                    </button>
                                  </span>
                                ))}
                              </small>
                            ) : (
                              <small className="amber">
                                关联 Issue 未分配内部维护人
                              </small>
                            )}
                          </>
                        ) : (
                          <span className="muted">未关联 Issue</span>
                        )}
                      </td>
                      <td>
                        <div className="tags">
                          <span
                            className={`tag ${
                              pr.state === "open"
                                ? "blue"
                                : pr.state === "merged"
                                  ? "green"
                                  : "purple"
                            }`}
                          >
                            {pr.state === "open"
                              ? "开启"
                              : pr.state === "merged"
                                ? "已合入"
                                : "已关闭"}
                          </span>
                          <span className={`tag ${ciMeta.color}`}>
                            {ciMeta.label}
                          </span>
                          <span
                            className={`tag ${pr.draft ? "amber" : "green"}`}
                          >
                            {pr.draft ? "草稿" : "就绪"}
                          </span>
                          {!pr.mergeable && (
                            <span className="tag red">代码冲突</span>
                          )}
                          {sla.isReadyToMerge && (
                            <span className="tag green">合入就绪</span>
                          )}
                          <span className={`tag ${revMeta.color}`}>
                            {revMeta.label}
                          </span>
                        </div>
                      </td>
                      <td>
                        <strong>{sla.stayWorkDays}</strong> 天（工作日）
                        <small
                          className={
                            sla.firstRespUnqualified
                              ? "red"
                              : sla.firstRespQualified
                                ? "green"
                                : "muted"
                          }
                        >
                          {sla.firstRespWorkHours !== null
                            ? `首响 ${sla.firstRespWorkHours.toFixed(1)}h${sla.respEligible ? (sla.firstRespQualified ? " (达标)" : " (超24h未达标)") : ""}`
                            : sla.openNoRespTimeout
                              ? `未响应滞留 ${sla.sinceCiWorkHours.toFixed(1)}h (超时)`
                              : sla.openNoResp
                                ? `待响应 ${sla.sinceCiWorkHours.toFixed(1)}h`
                                : "未触发门禁首响"}
                        </small>
                        {sla.reviewStayWorkHours !== null && (
                          <small className="muted">
                            评审滞留：{sla.reviewStayWorkHours}h
                          </small>
                        )}
                        <small className="muted">
                          创建：{fmt(pr.created_at)}
                        </small>
                        {(pr.merged_at || pr.closed_at) && (
                          <small className="muted">
                            闭环：{fmt(pr.merged_at || pr.closed_at)}
                          </small>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <p className="empty">
            没有符合条件的外部 PR。可以重置筛选条件或切换状态查看。
          </p>
        )}
        <div className="pagination">
          <span className="muted">每页 25 项 · 共 {filtered.length} 项</span>
          <button
            disabled={page <= 1}
            onClick={() => {
              p.set("page", String(page - 1));
              go(Object.fromEntries(p), "prs");
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
              go(Object.fromEntries(p), "prs");
            }}
          >
            下一页
          </button>
        </div>
      </section>
    </>
  );
}
