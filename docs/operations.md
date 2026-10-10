# 运维与联调

## 本机配置

- 项目：本地克隆的 `CodexConnector` 目录，默认别名 `connector`。
- 配置：项目根目录 `config.local.yaml`，可用 `CONNECTOR_CONFIG` 指定其他文件。
- 凭据：`%LOCALAPPDATA%\CodexConnector\.env`。字段为 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`；可用 `CONNECTOR_ENV_FILE` 指定位置。不要提交凭据或将其作为任务附件。
- 数据：`%LOCALAPPDATA%\CodexConnector\data`，包含 `connector.db`、文件快照、日志和配对文件。
- 启停：项目目录运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/service.ps1 start|status|stop`，将最后的参数替换为一个动作。
- 检查：`npm run doctor` 检查 CLI 版本、登录和机器人身份；不能代替真实消息联调。
- 配对码永久有效、可重复使用：`npm run pair` 保留原密钥并显示文件路径；`npm run pair -- --rotate` 轮换并更新 pairing-code.txt；`npm run pair -- --revoke` 撤销并删除本地副本。私聊 `/pair-revoke` 也能撤销。撤销后重启不会重新生成，已配对账号继续有效。
- 升级会保留 pairing-code.txt 中的旧密钥，包括已成功配对、被旧版本从数据库消耗的密钥。只在本地文件可校验时迁移，不把密钥输出到日志。删除文件本身不等于撤销，请使用撤销命令。

后台脚本核对 PID 与启动时间，避免误操作复用的 PID；停止通过本地文件请求正常关闭。日志为 `service.log` 和 `service-error.log`，每次脚本启动重写这两个日志。保留任务数据库；不要把整个数据目录当临时缓存删除。

## 飞书控制台

使用企业自建应用并启用机器人，将自己纳入应用可用范围，发布配置。事件与回调使用长连接：

