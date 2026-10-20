import { useState } from "react";
import type { Data } from "./types";
import type { DutyData } from "./duty";
import { fmt, short, go } from "./shared";
import { computePrPersonWorkloads } from "./pr";

export function InternalMembers({
  data,
  dutyData,
}: {
  data: Data;
  dutyData?: DutyData;
}) {
  const [query, setQuery] = useState("");
  const [onlyWithOpen, setOnlyWithOpen] = useState(false);
  const directory = data.internal_directory;
  if (!directory)
    return <section className="panel">等待内部人员总表首次同步。</section>;

  const ownerMap = new Map(
    data.owners.map((o) => [o.person.login.toLowerCase(), o]),
  );

  const allIssues = Object.values(data.repositories).flatMap((r) => r.issues);
  const allPrs = Object.values(data.repositories).flatMap((r) => r.prs || []);
  const issueMap = new Map(allIssues.map((i) => [i.id, i]));
  const prWorkloads = computePrPersonWorkloads(
    allPrs,
    dutyData,
    issueMap,
    data.generated_at,
  );
  const prWorkloadMap = new Map(
    prWorkloads.map((w) => [w.name.toLowerCase(), w]),
  );

  const people = directory.people.filter((p) => {
    const matchQuery =
      !query.trim() ||
      p.login.toLowerCase().includes(query.trim().toLowerCase()) ||
      p.repos.some((r) =>
        short(r).toLowerCase().includes(query.trim().toLowerCase()),
      );
    const openCount = ownerMap.get(p.login.toLowerCase())?.stats.open || 0;
    return matchQuery && (!onlyWithOpen || openCount > 0);
  });

  return (
    <section className="panel">
      <div className="toolbar">
        <h2>
          四仓联合内部人员 ·{" "}
          {directory.people.filter((p) => p.confirmed).length} 人
          {query || onlyWithOpen ? (
            <span className="count">{people.length}</span>
          ) : null}
        </h2>
        <div className="owner-controls" data-no-export>
          <button
            type="button"
            className={`chip-btn ${onlyWithOpen ? "active" : ""}`}
            onClick={() => setOnlyWithOpen(!onlyWithOpen)}
          >
            仅看名下有 Open (
            {
              data.owners.filter(
                (o) => o.role === "internal" && o.stats.open > 0,
              ).length
            }
            )
          </button>
          <div className="input-clear-wrap">
            <input
              aria-label="搜索内部人员"
              className={query ? "active-filter" : ""}
              placeholder="搜索 GitCode 用户名"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                className="input-clear"
                aria-label="清空搜索"
                onClick={() => setQuery("")}
              >
                ×
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="muted">
        任一目标仓库的成员（含生态开发者），或人工补充名单中的人员，在四仓统一视为内部维护人。来源仓库不代表必须加入该仓库才能负责
        Issue。维护人回复仍按 Issue 所属仓库成员判定。更新：
        {fmt(directory.checked_at)}
      </p>
      {!directory.complete && (
        <p className="notice amber">
          部分仓库成员名单同步失败；旧来源仅供参考，未获当前证据的人员显示“待确认”，不会误判为外部开发者。
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>GitCode 用户名</th>
              <th>统一身份</th>
              <th>成员来源仓库</th>
              <th>人工补充依据</th>
              <th>名下 Open Issue</th>
              <th>关联外部 PR (Open / 总)</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const owner = ownerMap.get(p.login.toLowerCase());
              const openCount = owner?.stats.open || 0;
              const prWork = prWorkloadMap.get(p.login.toLowerCase());
              return (
                <tr key={p.login.toLowerCase()}>
                  <td>
                    <div className="member-cell">
                      <b className="avatar avatar-sm" aria-hidden="true">
                        {p.login.slice(0, 1).toUpperCase()}
                      </b>
                      <a
                        href={
                          "https://gitcode.com/" + encodeURIComponent(p.login)
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        {p.login}
                      </a>
                    </div>
                  </td>
                  <td>
                    <span className={`tag ${p.confirmed ? "blue" : "amber"}`}>
                      {p.confirmed ? "内部维护人" : "待确认"}
                    </span>
                  </td>
                  <td>
                    <div className="tags">
                      {p.repos.length ? (
                        p.repos.map((r) => (
                          <span key={r} className="tag">
                            {short(r)}
                          </span>
                        ))
                      ) : (
                        <span>—</span>
                      )}
                    </div>
                    {p.stale_repos.length > 0 && (
                      <small className="amber">
                        上次来源（待刷新）：
                        {p.stale_repos.map(short).join("、")}
                      </small>
                    )}
                  </td>
                  <td>{p.explicit_reason || "—"}</td>
                  <td>
                    <button
                      className={`text ${openCount > 0 ? "blue strong-num" : "zero"}`}
                      onClick={() => go({ workload_owner: p.login })}
                    >
                      {openCount}
                    </button>
                  </td>
                  <td>
                    {prWork && prWork.totalPrs > 0 ? (
                      <button
                        className={`text ${prWork.openPrs > 0 ? "green strong-num" : "blue"}`}
                        onClick={() =>
                          go(
                            { state: "all", issue_maintainer: p.login },
                            "prs",
                          )
                        }
                      >
                        {prWork.openPrs} / {prWork.totalPrs}
                      </button>
                    ) : (
                      <span className="zero">0</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!people.length && <p className="empty">没有匹配人员</p>}
    </section>
  );
}
