import { useMemo, useState } from "react";
import { dutyIndex, geFields, parseDuty, searchDuty } from "./duty";
import type { DutyData, DutyField } from "./duty";

const PRIVATE_FILE =
  "https://api.github.com/repos/KennChow/cann-radar-private/contents/ge/duty.json";

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
  const [token, setToken] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState("");
  const index = useMemo(() => (data ? dutyIndex(data) : []), [data]);
  const result = useMemo(() => {
    if (!data || !query.trim()) return { matches: [], error: "" };
    try {
      return { matches: searchDuty(data, query, index), error: "" };
    } catch (e) {
      return { matches: [], error: (e as Error).message };
    }
  }, [data, query, index]);

  async function loadPrivate() {
    setBusy(true);
    setError("");
    const credential = token.trim();
    setToken("");
    try {
      const response = await fetch(PRIVATE_FILE, {
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: "application/vnd.github.raw+json",
        },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) {
        throw Error(
          response.status === 404 ||
            response.status === 403 ||
            response.status === 401
            ? "无权读取私有责任田文件，或文件尚未同步。请确认凭证有该仓库 Contents 只读权限。"
            : `私有数据读取失败（HTTP ${response.status}）`,
        );
      }
      setData(parseDuty(await response.json()));
      setSource("私有仓库 · ge/duty.json");
    } catch (e) {
      setError(
        e instanceof TypeError
          ? "无法连接 GitHub，请检查网络后重试，或选择本地文件。"
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="duty-view">
      <section className="panel">
        <h2>GE 责任田分工表</h2>
        <p className="muted">
          责任田数据保存在私有仓库。完成授权或导入后展示完整分工表，并可查询路径归属。
        </p>
        {!data ? (
          <>
            <form
              className="duty-access"
              onSubmit={(e) => {
                e.preventDefault();
                void loadPrivate();
              }}
            >
              <label htmlFor="duty-token">GitHub 只读访问凭证</label>
              <input
                id="duty-token"
                type="password"
                autoComplete="off"
                value={token}
                placeholder="仅授权 cann-radar-private 的 Contents: Read"
                onChange={(e) => setToken(e.target.value)}
              />
              <button type="submit" disabled={busy || !token.trim()}>
                {busy ? "正在读取…" : "读取私有分工表"}
              </button>
            </form>
            <p className="muted">
              凭证仅发送给
              GitHub，不保存。刷新页面后需重新授权，也可直接导入本地 JSON。
            </p>
            <label className="duty-import">
              导入本地责任田 JSON
              <input
                type="file"
                accept=".json,application/json"
                aria-label="导入责任田 JSON"
                disabled={busy}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setError("");
                  try {
                    setData(parseDuty(JSON.parse(await file.text())));
                    setToken("");
                    setSource("本地导入 · " + file.name);
                  } catch {
                    setError("文件无效：请选择符合责任田格式的 JSON 文件。");
                  }
                  e.target.value = "";
                }}
              />
            </label>
          </>
        ) : (
          <>
            <div className="toolbar">
              <p className="muted">
                {source} · {geFields(data).length} 个责任田 ·{" "}
                {data.files?.length || 0} 个索引文件
              </p>
              <button
                onClick={() => {
                  setData(undefined);
                  setQuery("");
                  setToken("");
                  setSource("");
                  setError("");
                }}
              >
                清除当前数据
              </button>
            </div>
            {!data.files && (
              <p className="notice amber">
                当前文件没有仓库文件索引：支持配置目录、完整路径和责任田搜索；同名文件搜索需要导入包含
                files 的私有索引版本。
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
