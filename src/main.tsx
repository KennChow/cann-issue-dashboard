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
        <h1>数据加载失败</h1>
        <p>{error}</p>
        <button onClick={() => location.reload()}>重试</button>
      </main>
    );
  if (!data)
    return (
      <main>
        <h1>CANN · Issue 闭环监控</h1>
        <p role="status">正在读取同步数据…</p>
      </main>
    );
  const all = Object.values(data.repositories).flatMap((r) => r.issues);
  const p = params();
  const ownerRole = p.get("owner_role") || "";
  const visibleOwners = filterOwners(data, ownerRole);
  const view = hash.split("?")[0];
  const selected = all.find((i) => i.id === p.get("id"));
  const repo = p.get("repo") || "";
  const scope = repo ? all.filter((i) => i.repo === repo) : all;
  const stat = repo ? data.repositories[repo]?.stats || data.stats : data.stats;
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
              !view.includes("issues") && !view.includes("members") && !view.includes("duty")
                ? "active"
                : ""
            }
            href="#/dashboard"
          >
            运行总览
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
          <a
            className={view.includes("issues") ? "active" : ""}
            href="#/issues"
          >
            Issue 工作台
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
              {view.includes("duty") ? "GE 责任田查询" : view.includes("members")
                ? "内部责任人总表"
                : view.includes("issues")
                  ? "Issue 工作台"
                  : "让每一个问题得到回应"}
            </h1>
            <p className="muted">
              四仓公共 Issue · 责任归属 · 响应追踪 · 14 天闭环预警
            </p>
          </div>
          <div>
            {!view.includes("issues") && !view.includes("duty") && (
              <button
                data-no-export
                onClick={() =>
                  exportView(
                    view.includes("members") ? "内部责任人总表" : "大屏总览",
                    "main",
                    data.generated_at,
                  )
                }
              >
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
        {view.includes("duty") ? <Duty /> : view.includes("members") ? (
          <InternalMembers data={data} />
        ) : view.includes("issues") ? (
          <IssueList issues={all} hash={hash} at={data.generated_at} />
        ) : (
          <>
            <div className="toolbar">
              <h2>
                全局态势 <span className="muted">/ OPERATIONS</span>
              </h2>
              <select
                aria-label="总览仓库"
                value={repo}
                onChange={(e) =>
                  go(
                    e.target.value ? { repo: e.target.value } : {},
                    "dashboard",
                  )
                }
              >
                <option value="">全部仓库</option>
                {Object.keys(data.repositories).map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </div>
            <div className="cards">
              {cards.map((c) => (
                <button
                  key={c.key}
                  className={`metric ${c.color}`}
                  onClick={() => go({ ...c.filter, ...(repo ? { repo } : {}) })}
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
              回复身份无法确认：{stat.unknown} 项（不计入未回复）。快照计算于{" "}
              {fmt(data.generated_at)}。
            </p>
            <div className="grid three">
              <Chart title="仓库压力 / Open 与超期">
                <Bars
                  data={Object.entries(data.repositories).map(([name, r]) => ({
                    name: short(name),
                    open: r.stats.open,
                    overdue: r.stats.overdue,
                  }))}
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
                        "成功同步",
                      ].map((x) => (
                        <th key={x}>{x}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.repositories).map(([name, r]) => (
                      <tr key={name}>
                        <td>
                          <button
                            className="text"
                            onClick={() => go({ repo: name })}
                          >
                            {short(name)}
                          </button>
                        </td>
                        {cards.slice(0, 7).map((c) => (
                          <td key={c.key}>
                            <button
                              className={`text ${c.color}`}
                              onClick={() => go({ repo: name, ...c.filter })}
                            >
                              {r.stats[c.key]}
                            </button>
                          </td>
                        ))}
                        <td>{r.stats.closure_rate ?? "—"}%</td>
                        <td className="muted">{fmt(r.last_success)}</td>
                      </tr>
                    ))}
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
                <h2>责任人名下 Issue 数量</h2>
                <div className="owner-controls">
                  <select
                    aria-label="责任人类型"
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
                  .map((o) => (
                    <button
                      key={o.person.login}
                      className="owner"
                      onClick={() =>
                        go({
                          workload_owner: o.person.login,
                          ...(ownerRole ? { workload_role: ownerRole } : {}),
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
                          className={`tag ${o.role === "external" ? "amber" : ""}`}
                        >
                          {memberLabel[o.role] || memberLabel.unknown}
                        </span>
                        <b>{o.stats.open}</b>
                      </div>
                      <div className="workbar">
                        <i
                          style={{
                            width: `${(o.stats.open / Math.max(...visibleOwners.map((o) => o.stats.open), 1)) * 100}%`,
                          }}
                        />
                      </div>
                      <div className="tags">
                        <span>正常 {o.stats.normal}</span>
                        <span className="amber">
                          未回复 {o.stats.unreplied} · 临期 {o.stats.due_soon}
                        </span>
                        <span className="red">超期 {o.stats.overdue}</span>
                      </div>
                      <small>
                        {Object.entries(o.repos)
                          .map(([r, n]) => `${short(r)} ${n}`)
                          .join(" / ")}
                      </small>
                    </button>
                  ))}
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
          at={data.generated_at}
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
