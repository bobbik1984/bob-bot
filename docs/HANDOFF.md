# BobBot 交接说明（给下一个 Agent）

> **更新时间**：2026-11-21 22:00（HEAD：`e65ab90` on `origin/main`）  
> **目标**：让接手的 Agent 在 5 分钟内掌握双端拓扑、最新架构决策、已完成交付、当前已知待查问题、一键部署命令与红线约束。

---

## 0. 30 秒速览

- **仓库**：`D:\Code\bob-bot`（GitHub `bobbik1984/bob-bot`，分支 `main`，已同步至 `e65ab90`）
- **主力全功能原型（当前开发焦点）**：**https://ry.bobbik.org**
  - **宿主机**：**VPS3 / Contabo**（`ubuntu@89.117.22.194`，SSH 别名 `ssh contabo`，4C/8G，Ubuntu 24.04）
  - **形态**：`prototype/`（Node `v24.14.1` + 纯 `@deepseek-ai/dsh` + `/snap/bin/chromium` + Python Office 虚拟环境 `~/bob-bot-venv`）
  - **入口**：Cloudflare Tunnel `4ab19cdb-9e5c-49f9-90f6-2b5ff011cef9` → `127.0.0.1:8787`（已从旧腾讯云 RY 迁移完成，`ryclaw.bobbik.org` 已下线）
  - **一键发布**：在 `D:\Code\bob-bot` 执行 `.\scripts\deploy-vps3.ps1`（同步 `prototype/` 与 `skills-presets/` → 重启 `systemctl --user restart bobbot` → 6×2s 重试健康检查）
  - **登录 PIN**：`1234`
- **超轻量 Go 网关（已稳定运行）**：**https://bot.bobbik.org**
  - **宿主机**：**GCP Always Free `e2-micro` (`gcp-bobbot`)**，Go 单二进制 `0.4.0-life.6`（含多模型预设、RFC 8291 加密 iOS PWA Web Push）
  - **一键发布**：`.\scripts\deploy-gcp.ps1`（经 VPS2 `gcloud` + Service Account `vps2-admin@vm-machine-515112.iam.gserviceaccount.com` 推送）
- **数据目录**：VPS3 `~/bob-bot/data/`（PIN、密钥、模型档案、会话、记忆、功能包、`dsh-home/`、`workspace/`），**严禁提交到 Git、严禁删除**。

---

## 1. 环境与基础设施台账

| 站点 / 节点 | 地址 / SSH | 运行栈 | 服务管理 | 部署命令 |
|---|---|---|---|---|
| **主力全功能原型** (`https://ry.bobbik.org`) | VPS3 Contabo (`ssh contabo`, `89.117.22.194`) | `prototype/` (Node 24 + DSH + Chromium + Python Office venv) | `systemctl --user status bobbot cloudflared` | `.\scripts\deploy-vps3.ps1` |
| **轻量生活网关** (`https://bot.bobbik.org`) | GCP `e2-micro` (`gcp-bobbot`，经 VPS2 `gcloud`) | `gateway/` (Go 单二进制 `0.4.0-life.6`) | `systemd` (`bobbot.service`) | `.\scripts\deploy-gcp.ps1` |

> 完整集群与域名真相源见工作区 `Assistant/common/knowledge/skills/cluster-ops/references/node_inventory.md` 与 `service_map.md`。

### VPS3 运行时关键细节
- **服务单元**：`~/.config/systemd/user/bobbot.service`（已配置 `CHROME_PATH=/snap/bin/chromium`、`PATH` 含 `/snap/bin` 与 `~/bob-bot-venv/bin`）。
- **与 `bob-online` 完全隔离**：`bob-bot` 运行 `dsh` 时强制使用独立 `DSH_HOME=/home/ubuntu/bob-bot/data/dsh-home`，不会被 `bob-node-access`（仅扫描 `~/.claude`、`~/.pi/agent/sessions`、`~/.codex`、`~/.gemini/antigravity-cli`）扫到。
- **Python Office 虚拟环境**：`~/bob-bot-venv` 预装 `pypdf`, `pdfplumber`, `pymupdf`, `reportlab`, `openpyxl`, `pandas`, `xlrd`, `python-docx`, `python-pptx`, `beautifulsoup4`, `lxml`。
- **预置技能**：`prototype/skills-presets/office-docs/SKILL.md`（部署脚本自动同步至 VPS3 `~/bob-bot/data/skills/office-docs/SKILL.md`）。

