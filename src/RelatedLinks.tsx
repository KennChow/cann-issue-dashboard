import type { PullRequest } from "./types";
import type { LinkedIssueRef } from "./pr";
import { short } from "./shared";

export function indexRelatedPrs(prs: PullRequest[]) {
  const index = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    for (const issueId of new Set(pr.linked_issues || [])) {
      const related = index.get(issueId) || [];
      related.push(pr);
      index.set(issueId, related);
    }
  }
  return index;
}

export function RelatedPrs({ prs }: { prs: PullRequest[] }) {
  if (!prs.length) return <span className="muted">未关联 PR</span>;
  return (
    <div className="tags">
      {prs.map((pr) => (
        <span className="related-reference" key={pr.id}>
          <a href={pr.url} target="_blank" rel="noreferrer" title={pr.title}>
            {short(pr.repo)}!{pr.number} ↗
          </a>
          <span
            className={`tag ${pr.state === "merged" ? "green" : pr.state === "open" ? "blue" : "purple"}`}
          >
            {{ open: "开启", merged: "已合入", closed: "关闭" }[pr.state] ||
              "状态未知"}
          </span>
        </span>
      ))}
    </div>
  );
}

export function RelatedIssue({ issue }: { issue: LinkedIssueRef }) {
  return (
    <span className="related-reference">
      <a href={issue.url} target="_blank" rel="noreferrer" title={issue.title}>
        {short(issue.repo)}#{issue.number} ↗
      </a>
      <span className="tag" title="Issue状态">
        {issue.source_status || "状态未知"}
      </span>
    </span>
  );
}
