# BobBot — Current Stage（当前施工合同）

> **当前阶段**：`BB0 → BB1` 立项完成，准备启动 **第一顺位核心 POC：手机网页内嵌云端虚拟浏览器窗口（CDP Screencast + 触屏/软键盘穿透）**。
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
5. **原型验证记录（2026-11-08，Ubuntu 24.04，2C/2G + 2G Swap 测试 VPS）**：真实 DSH `0.2.2-rc.1` 与真实 Chrome 对接脚本化假模型的端到端检查 28/28 通过，覆盖 PIN 锁定、高危动作审批、人工接管、手机画面推流、模型设置、文本附件与花费上限；另有手机窗口点击回归测试 3/3（已确认旧代码会失败）。服务重启后持久 Cookie 保留，会话级 Cookie 丢失。空闲时系统内存占用约增加 220MB（Agent 尚未启动）。**尚未验证**：真实 DeepSeek 模型调用、真实手机、真实站点登录与风控。

---

## 2. 下一步立即执行的施工包（Active Work Package）

### WP-1（BB0 & BB1 核心验证）：初始化代码骨架与“手机虚拟浏览器窗口”原型

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
