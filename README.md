# CodexConnector

轻量飞书机器人网关：飞书长连接接收消息，通过本机 Codex App Server 执行任务。采用 TypeScript、SQLite 和官方飞书 SDK，无需 OpenClaw、Redis、公网回调服务。

已实现项目选择、连续对话、新建/切换对话、任务队列、查看/停止、执行中补充要求、审批/追问、结果回传、双向文件传输，以及断线恢复和交付重试。

## 当前机器直接使用

1. 在飞书打开机器人 **CodexConnector**。
2. 打开 `%LOCALAPPDATA%\CodexConnector\data\pairing-code.txt`，把其中的 `/pair ...` 发给机器人。配对码永久有效、可重复使用，直到主动撤销或轮换。已配对账号无需每次重新配对。
3. 发送 `list` 查看命令菜单，`list projects` 列出项目并点击选择，然后直接发送任务描述。也支持 `/list`、`/list projects` 和原有 `/projects`。
4. 发送 `/new 新任务` 新建对话；`/sessions` 列出对话；`/use <ID>` 切换。
5. 上传文件后再发送任务描述。结果中的文件按钮或 `/send <产物ID>` 可以取回产物。

```powershell
npm run check
npm test
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/service.ps1 start
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/service.ps1 status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/service.ps1 stop
```

服务脚本适用于这台 Windows 机器的默认数据目录。使用自定义 `dataDir` 时请用 `npm start` 前台运行，Ctrl+C 停止。机器睡眠、关机或退出服务后，机器人不能执行任务；未安装开机自启动。

## 文档

- [配置、命令与联调清单](docs/operations.md)
- [架构设计](docs/architecture.md)
- [测试记录与限制](docs/test-report.md)

项目配置在 `config.local.yaml`。凭据在项目外的 `%LOCALAPPDATA%\CodexConnector\.env`，无需再次发送 App Secret。新增项目只需提供本机绝对路径和希望使用的别名。

每个任务使用一张飞书原生流式卡片，从排队、文字生成、审批/追问到最终结果原地更新。允许/拒绝按钮就在主卡片，处理后不另发确认卡片；命令、文件修改与过程说明默认折叠，只显示最近 8 项记录。长回复提供完整 Markdown 文件，实际文件传输仍使用独立消息。配对密钥可在私聊发送 `/pair-revoke` 撤销；本机 `npm run pair -- --rotate` 生成新密钥，`npm run pair -- --revoke` 撤销。撤销密钥不取消已经配对的账号。

运行依赖 Node.js 24 和已登录的 Codex CLI 0.144.1。Codex 升级后须同步协议类型并重新测试。此网关创建自己的 Codex thread，不承诺自动出现在桌面端侧栏，也不操作桌面 UI。
