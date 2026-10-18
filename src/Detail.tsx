import { useEffect, useState } from "react";
import type { Issue } from "./types";
import { fmt, memberLabel } from "./shared";
import { Badges } from "./Badges";
import { exportView } from "./export";
import { evaluateIssueSla } from "./sla";

export function Detail({
  issue: i,
  issues = [],
  onSelect,
  close,
  at,
}: {
  issue: Issue;
  issues?: Issue[];
  onSelect?: (id: string) => void;
  close: () => void;
  at: string;
}) {
  const [copied, setCopied] = useState(false);
  const idx = issues.findIndex((x) => x.id === i.id);
  const prevIssue = idx > 0 ? issues[idx - 1] : undefined;
  const nextIssue =
    idx >= 0 && idx < issues.length - 1 ? issues[idx + 1] : undefined;
  const sla = evaluateIssueSla(i, at);

  useEffect(() => {
    setCopied(false);
  }, [i.id]);

  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    document.getElementById("detail-close")?.focus();
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (onSelect && (e.key === "ArrowLeft" || e.key === "k") && prevIssue) {
        onSelect(prevIssue.id);
      } else if (
        onSelect &&
        (e.key === "ArrowRight" || e.key === "j") &&
        nextIssue
      ) {
        onSelect(nextIssue.id);
      }
      if (e.key === "Tab") {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".drawer button:not(:disabled),.drawer a",
          ),
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
  }, [i.id, prevIssue, nextIssue]);

  const copyRef = () => {
    navigator.clipboard
      ?.writeText(`${i.repo}#${i.number} ${i.title}\n${i.url}`)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => {});
  };

  return (
    <div className="overlay" onClick={close}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="toolbar drawer-toolbar">
          <div className="drawer-id-group">
            <span className="blue">
              {i.repo} #{i.number}
            </span>
            <button
              type="button"
              className="btn-xs"
              data-no-export
              onClick={copyRef}
            >
              {copied ? "已复制 ✓" : "复制引用"}
            </button>
          </div>
          <div className="drawer-actions" data-no-export>
            {onSelect && issues.length > 1 && (
              <>
                <button
                  type="button"
                  className="btn-xs"
                  disabled={!prevIssue}
                  title="快捷键: ← 或 K"
                  onClick={() => prevIssue && onSelect(prevIssue.id)}
                >
                  ← 上一条
                </button>
                <button
                  type="button"
                  className="btn-xs"
                  disabled={!nextIssue}
                  title="快捷键: → 或 J"
                  onClick={() => nextIssue && onSelect(nextIssue.id)}
                >
                  下一条 →
                </button>
              </>
            )}
            <button
              className="btn-export"
              data-no-export
              onClick={() => exportView("Issue-" + i.number, ".drawer", at)}
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
              导出详情 HTML
            </button>
            <button data-no-export id="detail-close" onClick={close}>
              关闭 ×
            </button>
          </div>
        </div>
        <h2 id="detail-title">{i.title}</h2>
        <Badges i={i} />
        <p>
          <a
            className="external-cta"
            href={i.url}
            target="_blank"
            rel="noreferrer"
          >
            在 GitCode 跟进 ↗
          </a>
        </p>
        <dl className="meta-grid">
          <dt>提出人（创建者）</dt>
          <dd>{i.author.login}</dd>
          <dt>负责人</dt>
          <dd>
            {i.assignees
              .map(
                (a) =>
                  `${a.login}（${memberLabel[a.membership || "unknown"]}）`,
              )
              .join(", ") || "未分配"}
          </dd>
          <dt>内部维护人</dt>
          <dd>{i.workload_owner || "未分配"}</dd>
          <dt>内部责任归属</dt>
          <dd>
            {i.internal_assignment === "assigned"
              ? "已分配内部维护人"
              : i.internal_assignment === "missing"
                ? "未分配内部维护人"
                : "无法确认"}
            。内部依据四仓成员并集及人工确认补充名单，跨仓统一认定；多人负责时有一位内部人员即视为已落实。
          </dd>
          <dt>创建时间</dt>
          <dd>{fmt(i.created_at)}</dd>
          <dt>最近活动</dt>
          <dd>{fmt(i.updated_at)}</dd>
          <dt>源流程 / 优先级</dt>
          <dd>
            {i.source_status} / {i.priority || "未提供"}
          </dd>
          <dt>首次响应 SLA</dt>
          <dd>
            {sla.isSelfProcessed
              ? "自处理 Issue（提出人与责任人相同，官方口径不纳入首次响应达标率统计）"
              : sla.isMilestone
                ? "里程碑 Issue（官方口径不纳入首次响应达标率统计）"
                : sla.firstRespQualified
                  ? `达标（≤24h 有效工作日）· ${sla.firstRespWorkHours !== null ? `首次响应耗时 ${sla.firstRespWorkHours.toFixed(1)}h` : `未响应但停留仅 ${sla.stayWorkHours.toFixed(1)}h`}`
                  : `未达标（>24h 有效工作日）· ${sla.firstRespWorkHours !== null ? `首次响应耗时 ${sla.firstRespWorkHours.toFixed(1)}h` : `未响应且已停留 ${sla.stayWorkHours.toFixed(1)}h`}`}
          </dd>
          <dt>判定依据</dt>
          <dd>
            创建至快照 {i.metrics.age_hours.toFixed(1)}h（有效工作日停留{" "}
            {sla.stayWorkHours.toFixed(1)}h）；Open 且 &gt;336h 超期；264h &lt;
            age ≤336h 临期。未回复等待{" "}
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
            .map((e, n) => {
              const dotClass = e.kind.includes("回复")
                ? "dot-green"
                : e.kind.includes("关闭")
                  ? "dot-purple"
                  : e.kind.includes("创建")
                    ? "dot-blue"
                    : "dot-amber";
              return (
                <li key={n} className={dotClass}>
                  <strong>{e.kind}</strong> · <span>{fmt(e.at)}</span>
                  {e.detail && <small>{e.detail}</small>}
                </li>
              );
            })}
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
              <strong>{c.author.login}</strong> · {fmt(c.created_at)}
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
