import type { Issue } from "./types";
import { replyLabel } from "./shared";
export function Badges({ i }: { i: Issue }) {
  return (
    <div className="tags">
      <span className={i.state === "closed" ? "tag green" : "tag blue"}>
        {i.state === "closed" ? "Closed" : "Open"}
      </span>
      {i.metrics.unassigned && <span className="tag amber">未分配</span>}
      {i.metrics.no_internal_assignee && (
        <span className="tag amber">未分配内部维护人</span>
      )}
      {i.state === "open" &&
        (!i.internal_assignment || i.internal_assignment === "unknown") && (
          <span className="tag">内部维护人无法确认</span>
        )}
      <span className={`tag ${i.reply_status === "unreplied" ? "amber" : ""}`}>
        {replyLabel[i.reply_status]}
      </span>
      {i.metrics.overdue && (
        <span className="tag red">
          超期 {i.metrics.overdue_hours.toFixed(1)}h
        </span>
      )}
      {i.metrics.due_soon && <span className="tag amber">即将超期</span>}
      {i.reports.length > 0 && <span className="tag purple">AI 分析</span>}
    </div>
  );
}
