# 服务器定时触发 GitHub Actions

项目部署在 `/home/developer/Workspace/cann-issue-dashboard`。服务器通过 GitHub
`workflow_dispatch` API 触发 `sync-deploy.yml`，采集、构建、Pages 发布及邮件仍由 GitHub Actions 执行。
服务器不需要 GitCode、SMTP 或私有数据仓库的凭证。

调度脚本直接读取 `.github/workflows/sync-deploy.yml` 中的 UTC Cron，按当前配置在北京时间
**周一至周六 09:13、10:13、11:13、12:13、14:13、15:13、16:13、17:13、18:13、19:13、20:13、21:13**
触发，周日不触发。使用 UTC 计算，不依赖服务器的显示时区。守护进程每 15 秒检查一次，实际 API 请求可能比计划点晚数秒。

## 凭证和网络

GitHub Token 放在服务器用户私有文件 `~/.config/cann-issue-dashboard/github-token`，权限必须为 `600`，
父目录建议 `700`。文件不放入 Git 仓库、进程参数、Supervisor 配置或日志。Token 需要目标仓库 Actions 写权限，
并能读取工作流配置和运行记录。初次部署通过 SSH 标准输入传递已有凭证。

若服务器访问 GitHub 需要代理，在 Supervisor 配置的 `environment` 中配置服务器自身的 HTTP 代理，
例如 `https_proxy="http://127.0.0.1:7890"`。不依赖 Mac 上的代理或 SSH 隧道。

```bash
cd /home/developer/Workspace/cann-issue-dashboard
python3 scripts/dispatch_scheduled.py --preview  # 显示未来时点，无网络请求
python3 scripts/dispatch_scheduled.py --check    # 检查凭证、工作流状态和线上 Cron
python3 scripts/dispatch_scheduled.py --probe    # 只触发诊断探针，验证服务器出站请求
```

## 守护和管理

Dev Space 容器没有运行 systemd，使用现有 Supervisor 自动启动调度进程、异常退出后重启，并轮转日志。
配置模板为 `deploy/scheduler-supervisor.conf`，部署到 `/etc/supervisor/conf.d/cann-issue-dashboard-scheduler.conf`。
仓库 `.cache/` 需要允许 `developer` 写入。

```bash
supervisorctl -c /etc/supervisor/supervisord.conf status cann-issue-dashboard-scheduler
tail -n 50 /home/developer/Workspace/cann-issue-dashboard/.cache/scheduler.log
supervisorctl -c /etc/supervisor/supervisord.conf stop cann-issue-dashboard-scheduler
supervisorctl -c /etc/supervisor/supervisord.conf start cann-issue-dashboard-scheduler
```

已存在进程管理器时，只对本项目执行 `reread` 和 `update cann-issue-dashboard-scheduler`，不重启整个 Supervisor。
容器保持运行即可，不需要保持本地 SSH 会话；如果 Dev Space 被停止或回收，期间无法触发。

## 去重和失败处理

- `.cache/scheduled-dispatch.json` 记录已处理的时点，文件锁及原子写入防止多个本地进程或重启后重复触发。
- 触发前检查线上该工作流在本时点之后是否已有运行；有则跳过。线上 Cron 保留作为备用。
  这属于尽力去重：GitHub 的 schedule 若在服务器触发之后才到达，仍可能产生第二次运行，现有 concurrency 只保证串行。
- 网络错误发生在提交前时，每 15 秒重试，最多补最近 10 分钟内的一个时点；不会集中补跑积压的全部历史时点。
- 提交前先持久化尝试记录；若 POST 超时、服务器返回 5xx 或进程中途崩溃，标记为 `uncertain`，不自动重发，避免重复邮件。
  必须先查看线上 Actions，确认是否已创建运行，再决定是否手动运行工作流。
- 本地与线上 Cron 不一致时停止该次触发并记录错误，更新服务器代码后恢复。GitHub 只接受触发请求，并不保证作业立刻开始或最终成功。

## 更新

```bash
cd /home/developer/Workspace/cann-issue-dashboard
git pull --ff-only origin main
python3 -m unittest discover -s tests -v
python3 scripts/dispatch_scheduled.py --check
supervisorctl -c /etc/supervisor/supervisord.conf restart cann-issue-dashboard-scheduler
```

只需在调整 Supervisor 配置后执行 `reread`、`update cann-issue-dashboard-scheduler`。
更新凭证文件后重启调度进程。线上运行列表中的事件类型为 `workflow_dispatch`，用于区分 GitHub 自带的 `schedule`。
