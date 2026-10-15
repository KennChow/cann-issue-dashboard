import type { Issue } from "./types";
import { fmt, short, go } from "./shared";
import { Badges } from "./Badges";
import { exportIssues } from "./export";
export function IssueList({
  issues,
  hash,
  at,
}: {
  issues: Issue[];
  hash: string;
  at: string;
}) {
  const p = new URLSearchParams(hash.split("?")[1] || "");
  const value = (k: string, d = "") => p.get(k) || d;
  const set = (k: string, v: string) => {
    v ? p.set(k, v) : p.delete(k);
    p.delete("page");
    go(Object.fromEntries(p));
  };
  const filtered = issues.filter((i) => {
    const m = i.metrics;
    const day = new Date(i.created_at).toLocaleDateString("en-CA", {
      timeZone: "Asia/Shanghai",
    });
    return (
      (!value("workload_role") ||
        i.assignees.find((a) => a.login === i.workload_owner)?.membership ===
          value("workload_role")) &&
      (!value("workload_owner") ||
        i.workload_owner === value("workload_owner")) &&
      (!value("repo") || i.repo === value("repo")) &&
      (!value("author") || i.author.login === value("author")) &&
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
        `${i.title} #${i.number}`
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
  const select = (key: string, label: string, options: [string, string][]) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={value(key, key === "state" ? "open" : "")}
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
  return (
    <>
      <section className="panel filters">
        <label className="search">
          搜索标题 / 编号
          <input
            placeholder="输入关键词或 #168"
            value={value("q")}
            onChange={(e) => set("q", e.target.value)}
          />
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
        {select("workload_owner", "工作量归属", [
          ["", "全部"],
          ...Array.from(
            new Set(issues.map((i) => i.workload_owner || "未分配")),
          )
            .sort()
            .map((n) => [n, n] as [string, string]),
        ])}
        {select("workload_role", "归属人身份", [
          ["", "全部"],
          ["internal", "内部责任人"],
          ["external", "外部开发者"],
        ])}
        {select("author", "创建者", [
          ["", "全部创建者"],
          ...Array.from(new Set(issues.map((i) => i.author.login)))
            .sort()
            .map((a) => [a, a] as [string, string]),
        ])}
        {select("state", "状态", [
          ["open", "Open"],
          ["closed", "Closed"],
          ["all", "全部"],
        ])}
        {select("assignment", "责任分配", [
          ["", "全部"],
          ["yes", "已分配"],
          ["no", "未分配"],
        ])}
        {select("internal", "内部责任人", [
          ["", "全部"],
          ["missing", "未分配内部责任人"],
          ["assigned", "已分配内部责任人"],
          ["unknown", "无法确认"],
        ])}
        {select("reply", "维护者回复", [
          ["", "全部"],
          ["replied", "已回复"],
          ["unreplied", "未回复"],
          ["unknown", "无法确认"],
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
        <label>
          创建自
          <input
            type="date"
            value={value("from")}
            onChange={(e) => set("from", e.target.value)}
          />
        </label>
        <label>
          创建至
          <input
            type="date"
            value={value("to")}
            onChange={(e) => set("to", e.target.value)}
          />
        </label>
        <button onClick={() => go()}>重置筛选</button>
      </section>
      <section className="panel">
        <div className="toolbar">
          <button
            data-no-export
            onClick={() => exportIssues(filtered, at, p.toString())}
          >
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
          <table className="issues">
            <thead>
              <tr>
                {[
                  "仓库 / 编号 / 标题",
                  "责任人与创建者",
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
                <tr key={i.id}>
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
                    {i.assignees.map((a) => a.login).join(", ") || "未分配"}
                    <small className="muted">创建者 {i.author.login}</small>
                  </td>
                  <td>
                    <Badges i={i} />
                  </td>
                  <td>
                    <small>{fmt(i.created_at)}</small>
                    <small className="muted">{fmt(i.updated_at)}</small>
                  </td>
                  <td>
                    {(i.metrics.age_hours / 24).toFixed(1)} 天
                    <small className={i.metrics.overdue ? "red" : "muted"}>
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
                        className="purple"
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
