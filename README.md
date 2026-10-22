# CANN Issue Observatory

四个 GitCode 仓库的 Issue 闭环监控，静态 React 看板 + Python 采集 + GitHub Actions + GitHub Pages。只使用真实上游公共数据，不生成 AI 报告、不写入 GitCode Issue。

**发布范围：仅公共 Issue。** 实测公开仓库中也存在 `visibility_reason=confidential` 的记录；此类记录完全排除，不发布其内容，所有统计分母仅包含可公开 Issue。

- 看板：https://kennchow.github.io/cann-issue-dashboard/
- 源代码：https://github.com/KennChow/cann-issue-dashboard
- 参考项目：[cann-radar](https://github.com/KennChow/cann-radar)。参考其深色信息布局、GitCode v5 分页和 Pages 工作流，独立实现模型与交互。

## 功能

- 监控 `cann/ge`、`cann/tensorflow`、`cann/metadef`、`cann/triton-inference-server-ge-backend`。
- Open / Closed、未分配、维护者回复、14 天超期、3 天临期作为独立维度。
- 仓库对比、责任人名下 Issue 数量、年龄分布、真实创建/关闭日期及每日闭环率快照。
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

工作流 Cron：`13 1,2,3,4,6,7,8,9,10,11,12,13 * * 1-6`，对应北京时间周一至周六 09:13、10:13、11:13、12:13、14:13、15:13、16:13、17:13、18:13、19:13、20:13、21:13（周日不定时触发）。GitHub 调度可能延迟，页面使用实际采集时间。公开仓库长期无活动时 GitHub 可能暂停 schedule，请检查 Actions 状态。

采集构建 job 仅有 contents:write；部署 job 仅有 pages:write、id-token:write。所有发布执行使用同一 concurrency group，避免并发数据提交。数据提交带 `[skip ci]` 且数据路径不触发 push 工作流。PR 检查不接触令牌、不部署。

同步失败的仓库保留之前数据，同时发布错误提示；发布后工作流仍标记失败，避免静默失败。日志 artifact 保留 30 天；Git 提交保留成功快照的审计记录。缓存缺失只会增加报告树请求量，不影响正确性。

## 指标口径

| 指标 | 定义 |
|---|---|
| 未分配内部责任人 | Open 且没有任何 Assignee 属于四仓成员并集或人工补充内部人员总表；无人负责也计入；多人只需一位成员。成员信息不足时显示无法确认，不打此标签。内部不代表公司雇员身份 |
| 未分配 | Open 且 assignees 为空；不使用创建者代替负责人 |
| 未回复 | Open，完整评论中无有效项目成员回复；信息不足为“无法确认” |
| 有效回复 | 评论者为 API 确认的生态开发者/开发者/维护者/管理员，或配置维护者；排除作者、机器人、系统评论、以 `/` 开头的操作命令 |
| 超期 | Open 且 `now-created_at > 336h` |
| 即将超期 | Open 且 `264h < now-created_at <= 336h`，与超期不重叠 |
| 正常 | Open 且未进入时间预警；并不表示已分配或已回复 |
| 累计闭环率 | 当前已采集 Closed / (Open + Closed)，空集合显示 — |
| 人员统计 | 每条 Open Issue 只计入 API Assignee 顺序中的首位内部人员；无内部成员时计入首位责任人，并标外部开发者；成员信息不足显示无法确认；无 Assignee 归入未分配。四仓统一认定内部身份；合计等于全局 Open 总数 |
| 处理时长 | 创建至采集快照的时间，Closed 也保留该口径；真实关闭时间另列 |
| 每日新增 | 按真实 created_at 的北京时间日期分组 |
| 每日关闭 | 当前 Closed 的真实 finished_at/closed_at 按北京时间日期分组，缺失则不归日 |
| 闭环率趋势 | 从首次采集起每天最后一次完整四仓快照；不补造过去数据 |

重开后再次关闭的全部事件只有从运行后观测到的变更可追溯；源 API 的最终关闭时间不能还原所有历史关闭次数。状态统计统一由 `collector/model.py` 生成，页面不另算 SLA。

## 架构、数据与限制

详见 [架构及 API 调研](docs/ARCHITECTURE.md)、[运维与故障排查](docs/OPERATIONS.md)、[实际验证记录](docs/VERIFICATION.md)。

前端没有编辑 Issue 的功能；跟进操作通过原 GitCode 链接完成。历史责任归属只记录首次采集后的变化。成员身份是采集时的成员名单，不能证明历史评论时是否已经具有该角色。无可靠身份时显示未知。AI 索引依赖上游 `index.ndjson` 的明确身份字段；仅存在报告文件但未登记的项目不会猜测匹配。

数据文件保留每个当前 Issue 一条记录及评论；规模随 Issue 总数增长。每日统计保留 365 天，每个 Issue 最近 100 条观测变更。报告索引保留实际报告历史；数量增长后建议将 Closed 详情按仓库分片，当前四仓规模采用单 JSON 以简化一致性。Git 历史会增长，可按年度归档维护。

## GE 责任田查询

导航“责任田查询”（`#/duty`）自动展示完整分工表和路径查询，无需访客输入 Token 或导入文件。
源配置保存在 `KennChow/cann-radar-private/ge/duty.json`，不提交公共仓库。
部署工作流使用 Actions Secret `PRIVATE_REPO_PAT` 读取该文件，提取 GE 分工及文件索引，
只写入已忽略的 `dist/data/duty.json`，随 Pages 产物发布。网页显示和查询的数据可公开访问。
凭证仅在 CI 后台使用，不进入浏览器或发布产物。部署失败时保留上次已发布网站。

从 GE 工作区更新私有快照（脚本只写本地文件，不自动提交或推送）：

```bash
python3 scripts/sync_duty.py --ge-root /path/to/ge --private-checkout /path/to/cann-radar-private
```

脚本校验输出仓库的 origin，合并 `duty.json` 与 `git ls-files` 文件索引。随后在私有仓库中仅提交
`ge/duty.json`。文件索引对应本次 GE 检出快照，远端分支的新增文件需重新同步；没有索引的原始 JSON 仍支持目录规则查询。

查询支持 GitCode/GitHub GE 首页、blob/tree/raw 链接（含行号）、本地绝对/相对路径、名称片段、责任田或人员关键词和近似拼写。
明确路径按目录边界与最长前缀匹配；同长冲突全部展示。目录查询列出下级责任田，模糊查询不截断候选。
无显式归属的文件标记兜底；拼写近似不作为明确归属。链接仅解析路径，不抓取远端文件。
责任田页面不提供通用 HTML 导出。

仅更新网页时，可手动运行 **Deploy dashboard UI only** 工作流：复用现有公共 Issue 快照，
执行校验、构建和浏览器测试后发布 Pages，不触发 Issue 扫描和邮件，只从私有源读取所需的责任田文件，不读取其他私有配置。

## 开源许可

MIT。此仓库独立实现，未复制参考项目业务代码。上游 Issue 与报告内容版权归原作者；本仓库软件许可不改变其内容许可。

## 四仓内部人员总表

页面导航“内部责任人总表”合并四仓完整成员名单，按用户名忽略大小写去重，显示成员来源仓库、人工确认依据和名下 Open 数量，支持搜索与 HTML 导出。只要在任一仓库是成员，就在四仓统一作为内部责任人。`config/internal_people.json` 维护人工确认的内部开发者（login + reason）；已登记用户确认的 Chang-an-HW。该总表不推断雇佣关系，不修改 GitCode 成员权限。维护者回复判定仍使用 Issue 所属仓库成员，避免把跨仓身份当作该仓维护权限。

每次同步（包括 --repo）都会刷新四仓成员来源。部分来源失败时保留上次名单供追溯，但过期来源不作为当前确认依据；无法排除内部身份的人员显示未知，不误标外部。

## 扫描巡检报告与邮件

每次工作流扫描后同时生成 UTF-8 纯文字报告（`.cache/scan-report.txt`）与内联样式 HTML 报告（`.cache/scan-report.html`），包含以下核心模块：
邮件标题为 **[CANN] Issue / PR数据通报**，正文标题为 **Issue / PR数据通报**。

1. **全局概况与核心指标**：Issue 官方 SLA 指标，以及与 PR数据总览口径一致的全部 PR 核心指标（包含内部与外部贡献者）。
2. **各仓Issue多维统计明细**：各仓数量、闭环率、首次响应及风险指标。
3. **各仓外部PR多维统计明细**：各仓外部 PR 数量、合并/关闭、闭环率、首次响应及合并就绪状态。
4. **本次扫描Issue和外部PR变更明细**：分为 Issue、外部 PR 两小节，展示新增、闭环/合并/关闭、评论等变更。
5. **Issue重点跟踪清单**：未分配内部维护人、临期、即将响应超时及未响应超时的 Issue。
6. **各责任人名下Issue清单**：按当前指派及工作量责任人列出全部待处理 Issue，包含未分配条目。
7. **外部重点跟踪清单**：外部 PR 首响超时、待合并、合并受阻及未解决评审意见。
8. **各责任人名下PR清单**：按当前指派及工作量责任人列出全部待处理外部 PR，包含未分配条目。

外部 PR 范围与看板一致，排除 `author_role=internal` 的条目；多人负责的条目分别列入各人名下。PR 首响从 CI 通过时间（缺失时从创建时间）起算，使用与网页相同的工作日口径；采集警告会注明数据可能为保留值。纯文本和 HTML 使用相同章节顺序，空章节保留提示。

新增与变更以扫描前快照为基线，增量重叠窗口不会重复计数；首次运行无基线时会明确说明。失败报告注明保留数据及异常。手动触发和代码 push 扫描也发送报告；周日仅停用定时触发。

报告保存在 `.cache/scan-report.txt` 与 `.cache/scan-report.html`，Actions 的 `scan-report` artifact 保留 30 天。独立 mail job 发送 `multipart/alternative`（HTML + 纯文本回退）邮件，邮件失败会使工作流显示失败，但不阻断看板部署。邮件失败后可通过 Re-run failed jobs 重试 mail job，使用同一份报告；SMTP 部分投递成功时重试可能重复送达。

默认收件人为 `config/mail.json` 中的两个地址，可修改文件，或设置 Actions Variable `REPORT_RECIPIENTS`（英文逗号分隔）覆盖，无须改代码。

在 GitHub 仓库 Settings → Secrets and variables → Actions 配置：

| 类型 | 名称 | 含义 |
|---|---|---|
| Secret | SMTP_HOST | 发件服务 SMTP 主机 |
| Secret | SMTP_PORT | 默认 SSL 465；STARTTLS 587 |
| Secret | SMTP_SECURITY | `ssl`（默认）或 `starttls` |
| Variable | REPORT_RECIPIENTS | 可选，英文逗号分隔的收件地址 |
| Secret | SMTP_FROM | 发件邮箱 |
| Secret | SMTP_USERNAME | SMTP 登录账号 |
| Secret | SMTP_PASSWORD | SMTP 密码或邮箱授权码 |

未配置 SMTP 时报告仍生成、保存，mail job 明确失败。不会把 SMTP 密钥写入报告、前端或 Git 仓库。邮件为 `multipart/alternative`（包含 `text/plain; charset=utf-8` 与 `text/html; charset=utf-8`）。本地可用 `python3 -m collector.scan_report --previous <扫描前快照路径>` 生成报告，再设置上述环境变量并执行 `python3 -m collector.scan_report --send` 发送。

SMTP 配置沿用 `KennChow/cann-radar-private` 的 `smtp_config.ini`：`[smtp] server/port/username/password` 分别映射到对应 SMTP Secrets，`[mail] from` 映射到 `SMTP_FROM`，使用 SSL。配置安全导入 Secrets，工作流不直接拉取私有仓库；源配置更新后需同步更新 Secrets。
