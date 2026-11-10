# BobBot — Current Stage（当前施工合同）

> **当前阶段**：测试原型（`prototype/`，Node.js + DSH）已上线并持续迭代，这是当前真正在施工的部分。下方 WP-1 的 Rust/Vue 正式版暂缓，等原型验证后再决定。
> **当前下一步**：用真实办公站点和真实模型验证浏览器、Routine 与做梦，然后做审批分级与 MCP 写入审批（见 [todo.md](../todo.md)）。
> 长期路线见 [DEVELOPMENT_ROUTE.md](DEVELOPMENT_ROUTE.md)，技术规范见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 1. 当前基线（2026-11-08）

1. **项目独立立项**：已在本仓库建立独立的消费者产品规范文档体系（`PROJECT_VISION.md`、`ARCHITECTURE.md`、`FEATURES.md`、`DEVELOPMENT_ROUTE.md`）。
2. **上游可复用资产确认**：上游 `bob-agent-next` (`v1.0.1`) 已具备 `bob-kernel`、`bob-runtime`（含 `FileVaultSecretStore`、`ModelHubRuntime`，但与外部 CLI 模块同 crate）与 `bob-node`（手写 `std::net` HTTP 服务）。可复用范围以 [ARCHITECTURE.md](ARCHITECTURE.md) §2 为准，Axum + tokio 服务层、WebSocket 服务端与持续 SSE 均需新建。
3. **核心技术决策确定**：
   - 不采用重型虚拟桌面（KasmVNC / X11 全桌面）或高门槛 P2P WebRTC，统一采用 **Headless Chromium + CDP `Page.startScreencast` over WebSocket** 实现手机网页内嵌虚拟浏览器窗口。
   - 不依赖外部 Coding CLI（DSH / Claude Code），采用 `bob-bot` 内置的 **Resident Clerk + Native ReAct Worker** 双层架构。

---

4. **测试原型（2026-11-08 决定）**：先在 [`prototype/`](../prototype/README.md) 用 Node.js + DeepSeek Harness 跑通 PIN 登录、对话、云浏览器与手机接管。下方 WP-1 的 Rust/Vue 骨架暂缓，等原型验证后再决定。
5. **原型验证记录（2026-11-08，Ubuntu 24.04，2C/2G + 2G Swap 测试 VPS）**：真实 DSH `0.2.2-rc.1` 与真实 Chrome 对接脚本化假模型的端到端检查 28/28 通过，覆盖 PIN 锁定、高危动作审批、人工接管、手机画面推流、模型设置、文本附件与花费上限；另有手机窗口点击回归测试 3/3（已确认旧代码会失败）。服务重启后持久 Cookie 保留，会话级 Cookie 丢失。空闲时系统内存占用约增加 220MB（Agent 尚未启动）。**尚未验证**：真实手机、真实站点登录与风控。后续补充（2026-11-09）：已用真实 DeepSeek 完成一次浏览器任务；原型新增历史对话侧栏（每个对话独立的 DSH 会话，重启后回放此前文字作为上下文）、受审批的服务器文件与命令工具，端到端检查更新为 53/53，另有单元测试 28/28 与浏览器手机/电脑检查 8/8。

---

### 2026-11-09 / 11-10 原型能力扩展（已上线 https://ry.bobbik.org）

