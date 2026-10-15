# 验证记录

验证日期：2026-10-15（北京时间）。

## 已执行

- 参考仓库检出：`KennChow/cann-radar`，commit `f8f9e584a71e0604b5f61c7ff6a1df61445fb3da`。
- 真实 GitCode v5 Issue、评论、成员、报告树、contents 接口探测；确认分页参数及 since 生效。
- GitHub `KennChow/cann-issue-dashboard` 创建成功；配置 GITCODE_API_TOKEN Actions Secret（加密上传，未公开）。
- Python 22 项自动化测试通过：精确 SLA 边界、角色回复、多责任人、时区、分页/总数、增量/重开、失败保留、未知/缺失字段、非公共数据拒绝、报告最新历史、路径安全和失败评论补采。
- TypeScript 类型检查及 Vite 生产构建通过。
- npm 生产依赖审计：0 vulnerabilities（registry.npmjs.org）。

## 上游约束

首次评论采集遭遇 HTTP 429。为此加入全局请求节流（至少 1.3 秒间隔）、线程共享冷却、持久化成功评论缓存及失败补采。返回 total_count 时完整性验证后停止分页，避免多余空页请求。任何未采集评论显示未知，不当作“无回复”。

新增真实发现：ge / tensorflow 含明确 confidential 记录，发布流水线排除这些记录；非公共记录隔离测试通过。

浏览器 3 项端到端测试已通过：统计下钻、URL 筛选恢复、详情弹层与键盘关闭、移动端无横向溢出、三种 HTML 导出、跨分页数量核对及 file:// 离线打开。测试使用真实首批快照。

## 后续结果

真实四仓指标、浏览器测试、Actions 与公开 Pages 验证将在执行成功后补充。本文不把尚未执行成功的步骤标记为完成。
