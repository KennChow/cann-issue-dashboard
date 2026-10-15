# 验证记录

验证日期：2026-10-15（北京时间）。

## 已执行

- 参考仓库检出：`KennChow/cann-radar`，commit `f8f9e584a71e0604b5f61c7ff6a1df61445fb3da`。
- 真实 GitCode v5 Issue、评论、成员、报告树、contents 接口探测；确认分页参数及 since 生效。
- GitHub `KennChow/cann-issue-dashboard` 创建成功；配置 GITCODE_API_TOKEN Actions Secret（加密上传，未公开）。
- Python 23 项自动化测试通过：精确 SLA 边界、角色回复、多责任人、时区、分页/总数、增量/重开、失败保留、未知/缺失字段、非公共数据拒绝、报告最新历史、路径安全和失败评论补采。
- TypeScript 类型检查及 Vite 生产构建通过。
- npm 生产依赖审计：0 vulnerabilities（registry.npmjs.org）。

## 上游约束

首次评论采集遭遇 HTTP 429。为此加入全局请求节流（至少 1.3 秒间隔）、线程共享冷却、持久化成功评论缓存及失败补采。返回 total_count 时完整性验证后停止分页，避免多余空页请求。任何未采集评论显示未知，不当作“无回复”。

新增真实发现：ge / tensorflow 含明确 confidential 记录，发布流水线排除这些记录；非公共记录隔离测试通过。

浏览器 3 项端到端测试已通过：统计下钻、URL 筛选恢复、详情弹层与键盘关闭、移动端无横向溢出、三种 HTML 导出、跨分页数量核对及 file:// 离线打开。测试使用真实首批快照。

## 四仓真实数据验证

完成时刻：2026-10-15 11:42 北京时间。完整采集成功，无 errors/warnings；成员身份未知 0。

| 仓库 | 公共 Issue | Open | Closed | 未分配 | 未回复 | 超期 | 临期 | 有 AI 报告 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| cann/ge | 622 | 90 | 532 | 0 | 64 | 49 | 27 | 7 |
| cann/tensorflow | 44 | 21 | 23 | 1 | 18 | 2 | 15 | 3 |
| cann/metadef | 161 | 57 | 104 | 0 | 9 | 9 | 3 | 43 |
| cann/triton-inference-server-ge-backend | 63 | 20 | 43 | 9 | 13 | 10 | 2 | 0 |

合计 890 条公共 Issue；累计闭环率 78.88%。排除 11 条 confidential 记录（ge 10、tensorflow 1），未发布其内容。所有 Issue 的指标和全局统计通过独立 validate.py 重新计算一致性校验。

用户提供的 `metadef#168` 精确关联到 `2026/10/15/20261015_054724_426279_metadef_issue168/report.md`；只使用 manifest 明确的 repo/number，53 条 Issue 有报告，其余不显示链接。

批量评论优化后本轮仅 34 次请求，成功完成 ge/tensorflow 全量和另两仓增量。ge 1428 条评论按 target ID/编号验证到 622 条公共 Issue。已关闭 702 条未被错误归入首次采集当天；首次闭环率趋势只有当天一个观测点。

## 发布验证

GitHub 仓库已推送，Pages build_type=workflow 已启用。实际 Actions 运行与公开页面验证结果将在成功后追加。
