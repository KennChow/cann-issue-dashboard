import type { Issue, PullRequest } from "./types";
import type { PrAttribution, PrSlaDetail } from "./pr";
const escape = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const time = (v: string) =>
  new Date(v).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
function styles() {
  return Array.from(document.styleSheets)
    .flatMap((sheet) => {
      try {
        return Array.from(sheet.cssRules)
          .filter((r) => !r.cssText.startsWith("@import"))
          .map((r) => r.cssText);
      } catch {
        return [];
      }
    })
    .join("\n");
}
function save(title: string, body: string, at: string) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>${styles()} body{background:#080f1e}.export-note{padding:15px 3.5%;border-bottom:1px solid #344663;color:#9fb5d1;font-size:12px}.owner-grid{max-height:none}.drawer{width:auto;height:auto;border:0;max-width:1100px;margin:auto}.table-wrap{overflow:visible}table.issues{min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere}details{margin:14px 0}.export-issue{break-inside:avoid}@media print{body{background:white;color:#111}.panel,.owner{background:white;color:#111}.muted{color:#555}.chart{break-inside:avoid}}</style></head><body><div class="export-note"><strong>${escape(title)}</strong> · 数据快照：${escape(time(at))}（北京时间） · 导出：${escape(time(new Date().toISOString()))} · 静态离线文件</div>${body}</body></html>`;
  const url = URL.createObjectURL(
    new Blob([html], { type: "text/html;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `cann-${title}-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function exportView(title: string, selector: string, at: string) {
  const source = document.querySelector(selector);
  if (!source) return;
  const clone = source.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[data-no-export],script").forEach((n) => n.remove());
  clone.querySelectorAll("button").forEach((n) => {
    const span = document.createElement("span");
    span.className = n.className;
    span.innerHTML = n.innerHTML;
    n.replaceWith(span);
  });
  clone.querySelectorAll("select,input").forEach((n) => {
    const span = document.createElement("span");
    span.textContent =
      n instanceof HTMLSelectElement
        ? n.selectedOptions[0]?.textContent || ""
        : (n as HTMLInputElement).value;
    n.replaceWith(span);
  });
  clone
    .querySelectorAll('a[href^="#"]')
    .forEach((n) => n.removeAttribute("href"));
  save(title, clone.outerHTML, at);
}
export function exportIssues(issues: Issue[], at: string, filters: string) {
  const link = (url: string, label: string) =>
    `<a href="${escape(url)}" target="_blank" rel="noreferrer">${escape(label)} ↗</a>`;
  const rows = issues
    .map(
      (i) =>
        `<tr><td>${escape(i.repo)} #${escape(i.number)}<br>${link(i.url, i.title)}</td><td>${escape(i.author.login)}<br>内部维护人：${escape(i.workload_owner || "未分配")}<br>责任人：${escape(i.assignees.map((a) => a.login).join(", ") || "未分配")}</td><td>${i.metrics.no_internal_assignee ? "未分配内部维护人<br>" : i.state === "open" && (!i.internal_assignment || i.internal_assignment === "unknown") ? "内部维护人无法确认<br>" : ""}${escape(i.state)} / ${escape(({ replied: "已回复", unreplied: "未回复", unknown: "无法确认" } as Record<string, string>)[i.reply_status])}<br>${i.metrics.overdue ? "已超期 " + i.metrics.overdue_hours.toFixed(1) + "h" : i.metrics.due_soon ? "即将超期" : i.state === "closed" ? "已关闭" : "正常"}</td><td>${escape(time(i.created_at))}<br>${escape(time(i.updated_at))}</td><td>${i.metrics.age_hours.toFixed(1)}h<br>${i.state === "open" ? "距离期限 " + i.metrics.remaining_hours.toFixed(1) + "h" : ""}</td><td>${escape(i.labels.join(", "))}<br>${i.reports.map((r, n) => link(r.url, (n === 0 ? "最新 AI 分析" : "历史 AI 分析") + " " + time(r.at))).join("<br>")}</td></tr>`,
    )
    .join("");
  save(
    "Issue筛选结果",
    `<main><h1>Issue 筛选结果 · ${issues.length} 项</h1><p>筛选参数：${escape(filters || "默认 Open")}；包含全部分页结果，排序与页面一致。</p><section class="panel"><table class="issues"><thead><tr><th>仓库 / 编号 / 标题</th><th>创建者 / 责任人</th><th>状态</th><th>创建 / 更新</th><th>时长 / 期限</th><th>标签 / AI 报告</th></tr></thead><tbody>${rows}</tbody></table></section></main>`,
    at,
  );
}
export function exportPrs(
  items: { pr: PullRequest; sla: PrSlaDetail; attr: PrAttribution }[],
  at: string,
  filters: string,
) {
  const link = (url: string, label: string) =>
    `<a href="${escape(url)}" target="_blank" rel="noreferrer">${escape(label)} ↗</a>`;
  const rows = items
    .map(({ pr, sla, attr }) => {
      const dutyStr = attr.fields.length
        ? attr.fields
            .map(
              (f) =>
                `田主: ${escape(f.owner)} / Committer: ${escape(f.committer)} (${escape(f.module)}·${escape(f.sub_field)})`,
            )
            .join("<br>")
        : "—";
      const issueStr = attr.linkedIssues.length
        ? attr.linkedIssues
            .map(
              (li) =>
                `${link(li.url, `${li.repo}#${li.number}`)} 维护人: ${escape(li.internalMaintainers.join(", ") || "未分配")}`,
            )
            .join("<br>")
        : "无关联 Issue";
      return `<tr><td>${escape(pr.repo)} !${escape(pr.number)}<br>${link(pr.url, pr.title)}</td><td>${escape(pr.author.login)}</td><td>${dutyStr}</td><td>${issueStr}</td><td>${escape(pr.state)} / CI: ${escape(pr.ci_status)} / ${pr.draft ? "草稿" : "就绪"} / ${pr.mergeable ? "无冲突" : "有冲突"}</td><td>停留 ${sla.stayWorkDays}d<br>首响 ${sla.firstRespWorkHours !== null ? sla.firstRespWorkHours.toFixed(1) + "h" : "未响应"}<br>创建：${escape(time(pr.created_at))}</td></tr>`;
    })
    .join("");
  save(
    "外部PR筛选结果",
    `<main><h1>外部 PR 筛选结果 · ${items.length} 项</h1><p>筛选参数：${escape(filters || "默认 Open")}；包含全部分页结果，排序与页面一致。</p><section class="panel"><table class="issues"><thead><tr><th>仓库 / 序号 / 标题</th><th>作者</th><th>田主 / Committer</th><th>关联 Issue & 维护人</th><th>状态 / 门禁</th><th>停留 / 首响 / 时间</th></tr></thead><tbody>${rows}</tbody></table></section></main>`,
    at,
  );
}
