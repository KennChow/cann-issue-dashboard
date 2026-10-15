import { useState } from "react";
import type { Data } from "./types";
import { fmt, short, go } from "./shared";
export function InternalMembers({ data }: { data: Data }) {
  const [query, setQuery] = useState("");
  const directory = data.internal_directory;
  if (!directory)
    return <section className="panel">等待内部人员总表首次同步。</section>;
  const people = directory.people.filter((p) =>
    p.login.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="panel">
      <div className="toolbar">
        <h2>
          四仓联合内部人员 ·{" "}
          {directory.people.filter((p) => p.confirmed).length} 人
        </h2>
        <input
          aria-label="搜索内部人员"
          placeholder="搜索 GitCode 用户名"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <p className="muted">
        任一目标仓库的成员（含生态开发者），或人工补充名单中的人员，在四仓统一视为内部责任人。来源仓库不代表必须加入该仓库才能负责
        Issue。维护者回复仍按 Issue 所属仓库成员判定。更新：
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
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const owner = data.owners.find(
                (o) => o.person.login.toLowerCase() === p.login.toLowerCase(),
              );
              return (
                <tr key={p.login.toLowerCase()}>
                  <td>
                    <a
                      href={
                        "https://gitcode.com/" + encodeURIComponent(p.login)
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      {p.login}
                    </a>
                  </td>
                  <td>{p.confirmed ? "内部责任人" : "待确认"}</td>
                  <td>
                    {p.repos.map(short).join("、") || "—"}
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
                      className="text blue"
                      onClick={() => go({ workload_owner: p.login })}
                    >
                      {owner?.stats.open || 0}
                    </button>
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
