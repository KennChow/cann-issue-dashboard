import { useEffect } from "react";
import type { Issue } from "./types";
import { fmt } from "./shared";
import { Badges } from "./Badges";
import { exportView } from "./export";
export function Detail({
  issue: i,
  close,
  at,
}: {
  issue: Issue;
  close: () => void;
  at: string;
}) {
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    document.getElementById("detail-close")?.focus();
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(".drawer button,.drawer a"),
        );
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    addEventListener("keydown", fn);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      removeEventListener("keydown", fn);
      document.body.style.overflow = overflow;
      old?.focus();
    };
  }, []);
  return (
    <div className="overlay" onClick={close}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="toolbar">
          <span className="blue">
            {i.repo} #{i.number}
          </span>
          <button
            data-no-export
            onClick={() => exportView("Issue-" + i.number, ".drawer", at)}
          >
            导出详情 HTML
          </button>
          <button data-no-export id="detail-close" onClick={close}>
            关闭 ×
          </button>
        </div>
        <h2 id="detail-title">{i.title}</h2>
        <Badges i={i} />
        <p>
          <a href={i.url} target="_blank" rel="noreferrer">
            在 GitCode 跟进 ↗
          </a>
        </p>
        <dl>
          <dt>创建者</dt>
          <dd>{i.author.login}</dd>
          <dt>负责人</dt>
          <dd>{i.assignees.map((a) => a.login).join(", ") || "未分配"}</dd>
          <dt>创建时间</dt>
          <dd>{fmt(i.created_at)}</dd>
          <dt>最近活动</dt>
          <dd>{fmt(i.updated_at)}</dd>
          <dt>源流程 / 优先级</dt>
          <dd>
            {i.source_status} / {i.priority || "未提供"}
          </dd>
          <dt>判定依据</dt>
          <dd>
            创建至快照 {i.metrics.age_hours.toFixed(1)}h；Open 且 &gt;336h
            超期；264h &lt; age ≤336h 临期。未回复等待{" "}
            {i.reply_status === "unreplied"
              ? i.metrics.age_hours.toFixed(1) + "h"
              : "—"}
            。回复仅接受非作者、非机器人、非系统命令的项目成员评论。
          </dd>
        </dl>
        <h3>原始描述</h3>
        <pre>{i.body || "无描述"}</pre>
        <h3>生命周期</h3>
        <ol className="timeline">
          {[
            { at: i.created_at, kind: "创建 Issue", detail: "" },
            ...(i.first_reply_at
              ? [
                  {
                    at: i.first_reply_at,
                    kind: "首次已验证成员回复",
                    detail: "",
                  },
                ]
              : []),
            ...i.events,
            ...(i.closed_at
              ? [{ at: i.closed_at, kind: "源平台关闭时间", detail: "" }]
              : []),
          ]
            .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
            .map((e, n) => (
              <li key={n}>
                {fmt(e.at)} · {e.kind}
                {e.detail && <small>{e.detail}</small>}
              </li>
            ))}
        </ol>
        <p className="muted">
          观测事件为采集发现时刻，不推断首次采集前的指派与重开历史；最近保留 100
          次变更。
        </p>
        <h3>评论 / 处理进度 ({i.comments.length})</h3>
        {!i.comments_complete && (
          <p className="amber">评论未完整同步，不能确认是否已回复。</p>
        )}
        {i.comments.map((c) => (
          <article className="comment" key={c.id}>
            <small>
              {c.author.login} · {fmt(c.created_at)}
            </small>
            <pre>{c.body}</pre>
          </article>
        ))}
        {!i.comments.length && <p className="muted">暂无已采集评论</p>}
        {i.reports.length > 0 && (
          <>
            <h3>AI 分析报告历史</h3>
            {i.reports.map((r, n) => (
              <p key={r.path}>
                <a href={r.url} target="_blank" rel="noreferrer">
                  {n === 0 ? "最新报告" : "历史报告"} · {fmt(r.at)} ↗
                </a>
              </p>
            ))}
            <p className="muted">辅助分析不改变 Issue 的真实状态。</p>
          </>
        )}
      </aside>
    </div>
  );
}
