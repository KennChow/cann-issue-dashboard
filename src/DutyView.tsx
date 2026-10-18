import { useEffect, useMemo, useState } from "react";
import { dutyIndex, geFields, parseDuty, searchDuty } from "./duty";
import type { DutyData, DutyField, DutyMatch } from "./duty";

const kindColor: Record<DutyMatch["kind"], string> = {
  明确归属: "green",
  包含的责任田: "blue",
  目录规则推断: "blue",
  模糊候选: "amber",
  拼写近似: "amber",
  兜底归属: "",
};

function People({ fields, data }: { fields: DutyField[]; data: DutyData }) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const people = fields.length
    ? fields
    : [{ module: "GE", ...data.repo_fallbacks.ge }];
  return (
    <div className="duty-people-list">
      {people.map((f, i) => {
        const text = `田主: ${f.owner.name} / Committer: ${f.committer.name} (${f.module} · ${f.sub_field})`;
        return (
          <div key={i} className="duty-person-item">
            <div>
              <strong>{f.owner.name}</strong> <span className="muted">/</span>{" "}
              {f.committer.name}
              <small className="muted">
                {f.module} · {f.sub_field}
                {!fields.length && "（兜底）"}
              </small>
            </div>
            <button
              type="button"
              className="btn-xs"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(text)
                  .then(() => {
                    setCopiedIdx(i);
                    setTimeout(() => setCopiedIdx(null), 1500);
                  })
                  .catch(() => {});
              }}
            >
              {copiedIdx === i ? "已复制 ✓" : "复制"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function Duty() {
  const [data, setData] = useState<DutyData>();
  const [query, setQuery] = useState("");
  const [moduleFilter, setModuleFilter] = useState("");
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

  const allGeFields = data ? geFields(data) : [];
  const modules = Array.from(new Set(allGeFields.map((f) => f.module)));
  const visibleFields = moduleFilter
    ? allGeFields.filter((f) => f.module === moduleFilter)
    : allGeFields;

  return (
    <div className="duty-view">
      {data && (
        <section className="panel duty-search">
          <h2>查找田主与 Committer</h2>
          <label htmlFor="duty-query">GE 仓库链接、文件路径或关键词</label>
          <div className="input-clear-wrap duty-input-wrap">
            <input
              id="duty-query"
              className={query.trim() ? "active-filter" : ""}
              value={query}
              placeholder="例如 compiler/graph/build/stream、stream_allocator.cc、内存"
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                className="input-clear"
                aria-label="清空查询"
                onClick={() => setQuery("")}
              >
                ×
              </button>
            )}
          </div>
          <p className="muted">
            支持 GitCode / GitHub
            文件与目录链接、绝对路径、相对路径、名称片段和近似拼写。多个候选全部列出；明确路径按最长目录前缀归属。查询不会上传。
          </p>
          <div className="duty-shortcuts">
            <span className="muted">常用示例：</span>
            {["examples", "docs", "stream_allocator.cc", "内存"].map((q) => (
              <button
                key={q}
                type="button"
                className={`chip-btn ${query === q ? "active" : ""}`}
                onClick={() => setQuery(q)}
              >
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
              <p role="status" className="duty-status">
                共 <strong>{result.matches.length}</strong>{" "}
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
                            <span className={`tag ${kindColor[m.kind] || ""}`}>
                              {m.kind}
                            </span>
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
      <section className="panel">
        <div className="toolbar">
          <h2>GE 责任田分工表</h2>
          {modules.length > 1 && (
            <div className="duty-shortcuts">
              <button
                type="button"
                className={`chip-btn ${!moduleFilter ? "active" : ""}`}
                onClick={() => setModuleFilter("")}
              >
                全部模块
              </button>
              {modules.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`chip-btn ${moduleFilter === m ? "active" : ""}`}
                  onClick={() => setModuleFilter(m)}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>
        <p className="muted">
          按模块查看目录分工，或在上方输入路径查找田主和 Committer。
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
              {allGeFields.length} 个责任田 · {data.files?.length || 0}{" "}
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
                  {visibleFields.map((f, i) => (
                    <tr key={i}>
                      <td>
                        <span className="tag blue">{f.module}</span>
                      </td>
                      <td>
                        <strong>{f.sub_field}</strong>
                      </td>
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
            <p className="fallback-note">
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
    </div>
  );
}