---

## 2. 当前用户定案与架构约束（务必遵守）

1. **纯 `dsh` 执行架构**：`ry.bobbik.org` 主页面**只走 `dsh`**（已移除 `worker-cli` / `codex` / `agy` 委托），依靠 `dsh` 统一调度多模型 + VPS3 本地 Python Office 工具 + Chromium 处理白领办公任务。**不要重新加回 `codex` / `agy` 委托。**
2. **固定 5 模型清单（VPS3 `~/bob-bot/data/providers.json`）**：用户明确指定保留且只保留以下 5 个模型（**不要重新加回 Qwen**）：
   - `DeepSeek V4.1 (1017)` — `kind: deepseek`, `api: anthropic-messages`, `model: deepseek-flash`（注意：DeepSeek 官方接口必须传 `deepseek-flash`，直接传 `deepseek-v4.1-flash-1017` 会返回 HTTP 400）
   - `OpenAI Sol 6.2` — `kind: openai`, `api: openai-completions`, `model: gpt-6.2-sol`
   - `OpenAI Astra 6.2` — `kind: openai`, `api: openai-completions`, `model: gpt-6.2-astra`
   - `Gemini 4 Hydrogen` — `kind: google`, `api: openai-completions`, `baseUrl: https://generativelanguage.googleapis.com/v1beta/openai`, `model: gemini-4-hydrogen`
   - `Gemini 4 Neon` — `kind: google`, `api: openai-completions`, `baseUrl: https://generativelanguage.googleapis.com/v1beta/openai`, `model: gemini-4-neon`
3. **中途切换模型上下文**：切换模型会重启 `dsh` 并开启新 session，`agent.mjs` 的 `isFresh(cid)` 会在新 session 首轮自动重放当前对话历史给新模型，上下文连续。
4. **视觉与编码红线**：
   - 默认主题为**阳光浅色 Muse 风格**，所有样式使用 CSS Variables，严禁硬编码颜色。
   - Python 文件 I/O 必须显式指定 `encoding='utf-8'`（面向 Excel 的 `.csv` 使用 `utf-8-sig`）。
   - Windows 环境下严禁使用 PowerShell `Get-Content` / `Set-Content` 改写含中文的文件。

---

## 3. 本轮已完成交付（2026-11-21）

