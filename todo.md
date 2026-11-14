# BobBot (`bob-bot`) — 待办需求池 (Backlog)

> 当前正在施工的任务见 [docs/CURRENT_STAGE.md](docs/CURRENT_STAGE.md)。本文件按阶段记录待办项。

## ✅ 已交付（2026-11 原型，线上 https://ry.bobbik.org）

- [x] 一键部署到 RY（`scripts/deploy-ry.sh`）+ 构建戳 `/api/version`
- [x] 卡片化对话、Orb 状态动效、中英双语、语音输入
- [x] 会话重命名、桌面悬停操作、恢复上次页面、3 小时新会话
- [x] 文员页只保留待办/定时任务/收件箱；渠道与时区移入设置
- [x] 官方微信 iLink 桥（扫码登录、私聊会话、提醒渠道、bob-agent 兼容 API）
- [x] PWA + APNs 手机通知（iOS），Android APK 方案写入架构文档
- [x] 长期记忆、夜间做梦整合、主动关心与 0–1 主动性档位
- [x] 受控功能包（工具 + 路由 + 面板，审批与失败隔离）
- [x] 浏览器引擎升级（框架/Shadow DOM、标签页、下载上传、地址检查、崩溃恢复）
- [x] 定时任务运行记录、如实状态、登录过期后「去处理」并重跑、审批推送
- [x] 对话存为 Routine（真实步骤、校验、停下问人的点、缺数据兜底、试运行后启用）
- [x] 定时任务的待批草稿（保存确切动作，批准后不经模型执行）
- [x] 记忆注入所有对话与任务；修复做梦和主动关心的回合等待
- [x] Bob 可改自己：沙箱功能包（工具/接口/小部件/样式）+ 3 分钟试用、保留或自动回退
- [x] 多供应商模型档案（DeepSeek/OpenAI/Anthropic/Gemini/OpenRouter/自定义）与设置页五组导航
- [x] 对话内发布图表页（沙箱预览 + 打开链接）与审批「本任务内同类操作」放行

## 🔜 下一步（原型优先级）

- [ ] 用 3~5 个真实办公站点验证浏览器能力，记录风控与失败点
- [ ] MCP 写入类工具纳入审批；API Key 按 AGENTS.md 用 AEAD 加密落盘
- [ ] 微信消息排队、回复「同意/拒绝」完成审批
- [ ] Android APK 客户端（厂商推送通道，不走 FCM）
- [ ] 邮件 / Server酱 / Bark 兜底提醒渠道
- [ ] 主动关心的接受率学习（忽略则收紧、接受则放宽）
- [ ] 用户正在对话时把提醒注入当前回复，而不是另起一条
- [ ] 审批卡风险分级（不可逆 / 外部副作用 / 设置变更）与拒绝后本轮不再重试
- [ ] 功能包进一步隔离：独立系统用户、限制访问本机回环端口；`run_command` 对程序目录只读
- [ ] 把内置能力（文员、记忆、渠道）逐步迁成功能包，核心只留登录、审批、密钥、花费上限与功能包管理
- [ ] 微信图片/语音/文件与群聊

## 🚀 正式版收敛说明（2026-11-11 `BOB-D-015`：统一迁入 `bob-agent-next` 主干施工）

> 以下原 `BB0`～`BB4` 的正式版纯 Rust + Vue 实现，已统一归并至 **`bob-agent-next` 主干的 `WP-J1`～`WP-J6`**（见 `bob-agent-next/docs/CURRENT_STAGE.md`），不再在本仓库单独分叉建设 `bobbot-server`。以下条目保留为上游迁移的功能核对清单：

### BB0：内核裁剪与 3 分钟 BYOK 开箱向导（已映射至上游 `WP-J1` / `WP-J2`）
- [ ] [BB0-01] 初始化 `bob-bot` Rust Workspace 与消费者版 Vue 3 响应式前端骨架（剥离多节点 CLI 列表，保留「对话 / 日常 / 记忆与网站」三栏）
- [ ] [BB0-02] 实现首次访问向导（服务器端设置的 4 位 PIN 登录 + DeepSeek/Gemini/OpenAI/OpenRouter 一键 API Key 填入与连通性测试）
- [ ] [BB0-03] 实现凭据密钥库（标准 AEAD、`0600` 权限）持久化保存模型 Key，实现快慢双模型（Clerk / Maker）自动绑定

## 🌐 BB1：持久化云端浏览器与手机网页“虚拟窗口”接管（核心 80% 价值）
- [ ] [BB1-01] 实现 `bob-browser` Headless Chromium 进程管理器（固定 `--user-data-dir` 持久化 Cookie / LocalStorage，空闲自动休眠标签页）
- [ ] [BB1-02] 实现 CDP `Page.startScreencast` + WebSocket 实时画面帧推流与 `Input.dispatchMouseEvent` / `insertText` 双向桥接
- [ ] [BB1-03] 开发前端 `<VirtualBrowserModal />` 组件：支持 390px 手机视口自适应、双指缩放、滑块拖动与底部原生软键盘输入栏穿透
- [ ] [BB1-04] 开发「网站授权中心」面板：展示已保存登录态的网站列表、支持一键打开虚拟窗口预登录或清除单站点 Cookie
- [ ] [BB1-05] 在所在地区 VPS 上用测试账号完成 3~5 个办公站点的真实登录测试，记录风控、异地提醒与重启后登录态
- [ ] [BB1-06] 落实测试期安全基线：HTTPS、WebSocket `Origin` 校验、禁止访问本机/内网地址、CDP 管道

## 🛠️ BB2：内置 Router-Worker 与 DOM 无障碍树网页自动操控
- [ ] [BB2-01] 编写网页无障碍树（AXTree + `[id]` 可交互元素编号）轻量提取器，替代全量 HTML 倾倒
- [ ] [BB2-02] 实现 6 个原子浏览器工具：`browser_navigate`、`browser_click`、`browser_type`、`browser_scroll`、`browser_screenshot_inspect`、`browser_request_human`
- [ ] [BB2-03] 实现内置 Resident Clerk（秒级响应）+ Native ReAct Worker（后台异步 25 轮闭环）及高危动作气泡内审批卡（`Allow Once` / `Reject`）
- [ ] [BB2-04] 实现模型用量记录与月度花费上限（默认 $10，80% 提醒，100% 停止模型调用）

## ⏰ BB3：示教转日常任务（Walkthrough to Routine）与无感记忆胶囊
- [ ] [BB3-01] 实现成功任务卡片底部的「存为日常任务（Save as Routine）」轨迹提纯器，自动生成 `RoutinePlaybook`
- [ ] [BB3-02] 实现内置 Cron 定时调度器与 Cookie 失效自动暂停呼叫人工接管（自愈闭环）
- [ ] [BB3-03] 实现闲置对话后台提取「记忆胶囊（Memory Pills）」并在前端提供可视化标签管理（查看/删除/编辑）
- [ ] [BB3-04]（可选）实现 `ChannelAdapter` 与 Telegram 通知/收发
- [ ] [BB3-05]（可选）按需接入 Lark、Discord、微信 Bot
- [ ] [BB3-06]（可选）接入现有远程 HTTP MCP 工具（界面称「连接应用」）

## 📦 BB4：单 VPS 一键部署与资源守护
- [ ] [BB4-01] 编写集成 `bobbot-server` + `chromium` + 中文字体的单容器 `Dockerfile` 与 `docker-compose.yml`
- [ ] [BB4-02] 完成 2C/4G VPS 真机部署验证与 24 小时内存/CPU 压力巡检（空闲总内存 `<600MB`）
