import { RelatedIssue } from "./RelatedLinks";
import { useEffect, useState } from "react";
import type { Issue, PullRequest } from "./types";
import type { DutyData } from "./duty";
import { fmt } from "./shared";
import { exportView } from "./export";
import { evaluatePrSla, resolvePrAttribution } from "./pr";
import { CI_LABELS, REVIEW_STATUS_LABELS } from "./PRList";

export function PRDetail({
  pr,
  prs = [],
  dutyData,
  issueMap,
  onSelect,
  close,
  at,
}: {
  pr: PullRequest;
  prs?: PullRequest[];
  dutyData?: DutyData;
  issueMap: Map<string, Issue>;
  onSelect?: (id: string) => void;
  close: () => void;
  at: string;
}) {
  const [copied, setCopied] = useState(false);
  const idx = prs.findIndex((x) => x.id === pr.id);
  const prevPr = idx > 0 ? prs[idx - 1] : undefined;
  const nextPr = idx >= 0 && idx < prs.length - 1 ? prs[idx + 1] : undefined;
  const sla = evaluatePrSla(pr, at);
  const attr = resolvePrAttribution(pr, dutyData, issueMap);
  const ciMeta = CI_LABELS[pr.ci_status] || CI_LABELS.not_executed;
  const revMeta =
    REVIEW_STATUS_LABELS[sla.reviewStatus] || REVIEW_STATUS_LABELS.no_opinion;

  useEffect(() => {
    setCopied(false);
  }, [pr.id]);

  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    document.getElementById("detail-close")?.focus();
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (onSelect && (e.key === "ArrowLeft" || e.key === "k") && prevPr) {
        onSelect(prevPr.id);
      } else if (
        onSelect &&
        (e.key === "ArrowRight" || e.key === "j") &&
        nextPr
      ) {
        onSelect(nextPr.id);
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
  }, [pr.id, prevPr, nextPr]);

  const copyRef = () => {
    navigator.clipboard
      ?.writeText(`${pr.repo}!${pr.number} ${pr.title}\n${pr.url}`)
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
              {pr.repo} !{pr.number}
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
            {onSelect && prs.length > 1 && (
              <>
                <button
                  type="button"
                  className="btn-xs"
                  disabled={!prevPr}
                  title="快捷键: ← 或 K"
                  onClick={() => prevPr && onSelect(prevPr.id)}
                >
                  ← 上一条
                </button>
                <button
                  type="button"
                  className="btn-xs"
                  disabled={!nextPr}
                  title="快捷键: → 或 J"
                  onClick={() => nextPr && onSelect(nextPr.id)}
                >
                  下一条 →
                </button>
              </>
            )}
            <button
              className="btn-export"
              data-no-export
              onClick={() => exportView("PR-" + pr.number, ".drawer", at)}
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

        <h2 id="detail-title">{pr.title}</h2>
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
              ? "开启 (Open)"
              : pr.state === "merged"
                ? "已合入 (Merged)"
                : "已关闭 (Closed)"}
          </span>
          <span className={`tag ${ciMeta.color}`}>{ciMeta.label}</span>
          <span className={`tag ${pr.draft ? "amber" : "green"}`}>
            {pr.draft ? "草稿" : "就绪"}
          </span>
          <span className={`tag ${pr.mergeable ? "green" : "red"}`}>
            {pr.mergeable ? "无代码冲突" : "存在代码冲突"}
          </span>
          {sla.isReadyToMerge && <span className="tag green">合入就绪</span>}
          {sla.isBlockedMerge && <span className="tag amber">合入阻塞</span>}
          <span className={`tag ${revMeta.color}`}>{revMeta.label}</span>
        </div>

        <p>
          <a
            className="external-cta"
            href={pr.url}
            target="_blank"
            rel="noreferrer"
          >
            在 GitCode 查看 PR ↗
          </a>
        </p>

        <dl className="meta-grid">
          <dt>作者（外部贡献者）</dt>
          <dd>{pr.author.login}</dd>

          <dt>责任田归属（田主 / Committer）</dt>
          <dd>
            {attr.fields.length > 0 ? (
              attr.fields.map((f, i) => (
                <div key={i}>
                  <strong>{f.module}</strong> · {f.sub_field}
                  {f.isFallback ? "（兜底）" : ""}：田主{" "}
                  <strong>{f.owner}</strong> / Committer{" "}
                  <strong>{f.committer}</strong>
                </div>
              ))
            ) : (
              <span className="muted">暂无匹配的责任田配置</span>
            )}
          </dd>

          <dt>关联 Issue &amp; 内部维护人</dt>
          <dd>
            {attr.linkedIssues.length > 0 ? (
              attr.linkedIssues.map((li) => (
                <div key={li.id}>
                  <RelatedIssue issue={li} /> · 内部维护人：
                  <strong>
                    {li.internalMaintainers.join("、") || "未分配内部维护人"}
                  </strong>
                </div>
              ))
            ) : (
              <span className="muted">未关联 Issue</span>
            )}
          </dd>

          <dt>分支与代码变更</dt>
          <dd>
            <code>{pr.source_branch || "source"}</code> →{" "}
            <code>{pr.target_branch || "target"}</code> ·{" "}
            <span className="green">+{pr.added_lines}</span> /{" "}
            <span className="red">-{pr.removed_lines}</span>（共{" "}
            {pr.files?.length || 0} 个文件）
          </dd>

          <dt>创建时间 / 更新时间</dt>
          <dd>
            {fmt(pr.created_at)} / {fmt(pr.updated_at)}
          </dd>

          <dt>闭环时间</dt>
          <dd>{fmt(pr.merged_at || pr.closed_at)}</dd>

          <dt>CI 首次通过时间</dt>
          <dd>{pr.ci_passed_at ? fmt(pr.ci_passed_at) : "未通过 / 未执行"}</dd>

          <dt>首次响应 SLA</dt>
          <dd>
            {!sla.respEligible
              ? "未进入首次响应统计样本池（需处于开启或已合入、就绪、无代码冲突且 CI 通过）"
              : sla.firstRespQualified
                ? `达标（≤24h 有效工作日）· ${sla.firstRespWorkHours !== null ? `首次响应耗时 ${sla.firstRespWorkHours.toFixed(1)}h（${fmt(sla.firstHumanReplyAt)}）` : `未响应但 CI 通过后仅停留 ${sla.sinceCiWorkHours.toFixed(1)}h`}`
                : `未达标（>24h 有效工作日）· ${sla.firstRespWorkHours !== null ? `首次响应耗时 ${sla.firstRespWorkHours.toFixed(1)}h（${fmt(sla.firstHumanReplyAt)}）` : `CI 通过后未响应已滞留 ${sla.sinceCiWorkHours.toFixed(1)}h`}`}
          </dd>

          <dt>停留时长 &amp; 评审滞留</dt>
          <dd>
            有效工作日停留 <strong>{sla.stayWorkDays}</strong> 天（
            {sla.stayWorkHours.toFixed(1)}h） · 评审意见状态：
            <strong>{revMeta.label}</strong>
            {sla.reviewStayWorkHours !== null &&
              ` · 评审滞留时长：${sla.reviewStayWorkHours}h`}
          </dd>
        </dl>

        <h3>修改文件 ({pr.files?.length || 0})</h3>
        {pr.files?.length ? (
          <pre>{pr.files.join("\n")}</pre>
        ) : (
          <p className="muted">无文件变更记录</p>
        )}

        <h3>原始描述</h3>
        <pre>{pr.body || "无描述"}</pre>

        <h3>生命周期</h3>
        <ol className="timeline">
          {[
            { at: pr.created_at, kind: "创建 PR", detail: pr.author.login },
            ...(pr.ci_passed_at
              ? [{ at: pr.ci_passed_at, kind: "CI 流水线通过", detail: "" }]
              : []),
            ...(sla.firstHumanReplyAt
              ? [
                  {
                    at: sla.firstHumanReplyAt,
                    kind: "首次非作者真实用户响应",
                    detail: "",
                  },
                ]
              : []),
            ...(pr.merged_at
              ? [{ at: pr.merged_at, kind: "PR 已合入", detail: "" }]
              : pr.closed_at
                ? [{ at: pr.closed_at, kind: "PR 已关闭", detail: "" }]
                : []),
          ]
            .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
            .map((e, n) => {
              const dotClass = e.kind.includes("响应")
                ? "dot-green"
                : e.kind.includes("合入") || e.kind.includes("关闭")
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

        <h3>评论 / 检视记录 ({pr.comments.length})</h3>
        {!pr.details_complete && (
          <p className="amber">PR 详情或评论尚未完整同步。</p>
        )}
        {pr.comments.map((c) => (
          <article className="comment" key={c.id}>
            <small>
              <strong>{c.author.login}</strong> · {fmt(c.created_at)}
              {c.comment_type === "diff_comment" && (
                <span
                  className={`tag ${c.resolved ? "green" : "amber"}`}
                  style={{ marginLeft: 8 }}
                >
                  {c.resolved ? "评审意见已解决" : "评审意见未解决"}
                </span>
              )}
            </small>
            <pre>{c.body}</pre>
          </article>
        ))}
        {!pr.comments.length && <p className="muted">暂无已采集评论</p>}
      </aside>
    </div>
  );
}