1. **发布链路**：新增 `scripts/deploy-ry.sh`（push → RY 拉取 → 依赖变更安装 → 重启 → 双端健康检查）与构建戳 `/api/version`；RY 升级到 Node 24.22.2。
2. **对话体验**：卡片改为图标+标签+对齐信息行+双按钮；Orb 用气泡/思考云/说话点表达状态；新增语言切换（跟随系统/中文/英文）、语音输入、会话重命名（桌面悬停、手机长按/左滑）、打开恢复上次页面、超过 3 小时自动新会话。
3. **文员**：页面只保留待办/定时任务/收件箱（空状态可照做）；消息渠道、添加渠道、时区移入设置；微信登录成功后自动创建「微信」提醒渠道。
4. **微信（官方）**：引入腾讯官方 iLink 核心与自建 bridge，扫码登录后私聊进独立会话；新增 bob-agent 兼容 API（`/v1/chat` SSE、`/v1/conversations`、`/v1/health`）；主动发送使用 `context_token`，失败如实记录。
5. **推送**：PWA + APNs（iOS）主屏幕通知，VAPID 与订阅管理；Android 规划独立 APK（不走 FCM），已写入 [ARCHITECTURE.md](ARCHITECTURE.md) §5。
6. **记忆与主动性**：夜间「做梦」把最近对话整合为长期记忆与观察；主动关心按时自检，无内容则 `[SILENT]`；主动性 0–1 四档可调（高冷/得体/积极/粘人），安静时段与配额为硬规则。
7. **功能包**：Bob 可在确认后安装小型功能包（工具 + 路由 + 设置面板），仅写 `data/features/`，加载失败自动跳过。

验收：`unit 28/28`、`e2e 59/59`；线上服务与微信桥均 active，公网 200。详细记录见 [UPDATES.md](UPDATES.md)。

### 2026-11-10 浏览器能力与可靠性升级

浏览器引擎重写：可读可点 iframe（含跨站）、开放 Shadow DOM 与 `div` 按钮；新增下拉、悬停、按键、后退、等待、全文/表格/链接读取、多标签页、下载、上传；密码不进模型、地址检查覆盖重定向与框架；浏览器崩溃自动恢复。定时任务保留最近 20 次运行记录，状态如实（完成/部分完成/需要你/失败/错过），登录过期可“去处理”后自动重跑；审批与接管发手机推送；状态文件改为原子写入。验收：`unit 28/28`、`browser 18/18`、`e2e 61/61`、`ui 8/8`（RY 上 Node 24 + Chrome）。**尚未验证**：真实办公站点。

### 2026-11-10 Routine、待批草稿与记忆修复

详见 [UPDATES.md](UPDATES.md) §11.2。**尚未验证**：真实模型下的 Routine 生成质量与做梦质量。

---

## 2. 下一步立即执行的施工包（Active Work Package）

### WP-1（BB0 & BB1 核心验证，暂缓）：初始化代码骨架与“手机虚拟浏览器窗口”原型

1. **Step 1：建立 Rust + Vue 3 极简工程骨架**
   - 搭建 `crates/bobbot-server`（集成 Axum Web 服务、SQLite、BYOK 密钥保险箱）与 `web/`（消费者版极简三栏 Vue 3 界面 + 首次启动 BYOK 配置向导），并跑通基础流式对话（BB0 退出门）。
2. **Step 2：实现 `bob-browser` CDP 桥接器**
   - 启动带 `--user-data-dir` 持久化的 Headless Chromium 子进程；
   - 实现 `/api/ws/browser-takeover` WebSocket 端点，按需开启 `Page.startScreencast`（退出窗口立即 `stopScreencast` 归零 CPU 消耗），并双向转发鼠标/触摸坐标与 `Input.insertText` 软键盘文本输入。
3. **Step 3：实现前端 `<VirtualBrowserModal />` 手机端交互**
   - 在聊天流卡片或顶栏点击打开虚拟窗口，验证 390px 手机屏幕下的画面渲染、点击跳转、滑块拖动与底部原生输入框密码填入。

### 退出门（Exit Gate）
- **BB0**：全新空库启动后完成 API Key 配置并跑通首轮流式对话，API Key 明文不外泄。
- **BB1**：部署到所在地区的 VPS，用手机浏览器（390×844）打开虚拟窗口，逐一登录 3~5 个实际要用的办公站点（如飞书网页版、企业邮箱、内部 OA），记录每个站点的结果。
  - 至少一个带验证码或 2FA 的站点登录成功；服务重启后仍保持登录态。
  - 记录是否触发风控、异地提醒或账号限制。地区相近的 VPS 能减少异地告警，但机房 IP 本身仍可能被站点识别。
  - 使用测试账号；关闭推流且没有任务运行时，CPU 占用趋近于 0%。
