# CANN Issue Observatory

四个 GitCode 仓库的 Issue 闭环监控，静态 React 看板 + Python 采集 + GitHub Actions + GitHub Pages。只使用真实上游公共数据，不生成 AI 报告、不写入 GitCode Issue。

**发布范围：仅公共 Issue。** 实测公开仓库中也存在 `visibility_reason=confidential` 的记录；此类记录完全排除，不发布其内容，所有统计分母仅包含可公开 Issue。

- 看板：https://kennchow.github.io/cann-issue-dashboard/
- 源代码：https://github.com/KennChow/cann-issue-dashboard
- 参考项目：[cann-radar](https://github.com/KennChow/cann-radar)。参考其深色信息布局、GitCode v5 分页和 Pages 工作流，独立实现模型与交互。

## 功能

- 监控 `cann/ge`、`cann/tensorflow`、`cann/metadef`、`cann/triton-inference-server-ge-backend`。
- Open / Closed、未分配、维护者回复、14 天超期、3 天临期作为独立维度。
- 仓库对比、成员工作量、风险队列、年龄分布、真实创建/关闭日期及每日闭环率快照。
- URL 持久化组合筛选、排序、25 条分页、评论、生命周期观测、最新/历史 AI 报告。
- 大屏、当前筛选的**全部分页结果**、单个 Issue 详情均可导出独立 HTML，保留样式和 SVG 图表，离线可读；链接访问仍需要网络。
- 增量同步、每七天全量校验、有限重试、失败保留数据、每日快照最多 365 天。

## 本地运行

需要 Node.js 22、Python 3.9+（推荐 3.12）。Python 采集器仅使用标准库。

```bash
npm ci
npm test
# 令牌只在当前终端环境中设置，不写进源文件
export GITCODE_API_TOKEN='你的 GitCode API Token'
python3 -m collector.sync --full       # 首次 / 强制全量
python3 -m collector.sync              # 增量 + 到期全量
python3 -m collector.sync --repo cann/ge
python3 scripts/validate.py
npm run dev
```

```bash
npm run build
npx playwright install chromium
npx playwright test
npm run preview
```

`npm run dev` 默认 http://127.0.0.1:5173。仓库自带真实同步快照，无 Token 也可以查看已有数据。`config/repos.json` 定义仓库、补充维护者及机器人名单。Token 不会传给浏览器；不要把 `.env` 提交到 Git。

## 部署和自动化

1. Fork 或创建公开仓库，默认分支 `main`。
2. Settings → Secrets and variables → Actions，配置 `GITCODE_API_TOKEN`（只需要读取目标公共仓库）。
3. Settings → Pages → Source 选 **GitHub Actions**。
4. Actions → **Sync and deploy dashboard** → Run workflow；可勾选 `full`。
5. Pages URL 为 `https://<owner>.github.io/<repo>/`。Vite 使用相对资源路径；Hash 路由在子目录刷新无需 404 回退。

工作流 Cron：`0 1,3,6,8,10,12 * * *`，对应北京时间每天 09、11、14、16、18、20 点。GitHub 调度可能延迟，页面使用实际采集时间。公开仓库长期无活动时 GitHub 可能暂停 schedule，请检查 Actions 状态。

采集构建 job 仅有 contents:write；部署 job 仅有 pages:write、id-token:write。所有发布执行使用同一 concurrency group，避免并发数据提交。数据提交带 `[skip ci]` 且数据路径不触发 push 工作流。PR 检查不接触令牌、不部署。

同步失败的仓库保留之前数据，同时发布错误提示；发布后工作流仍标记失败，避免静默失败。日志 artifact 保留 30 天；Git 提交保留成功快照的审计记录。缓存缺失只会增加报告树请求量，不影响正确性。

## 指标口径

| 指标 | 定义 |
|---|---|
| 未分配 | Open 且 assignees 为空；不使用创建者代替负责人 |
| 未回复 | Open，完整评论中无有效项目成员回复；信息不足为“无法确认” |
| 有效回复 | 评论者为 API 确认的生态开发者/开发者/维护者/管理员，或配置维护者；排除作者、机器人、系统评论、以 `/` 开头的操作命令 |
| 超期 | Open 且 `now-created_at > 336h` |
| 即将超期 | Open 且 `264h < now-created_at <= 336h`，与超期不重叠 |
| 正常 | Open 且未进入时间预警；并不表示已分配或已回复 |
| 累计闭环率 | 当前已采集 Closed / (Open + Closed)，空集合显示 — |
| 人员统计 | 每个 Assignee 各计一次；全局以 repo + number 去重；无 Assignee 归入未分配 |
| 处理时长 | 创建至采集快照的时间，Closed 也保留该口径；真实关闭时间另列 |
| 每日新增 | 按真实 created_at 的北京时间日期分组 |
| 每日关闭 | 当前 Closed 的真实 finished_at/closed_at 按北京时间日期分组，缺失则不归日 |
| 闭环率趋势 | 从首次采集起每天最后一次完整四仓快照；不补造过去数据 |

重开后再次关闭的全部事件只有从运行后观测到的变更可追溯；源 API 的最终关闭时间不能还原所有历史关闭次数。状态统计统一由 `collector/model.py` 生成，页面不另算 SLA。

## 架构、数据与限制

详见 [架构及 API 调研](docs/ARCHITECTURE.md)、[运维与故障排查](docs/OPERATIONS.md)、[实际验证记录](docs/VERIFICATION.md)。

前端没有编辑 Issue 的功能；跟进操作通过原 GitCode 链接完成。历史责任归属只记录首次采集后的变化。成员身份是采集时的成员名单，不能证明历史评论时是否已经具有该角色。无可靠身份时显示未知。AI 索引依赖上游 `index.ndjson` 的明确身份字段；仅存在报告文件但未登记的项目不会猜测匹配。

数据文件保留每个当前 Issue 一条记录及评论；规模随 Issue 总数增长。每日统计保留 365 天，每个 Issue 最近 100 条观测变更。报告索引保留实际报告历史；数量增长后建议将 Closed 详情按仓库分片，当前四仓规模采用单 JSON 以简化一致性。Git 历史会增长，可按年度归档维护。

## 开源许可

MIT。此仓库独立实现，未复制参考项目业务代码。上游 Issue 与报告内容版权归原作者；本仓库软件许可不改变其内容许可。
