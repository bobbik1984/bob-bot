# AGENTS.md — BobBot (`bob-bot`) 项目级工作宪法

> **适用范围**：所有在本仓库工作的 AI Agent。通用文档职责遵循作者的工作区统一标准（私有，不随本仓库发布）。

## 1. JIT 上下文路由（按需读取）

每次执行任务前，只加载当前任务所需的最小文档集合：

| 任务类型 | 必读权威入口 |
|---|---|
| 理解产品边界、什么做/什么不做 | [docs/PROJECT_VISION.md](docs/PROJECT_VISION.md) |
| 设计或实现云浏览器虚拟窗口、Router-Worker、BYOK、Routines、花费上限、可选渠道、安全基线 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 核对用户可见功能与验收标准 | [docs/FEATURES.md](docs/FEATURES.md) |
| 了解长期里程碑与阶段退出门（Exit Gate） | [docs/DEVELOPMENT_ROUTE.md](docs/DEVELOPMENT_ROUTE.md) |
| **确认当前正在施工的任务与下一步动作** | [docs/CURRENT_STAGE.md](docs/CURRENT_STAGE.md) |
| 运行或修改测试原型 | [prototype/README.md](prototype/README.md) |
| 了解 Router-Worker 的外部设计参考 | [docs/SUPER_AGENT_NOTES.md](docs/SUPER_AGENT_NOTES.md) |
| 增删待办或同步看板进度 | [todo.md](todo.md)、[progress.yaml](progress.yaml) |

## 2. 与主干 `bob-agent`（`bob-agent-next`）的分工与边界规则（2026-11-11 `BOB-D-015` 更新）

1. **永久原型实验室定位（Prototype Lab）**：
   - 本仓库（`prototype/`，线上测试实例）长期作为 **Bob 轻量交互、办公自动化与自我扩展能力的快速研究原型实验室**。
   - **不再在本仓库单独分叉建设独立的 `bobbot-server` Rust 服务端**：凡在本原型中验证成熟的优势（Jarvis 彩色球与单一交流窗口、手机桌面式沙箱小组件 3 分钟试用、云端浏览器手机虚拟窗口接管、Routine 与待批草稿、四档主动关心、Web Push / 微信桥送达，以及 61+ 项端到端/浏览器/UI 验收标准），统一迁入 **`bob-agent-next` 主干**按 `WP-J1`～`WP-J6` 正式开发（见 `bob-agent-next/docs/DECISIONS.md` `BOB-D-015`）。
2. **体验纯净度与零外部依赖基准**：
   - 本原型保持面向普通用户的极简 Jarvis 体验，**严禁将面向极客的多节点 CLI 管理（Claude Code / Codex / AGY 终端附着）带入本原型界面**。
   - 原型内允许继续使用 Node.js 与 DeepSeek Harness（DSH）快速试错新交互；正式版在 `bob-agent-next` 主干采用纯 Rust `BobNativeHarness` + 内嵌 `QuickJS` 沙箱闭环运行，零 Node.js 与第三方 CLI 必经依赖。可选的消息渠道与 MCP 不得进入必经依赖链。

## 3. 安全与人机门禁（Human Gates）

1. **API Key 与网站 Cookie 保护**：
   - 用户填入的 LLM API Key 必须经密钥库（标准 AEAD，Linux `0600`）加密落盘，前端 API 仅返回 `hasKey: true` 与掩码前缀。
   - 云端 Chromium 的 `--user-data-dir` 严格限制在宿主机/容器私有卷，禁止通过普通文件下载接口暴露 Cookie 数据库。
2. **高危网页动作硬拦截（Action Gates）**：
   - 凡涉及支付确认、表单最终提交、删除数据、外发消息或遇到密码框/验证码，`bob-browser` 必须挂起自动执行，向前端推送 `TakeoverRequest` 或 `ApprovalRequest`，未经用户显式操作不得继续。
3. **花费上限**：
   - 所有模型调用必须计入月度用量（默认 $10），达到上限后不得发起新的调用。
4. **前端规范**：
   - 严格遵守全局 CSS Variables 主题色规范（严禁硬编码颜色值）、`scrollbar-gutter: stable` 防抖动与中英双语 i18n（`$t`）要求。
