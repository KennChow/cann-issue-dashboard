# 运维与排障

- 401 / 403：检查 Actions Secret `GITCODE_API_TOKEN` 是否有效、是否可读取目标仓库。不要把 Token 放入日志、命令行参数或 JSON。
- 429 / 5xx：请求最多五次，支持 Retry-After（最多 60 秒）或指数退避与抖动；评论并发上限四，全局请求间隔至少 1.3 秒，429 冷却共享到所有线程。评论成功缓存 24 小时、缓存文件最多保留八天；增量会补查之前评论失败的 Issue。大量限流可将 pool 调为一。
- 某仓库失败：该仓库 issues 和 last_success 保留，error 更新；其他仓库继续同步。历史快照只在四仓完整同步时新增。工作流部署保留数据后报失败。
- 评论/成员失败：页面展示质量警告，信息不足显示“无法确认”；可在 config/repos.json 添加经过确认的 maintainers。只有名单完整且有维护机制时才加入 maintainers_complete，避免错误断言无回复。
- AI 索引失败：保留上次索引，展示错误，检查 index.ndjson 和分页树接口。不会用虚构链接填充。
- 首次没有数据：本地先执行 python3 -m collector.sync --full。API 无法采集时页面显示无数据，不能当作健康状态。
- 同步突然退出：JSON 用临时文件 + os.replace 原子替换，原文件可继续使用。脚本仅在完整处理完每仓后将结果纳入新快照。
- Pages 404：检查 Source 为 GitHub Actions、成功部署的 environment；确保访问仓库子路径的尾部 `/`。Hash 路由刷新不会请求服务器路径。
- Actions push 失败：检查 workflow permissions / branch protection；自动提交使用 GITHUB_TOKEN contents:write，禁止并行手工修改生成 JSON。
- Actions 定时未准时：schedule 不提供准点保证，查看实际 run 时间；手动 Run workflow 可补扫。
- 服务器定时触发：部署及管理方式见 [服务器定时任务](SERVER_SCHEDULER.md)，运行事件为 `workflow_dispatch`。
- 删除 `.cache/reports.json` 可重建缓存。它不是事实数据。
- 仓库迁移/删除：周全量将以当前仓库返回集合为准，旧对象仍可在 Git 历史找到；不会把消失对象伪造为 Closed。

## 定时调度探针

临时工作流 `Schedule probe`（`.github/workflows/schedule-probe.yml`）每 5 分钟匹配一次，并支持手动运行。
它只在日志和运行摘要中记录 UTC 执行时间、事件、Cron、actor、分支、提交和运行链接，无需 Secrets，
不执行采集、部署或邮件，也不占用业务工作流的并发组。

```bash
gh run list --repo KennChow/cann-issue-dashboard --workflow schedule-probe.yml --event schedule --limit 20
gh run list --repo KennChow/cann-issue-dashboard --workflow sync-deploy.yml --event schedule --limit 20
```

只有 `event: schedule` 的运行才能证明定时触发正常；手动运行成功仅验证探针可以执行。
GitHub 调度可能延迟，需观察多个匹配点。探针能触发而业务工作流在计划点后仍无记录时，
优先排查业务工作流；两者都长期没有记录时，进一步排查仓库/账号的调度限制。

完成诊断后删除探针文件，或先禁用以停止持续运行：

```bash
gh workflow disable schedule-probe.yml --repo KennChow/cann-issue-dashboard
```

添加或删除探针的提交可带 `[skip ci]`，避免其 push 触发现有业务工作流；该标记不影响 schedule。

## 手动恢复

```bash
npm ci
npm test
python3 -m collector.sync --full
python3 scripts/validate.py
npm run build
```

检查 data JSON 的 complete/errors/warnings 和页面日期，再推送或运行 Actions。日志 artifact 不含原始 HTTP URL、响应正文或 Token。公开内容可能包含 Issue 作者自行发布的文本，平台只保留所需用户 login/avatar，不采集成员邮箱。
