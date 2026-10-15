import { useEffect, useMemo, useState } from "react";
import { dutyIndex, geFields, parseDuty, searchDuty } from "./duty";
import type { DutyData, DutyField } from "./duty";

function People({ fields, data }: { fields: DutyField[]; data: DutyData }) {
  const people = fields.length
    ? fields
    : [{ module: "GE", ...data.repo_fallbacks.ge }];
  return (
    <>
      {people.map((f, i) => (
        <div key={i}>
          <strong>{f.owner.name}</strong> / {f.committer.name}
          <small className="muted">
            {f.module} · {f.sub_field}
            {!fields.length && "（兜底）"}
          </small>
        </div>
      ))}
    </>
  );
}

export function Duty() {
  const [data, setData] = useState<DutyData>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const index = useMemo(() => (data ? dutyIndex(data) : []), [data]);
  const result = useMemo(() => {
    if (!data || !query.trim()) return { matches: [], error: "" };
    try {
      return { matches: searchDuty(data, query, index), error: "" };
    } catch (e) {
      return { matches: [], error: (e as Error).message };
    }
  }, [data, query, index]);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    fetch("./data/duty.json", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw Error("责任田数据暂不可用，请稍后重试。");
        return response.json();
      })
      .then((value) => setData(parseDuty(value)))
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <div className="duty-view">
      <section className="panel">
        <h2>GE 责任田分工表</h2>
        <p className="muted">
          按模块查看目录分工，或在下方输入路径查找田主和 Committer。
        </p>
        {!data ? (
          error ? (
            <button onClick={() => setAttempt(attempt + 1)}>重新加载</button>
          ) : (
            <p role="status">正在加载责任田分工表…</p>
          )
        ) : (
          <>
            <p className="muted">
              {geFields(data).length} 个责任田 · {data.files?.length || 0}{" "}
              个索引文件
            </p>
            {!data.files && (
              <p className="notice amber">
                当前快照未包含文件索引，仅支持目录规则和责任田查询。
              </p>
            )}
            <div className="table-wrap">
              <table className="duty-table">
                <thead>
                  <tr>
                    <th>模块</th>
                    <th>责任田</th>
                    <th>田主</th>
                    <th>Committer</th>
                    <th>覆盖路径</th>
                  </tr>
                </thead>
                <tbody>
                  {geFields(data).map((f, i) => (
                    <tr key={i}>
                      <td>{f.module}</td>
                      <td>{f.sub_field}</td>
                      <td>{f.owner.name}</td>
                      <td>{f.committer.name}</td>
                      <td>
                        {f.paths
                          .filter((p) => p.repo === "ge")
                          .map((p, j) => (
                            <code key={j}>
                              {p.whole_repo ? "整个 GE 仓库" : p.prefix}
                            </code>
                          ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              其他部分（兜底）：田主{" "}
              <strong>{data.repo_fallbacks.ge.owner.name}</strong> / Committer{" "}
              <strong>{data.repo_fallbacks.ge.committer.name}</strong>
            </p>
          </>
        )}
        {error && (
          <p className="notice red" role="alert">
            {error}
          </p>
        )}
      </section>
      {data && (
        <section className="panel duty-search">
          <h2>查找田主与 Committer</h2>
          <label htmlFor="duty-query">GE 仓库链接、文件路径或关键词</label>
          <input
            id="duty-query"
            value={query}
            placeholder="例如 compiler/graph/build/stream、stream_allocator.cc、内存"
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
          <p className="muted">
            支持 GitCode / GitHub
            文件与目录链接、绝对路径、相对路径、名称片段和近似拼写。多个候选全部列出；明确路径按最长目录前缀归属。查询不会上传。
          </p>
          <div className="duty-shortcuts">
            {["examples", "docs", "stream_allocator.cc", "内存"].map((q) => (
              <button key={q} onClick={() => setQuery(q)}>
                {q}
              </button>
            ))}
          </div>
          {result.error && (
            <p role="alert" className="notice red">
              {result.error}
            </p>
          )}
          {query.trim() && !result.error && (
            <>
              <p role="status">
                共 {result.matches.length}{" "}
                个匹配路径，全部展示。模糊候选需结合路径确认。
              </p>
              {result.matches.length ? (
                <div className="table-wrap duty-results">
                  <table>
                    <thead>
                      <tr>
                        <th>匹配路径</th>
                        <th>匹配方式</th>
                        <th>田主 / Committer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.matches.map((m) => (
                        <tr key={m.path}>
                          <td>
                            <code>{m.path}</code>
                          </td>
                          <td>
                            <span className="tag">{m.kind}</span>
                          </td>
                          <td>
                            <People fields={m.fields} data={data} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="empty">
                  没有匹配结果。请尝试更短的路径片段或责任田名称。
                </p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