| 模块 | 核心改动与文件 | 状态 |
|---|---|---|
| **VPS3 迁移与纯 DSH 底座** | 迁移 `ry.bobbik.org` 隧道至 Contabo VPS3，建立 `scripts/deploy-vps3.ps1`、Python Office venv、`office-docs` Skill | ✅ 已上线 |
| **Muse 浅色 UI + 模型/思考强度选择器** | [index.html](file:///D:/Code/bob-bot/prototype/public/index.html) + [providers.mjs](file:///D:/Code/bob-bot/prototype/providers.mjs) + [agent.mjs](file:///D:/Code/bob-bot/prototype/agent.mjs) + [server.mjs](file:///D:/Code/bob-bot/prototype/server.mjs)：浅色默认、自定义 Muse 弹出菜单选择模型与思考强度（低/中/高/最高/关闭） | ✅ 已上线 |
| **pi-ai 多模型思考强度与 Gemini 兼容修复** | [server.mjs](file:///D:/Code/bob-bot/prototype/server.mjs)：给自定义 pi-ai 模型声明 `reasoningEfforts`；对非 `api.openai.com` 的 `openai-completions` 端点自动关闭 `compat.supportsStore` 与 `compat.supportsDeveloperRole`（修复 Gemini 400 `Unknown name "store"`），并将 Google `xhigh` 映射为 `high` | ✅ 已部署（待用户复测） |
| **白领办公文档上传 / 下载 / 屏内预览** | [server.mjs](file:///D:/Code/bob-bot/prototype/server.mjs) + [preview_render.py](file:///D:/Code/bob-bot/prototype/preview_render.py) + [index.html](file:///D:/Code/bob-bot/prototype/public/index.html)：支持二进制 `.xlsx/.xls/.csv/.docx/.pptx/.pdf` 上传至 `uploads/`；工作区内安全 `write_file`/`run_command` 免弹窗自动放行；产出文件渲染为带格式徽章的卡片，支持 `GET /api/workspace/file` 下载与 `GET /api/workspace/preview` 屏内预览弹窗；新增 `#liveStatus` 实时状态胶囊与 `error_turn` 错误透传 | ✅ 已上线 |
| **所在城市服务端 SSOT + 小组件响应式联动** | [clerk.mjs](file:///D:/Code/bob-bot/prototype/clerk.mjs) + [server.mjs](file:///D:/Code/bob-bot/prototype/server.mjs) + [features.mjs](file:///D:/Code/bob-bot/prototype/features.mjs) + [plugin-host.mjs](file:///D:/Code/bob-bot/prototype/plugin-host.mjs) + [index.html](file:///D:/Code/bob-bot/prototype/public/index.html)：城市持久化在 `clerk.json`（已预置为 `天津` / `Asia/Shanghai`），新增 `GET /api/location`，`nowHeader()` 自动注入当前城市；Widget SDK 新增 `bob.city`/`bob.timezone` 与 `bob-location` 事件；`plugin-host` 路由回调自动收到 `location` | ✅ 已上线 |
| **横向滚动表格渲染（Markdown + `show_card`）** | [cards.mjs](file:///D:/Code/bob-bot/prototype/cards.mjs) + [server.mjs](file:///D:/Code/bob-bot/prototype/server.mjs) + [index.html](file:///D:/Code/bob-bot/prototype/public/index.html) + [office-docs/SKILL.md](file:///D:/Code/bob-bot/prototype/skills-presets/office-docs/SKILL.md)：`renderMd()` 完整支持 GFM 表格、标题、代码块；`show_card` 新增 `table: { columns, rows }`；所有表格带 `.md-table-wrap` 横向滑动 + 首列 `sticky` 冻结 | ✅ 已上线 |

---

## 4. 下一个 Agent 立即接手的优先事项

### P0（紧接着要验和修的）
1. **排查「右上角天气小组件没有显示出来」的问题**
   - 用户在上一轮让 DeepSeek 创建了一个 `header-right` 的天气小组件，Bob 报告 `feature_create` 成功，但用户反馈「没有显示出来」（紧接着切换模型碰到了 Sol / Gemini 报错）。
   - 建议先登录 VPS3 检查 `~/bob-bot/data/features/` 下的天气插件代码、状态与日志（`journalctl --user -u bobbot -n 100`），确认是：
     - 3 分钟试用期过期自动回退了？
     - 还是 `header-right` 槽位（`#slotHeader`）宽度/高度/布局被压缩或 `frame.style.visibility = 'hidden'` 未收到 `bob: 'ready'`？
     - 还是插件后端 `fetch` 外部天气接口在 Contabo VPS3 超时或返回结构不匹配？
   - 顺手把 `header-right` 小组件布局（贴右对齐、自适应宽度、防裁切）和插件调试报错可见性打磨好。
2. **端到端实测 OpenAI Sol 6.2 & Gemini 4 Hydrogen / Neon**
   - `87266b5`（`reasoningEfforts`）和 `e65ab90`（`compat.supportsStore: false`）刚刚部署，尚未做实际对话轮次验收；请验证 Sol 6.2、Astra 6.2、Gemini 4 Hydrogen、Gemini 4 Neon 在不同思考强度（低/中/高/关闭）下都能正常流式回复且无 400 报错。

### P1（白领办公体验打磨）
3. **表格与文件预览体验继续增强**
   - 验证新版 `show_card.table` 和 Markdown 表格在手机端（390px）与桌面端对复杂 Excel（如多列活动计划表、台账）的实际横向滚动 + 首列冻结观感。
   - 测试让 Bob **生成** Excel / PDF / Word / PPT 产出文件，端到端走通「对话气泡格式徽章卡片 → 屏内预览弹窗 → 一键下载」。
4. **真实办公站点浏览器接管实测**
   - 在 VPS3 的 `/snap/bin/chromium` 上测试 3~5 个真实办公站点登录与 `browser_request_human` 手机接管。

### P2（安全与中长期）
5. `secrets.json` 用 AEAD 加密落盘；MCP 写入类工具纳入审批；审批卡风险分级。
6. 微信多媒体/群聊、Android APK / 兜底提醒渠道、主动性接受率学习（详见 `todo.md`）。

---

## 5. 代码地图（`prototype/` 核心文件）

| 文件 | 职责 |
|---|---|
| `server.mjs` | 主入口：HTTP/SSE/WS、会话、`nowHeader()`、审批、文员、`/api/location`、`/api/workspace/file` & `/preview`、功能包/模型供应商调度与 `provider.patch.yml` 生成 |
| `public/index.html` | 单页前端（无构建）：Muse 浅色主题、模型/思考强度选择器、城市→时区选择器、Markdown/表格渲染、文件徽章与屏内预览弹窗、沙箱小组件通信桥（`frameInit` / `bob-location`） |
| `agent.mjs` | `dsh` 子进程管理、`reasoningEffort` 传入、`isFresh(cid)` 历史重放、`error_turn` 事件 |
| `providers.mjs` | 多模型档案校验（含 `EFFORTS`）、保存、切换 |
| `clerk.mjs` | 待办、定时任务、收件箱、渠道、**`timezone` + `city` 持久化** |
| `cards.mjs` | `show_card` 校验（含 `table: { columns, rows }`）与纯文本降级 |
| `features.mjs` & `plugin-host.mjs` | 沙箱功能包管理与子进程路由执行（已透传 `location: { city, timezone }`） |
| `preview_render.py` | 服务端将 `.xlsx/.xls/.csv/.docx/.pptx` 渲染为可交互屏内预览 HTML |
| `skills-presets/office-docs/SKILL.md` | 办公文档读写、编码、交付链接与表格呈现规范 |
| `test/unit.mjs` | 单元测试（当前基线：**45/45 通过**） |

---

## 6. 常用命令与排障入口

```powershell
# 本地语法检查 + 单元测试
node --check D:\Code\bob-bot\prototype\server.mjs
node D:\Code\bob-bot\prototype\test\unit.mjs

# 一键部署到 VPS3 (https://ry.bobbik.org)
Set-Location D:\Code\bob-bot
.\scripts\deploy-vps3.ps1
```

```bash
# 登录 VPS3 排障
ssh contabo
systemctl --user status bobbot cloudflared
journalctl --user -u bobbot -n 100 --no-pager
curl -s http://127.0.0.1:8787/api/version
ls -la ~/bob-bot/data/features/
```

---

## 7. 不要做的事（红线）

1. 不要把 `codex` / `agy` 委托加回 `ry.bobbik.org`，保持纯 `dsh` 架构。
2. 不要随意修改或扩充 VPS3 上用户的 5 模型清单（不要加回 Qwen）。
3. 不要把 `DSH_HOME` 改到 `~/.dsh` 或其他目录，以免污染 `bob-online` 扫描结果。
4. 不要提交或删除 `prototype/data/`、密钥、微信登录态。
5. 不要在未跑 `node --check` 和 `node prototype/test/unit.mjs` 的情况下部署。
6. 不要在日志或输出中打印完整 API Key（最多保留前 4 位）。
