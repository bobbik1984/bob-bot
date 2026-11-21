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

## 4. GCP 轻量网关 (`gcp-bobbot` / `bot.bobbik.org`) 编译与发布规范

1. **源码组成**：
   - Go 原生单二进制网关位于 `gateway/`：`main.go`、`features.go`、`go.mod`、`public/`（唯一主界面在 `gateway/public/index.html`）及 `life/`（提醒、日历与推送）。
   - 远端实例部署目录为 `/home/bobbik_hbz_gmail_com/bob-bot/`，由 `bobbot.service`（端口 `:8080`）+ `cloudflared` 隧道对外提供 `https://bot.bobbik.org` 服务；各服务商 API Key 持久化于远端 `data/config.json`，发布不会覆盖密钥。
2. **标准一键发布（本地有 `ssh gcp` 权限的 Agent 必须使用）**：
   - 直接运行：`.\scripts\deploy-gcp.ps1`（或 `python -X utf8 scripts/deploy-gcp.py deploy`），参数已默认固化在根目录 [release.json](release.json)。
   - 脚本会自动打包完整 `gateway/` 源码、上传至 `gcp` 临时构建目录、运行测试并执行 **`go build .`**（**严禁**单独执行 `go build main.go`，否则会漏掉 `features.go` 与 `life/` 模块），原子替换二进制并重启 `bobbot.service`，最后校验本机与公网 `https://bot.bobbik.org/api/life/version`。
3. **无 SSH 权限的云端沙盒 Agent 边界**：
   - 若当前 Agent 无法直连 `ssh gcp`，不得伪造部署成功；应把代码提交到 GitHub 后，提示用户在本地终端（或由本地 Agent）执行 `.\scripts\deploy-gcp.ps1` 完成上线。

## 5. VPS3 完全体全能办公版 (`ry.bobbik.org`) 部署规范

1. **定位与运行环境**：
   - 托管在 **VPS3 (`contabo`, 4C/8G)** 的 `/home/ubuntu/bob-bot/`，运行完整版 `prototype/`（Node 24 + `@deepseek-ai/dsh` + Chromium `/snap/bin/chromium` + Python 文稿虚拟环境 `/home/ubuntu/bob-bot-venv`），支持 PDF/Excel/Word/PPT/HTML 二进制上传（落盘至 `data/workspace/uploads/`）与鉴权预览/下载（`/api/workspace/file?path=...`）。
   - 用户态常驻服务：`systemctl --user status bobbot`（监听 `127.0.0.1:8787`）+ `systemctl --user status cloudflared`（隧道 `4ab19cdb-9e5c-49f9-90f6-2b5ff011cef9` 映射 `https://ry.bobbik.org`）。
2. **标准一键发布**：
   - 修改 `prototype/` 后，在仓库根目录直接运行：`.\scripts\deploy-vps3.ps1`（如改动了 `package.json` 依赖，追加 `-NpmInstall`）。
   - 脚本会自动保留远端 `data/`、更新内置 `office-docs` 技能、重启用户态 `bobbot.service` 并校验 `https://ry.bobbik.org/` 返回 HTTP 200。

3. **历史 RY 配置**：`release-ry.json` 对应原腾讯云 Go 实例。当前 RY 以本文 VPS3 一节及 `docs/HANDOFF.md` 为准，使用 `scripts/deploy-vps3.ps1`。

## 6. PWA 身份与推送升级契约

生产 Origin 取自既有发布配置。首页与经典页共用根作用域、manifest 的 `id: "/"` 和 `scope: "/"`，以及永久入口 `/sw.js`。UI 改版须继续注册同一 worker，保留 `push` 与 `notificationclick` 监听。订阅同步、隐私偏好和密钥沿用同一通道。不得在升级、登录或页面初始化时例行取消订阅或轮换 VAPID。原位部署保留整个 `data/`，迁移机器时整体恢复。兼容与验收细则见 [架构规范](docs/ARCHITECTURE.md#pwa-push-contract)。