- 接收消息事件 `im.message.receive_v1`。
- 卡片动作回调 `card.action.trigger`。
- 权限应覆盖机器人私聊消息读取、以应用身份发送消息、消息资源上传下载。权限标识通常为 `im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`im:resource`；以控制台对应接口的权限要求为准。
- 若启用群聊，另需群内 @机器人消息权限，并同时配置 `groupsEnabled: true` 和 `allowedChatIds`。默认关闭群聊。

真实身份接口、文件 API 和长连接已检查通过；这不代表事件订阅、发布范围或卡片回调已完成端到端验证。

## 消息使用

| 功能 | 命令或动作 |
| --- | --- |
| 命令菜单 | `list`、`/list`、`/help`，带常用入口按钮 |
| 项目列表 | `list projects`、`/list projects`，显示路径与当前选择，支持分页按钮 |
| 项目 | `/projects`、`/project connector` |
| 对话 | `/new 标题`、`/sessions`、`/use ID` |
| 发任务 | 直接发文字，保留当前对话上下文 |
| 状态 | `/tasks`、`/status [任务ID]` |
| 停止 | `/stop [任务ID]`；`/stop --all` 停止当前对话的任务 |
| 队列 | `/continue` 恢复当前对话队列 |
| 补充 | `/steer 新要求` 发送给正在执行的这一轮 |
| 审批 | 卡片允许/拒绝，或 `/approve ID`、`/deny ID` |
| 回答 | `/answer ID 回答`，或回复对应的追问消息 |
| 上传 | 先发文件/图片，再发任务；纯文件消息不会启动模型 |
| 文件列表 | `/files`、`/attach 附件ID` |
| 下载 | `/send 产物ID`，或点击结果中的文件按钮 |
| 现有文件 | `/send-path "项目内相对路径"`；工作区忙时拒绝 |
| 重发结果 | `/retry [任务ID]`，仅重试交付，不重跑模型 |
| 撤销配对密钥 | 私聊 `/pair-revoke`；不撤销已有账号授权 |

ID 可以使用无歧义的前缀。连续发来的任务在同一项目串行，不同项目默认最多两个并行。新建对话不会停止旧对话的任务。任务停止、失败或状态不明会暂停该对话队列；`/continue` 只恢复尚未执行的排队任务。

`list sessions`、`list tasks`、`list files` 也是对应列表命令的别名。只将以 list 开头的独立命令识别为菜单，普通任务文字仍交给 Codex。

## 流式任务卡片

新任务的排队提示、执行中回答和最终结果共用一张卡片。使用 CardKit JSON 2.0、`streaming_mode` 和文本流式更新 API，约 1.2 秒合并一次输出；不断到来的文本不会无限推迟刷新。结束时关闭流式状态，保留最终回答和文件按钮。Card ID、版本和消息 ID 持久化，发送重试复用同一实体。

审批/追问直接更新主卡片：上方显示简短请求，允许/拒绝或选项按钮可直接操作，完整命令、目录、权限或表单要求在默认收起的“审批详情/问题详情”里。进入交互时暂停流式模式，处理后恢复；不再另发审批卡片或“回答已送出”确认消息。同时到达的多个请求按顺序呈现。仍可用 `/approve`、`/deny`、`/answer`，或回复显示问题的主卡片。

命令执行、文件修改、工具调用和过程说明放在默认收起的“执行记录”里。开始与完成合并为同一项，卡片只显示最近 8 项，避免展开后无限增长；最终卡片保留折叠记录。数据库保留其余任务事件摘要。

超过约 5000 字符的回答保留一张预览卡，完整内容作为“完整回复.md”下载。只有保存完整文件失败时才退回分段消息以免丢失结果。用户主动查询、操作出错或发送文件仍可能产生相应消息。

应用需要 CardKit 创建/更新卡片权限，当前应用真实接口测试已通过。如收到明确的缺权限错误，自动退回同一条普通卡片的原地更新，日志会说明原因，不恢复原来的多张进度卡片。官方接口：[流式更新卡片](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview)。

## 项目与文件

在 YAML 的 `projects` 列表中添加 `id`、`alias`、`root`、`sandbox: workspace-write`、`autoSendExports: false`，重启服务生效。项目根目录必须存在且不能相互嵌套或重复。项目列表来自该配置，不自动读取桌面端项目列表。

输入复制到项目 `.codex-connector/sessions/<ID>/inputs`；每轮产物目录是 `.codex-connector/tasks/<ID>/exports`。模型会收到目录说明。清单可写成 `{"artifacts":[{"path":"report.pdf","name":"报告.pdf"}]}`，没有清单时收集 exports 第一层普通文件。其他目录的文件使用 `/send-path` 显式发送。

默认单文件 20 MiB，每轮最多 10 个产物，外部 blob 配额 1 GiB。传输串行预留单文件上限，因此接近配额时即便小文件也可能被拒绝。产物快照默认保留 7 天，待发送/失败交付引用的文件不会清除。对话输入为保留上下文不会自动清除；项目内输入与 exports、SQLite 和日志不计入 blob 配额，需按实际磁盘占用维护。

其他 Git 项目应在 `.git/info/exclude` 或项目 `.gitignore` 添加 `.codex-connector/`，防止提交临时输入/产物。网关不会替你修改其他项目的 Git 配置。不要同时让多个独立工具修改同一个工作区；调度锁只覆盖本服务管理的任务。

## 恢复与限制

SQLite 保存 Inbox、Outbox、会话、任务与交互；接收先持久化再返回。重新启动时恢复未执行任务和待发送结果。已派发但无法确认结束的任务标记 `interrupted_unknown`，不自动再次执行。已有文件改动不会回滚。远端发送超时的窗口可能导致重复消息，不能保证跨系统绝对 exactly-once。

Windows Job Object 管理 Codex 子进程树；正常停止会先请求 interrupt，超时后结束所属进程树。无法确认清理时隔离项目，检查日志后重启。停止服务也会终止正在执行的任务，不等同于暂停后从同一进程继续。

项目可设置 `approvalsReviewer: auto_review`，将审批交给 Codex 原生风险审核；普通操作经审核后可自动允许，高风险或授权不足的请求可能被拒绝，不保证全部转交人工。当前本机 connector 项目已启用此设置。未配置的项目默认 `user`，仍由用户审批。两种模式均保留 `on-request` 和原有沙箱，不使用 `never` 或无条件自动批准；仍发送到 Connector 的审批请求继续通过卡片或 `/approve`、`/deny` 处理。

配置修改需要重启 Connector 服务后生效，新建和恢复的会话均应用项目设置。请等待当前任务完成再重启，避免中断任务。本机曾出现 Windows sandbox helper 的 `helper_unknown_error: setup refresh had errors`；自动审核不修复沙箱故障，提权请求仍需经过风险审核。

支持独立图片和文件消息；富文本只提取文字/链接，不提取内嵌图片。交互式网页登录、桌面 UI 操作和远程主机调度不在当前版本范围内。个人本机使用优先，未完成多租户生产环境审计。

## 醒来后联调

1. 确认 status 显示运行，日志有 `Feishu WebSocket ready` 和 `CodexConnector running`。
2. 私聊发送配对命令，再 `/projects`，点击 connector 按钮。
3. 发送“只记住代号 ALPHA，不执行命令”，下一条问代号；验证连续对话。
4. `/new 测试` 后询问代号，再 `/sessions`、`/use` 返回原对话。
5. 上传小 TXT，要求读取并生成摘要 TXT 放入 exports；点击发送文件，下载核对内容。
6. 发一个允许中断的测试任务，执行 `/status` 和 `/stop`，确认状态结束；`/continue` 恢复队列。
7. 出现审批/追问时测试按钮或命令；若没有触发，保留此项待测，不刻意运行危险命令。

联调所需新增信息只有你的其他项目路径/别名（若需要）。无需提供个人 open_id、chat_id 或机器人 ID：配对和事件处理会获取这些标识。异常时提供任务 ID、发生时间与现象即可，勿贴 App Secret。
