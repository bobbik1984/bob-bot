# BobBot (`bob-bot`)

**住在你个人 VPS 里的 7×24 小时云端数字分身：打开网页填个 API Key 就能聊，内置持久化云端浏览器，遇到登录或验证码直接在手机网页弹出虚拟窗口点一下接力，手把手教一次就能变成每日自动运行的 Routine。**

> **线上版本**：主站与 RY 各自运行 Go 网关，按域名独立保存账号、对话、文员记录及推送。Node 原型保留在 prototype 目录。

## 核心文档导航

- **为什么做、为谁做（项目愿景）**：[docs/PROJECT_VISION.md](docs/PROJECT_VISION.md)
- **系统架构与五大缺失技术细节**：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **核心产品功能与验收标准**：[docs/FEATURES.md](docs/FEATURES.md)
- **分阶段开发路线与退出门**：[docs/DEVELOPMENT_ROUTE.md](docs/DEVELOPMENT_ROUTE.md)
- **当前施工合同（What Now）**：[docs/CURRENT_STAGE.md](docs/CURRENT_STAGE.md)
- **测试原型（Node.js + DSH）**：[prototype/README.md](prototype/README.md)
- **本轮更新与功能优势**：[docs/UPDATES.md](docs/UPDATES.md)
- **交接说明（给下一个 Agent）**：[docs/HANDOFF.md](docs/HANDOFF.md)
- **部署到 RY 独立实例**：[scripts/deploy-ry.sh](scripts/deploy-ry.sh)（见下文「部署到 RY」）
- **Super-agent 研究笔记**：[docs/SUPER_AGENT_NOTES.md](docs/SUPER_AGENT_NOTES.md)
- **需求与待办池**：[todo.md](todo.md)
- **机器可读进度投影**：[progress.yaml](progress.yaml)
- **Agent 工作准则**：[AGENTS.md](AGENTS.md)

## 早期 Node 原型能力（2026-11-10）

| 能力 | 说明 |
|---|---|
| 一条命令发布 | x1t 改 → push → `deploy-ry.sh` → 自动同步/安装/重启/健康检查，设置页显示构建号 |
| 官方微信 | 腾讯官方 iLink（OpenClaw 核心）扫码登录、私聊对话、提醒推送，不走第三方协议 |
| 三层提醒 | 应用内收件箱 + 手机主屏幕推送（iOS APNs/PWA）+ 微信（最近活跃时），失败如实记录 |
| 卡片化表达 | 图标 + 标签 + 对齐信息行 + 双按钮，只展示有效信息 |
| 文员独立 | 待办 / 定时任务 / 收件箱；渠道、微信、时区在设置 |
| 主动性 0–1 | 高冷 / 得体 / 积极 / 粘人；安静时段与配额为硬规则 |
| 记忆 + 做梦 | 夜间整合对话为长期记忆与观察，主动关心使用 |
| 受控自扩展 | 功能包（工具 + 路由 + 面板），审批 + 失败隔离，不能改主代码 |
| 手机体验 | PWA 安装、语音输入、会话重命名、回到上次页面、3 小时新会话、中英双语 |
| 安全 | 危险动作审批、扩展启动兜底、推送失败不伪造 |

完整明细见 [docs/UPDATES.md](docs/UPDATES.md)。

## 目录结构

```text
bob-bot/
├── README.md                  # 项目总览与导航入口
├── AGENTS.md                  # Agent 工作宪法与 JIT 路由
├── todo.md                    # 待办需求池
├── progress.yaml              # 结构化进度状态投影
└── docs/
    ├── PROJECT_VISION.md      # 产品愿景、定位切割与核心原则
    ├── ARCHITECTURE.md        # 架构蓝图与五大核心缺失技术细节设计
    ├── FEATURES.md            # 面向消费者的功能树与验收标准
    ├── DEVELOPMENT_ROUTE.md   # BB0–BB4 长期演进路线与退出门
    └── CURRENT_STAGE.md       # 当前施工阶段与第一顺位 POC 合同
```

## 部署到 RY

RY 使用仓库 gateway 目录与自己的 release-ry.json。服务器的 bobbot.service 在 /opt/bobbot-ry 运行，收件、资料、登录和推送归本站所有者。更新时保留 data/ 和服务器上的私有 PIN 配置，旧版 Node 工作目录保留作回滚。微信快捷指令须使用 RY 自己的地址与令牌。

Windows 可在仓库根目录执行：

```powershell
python -X utf8 scripts/deploy-gcp.py deploy --target release-ry.json
```

在 Linux 或 macOS 上可执行 bash scripts/deploy-ry.sh。两条命令都在 RY 上测试和编译 Go 网关、原子更换程序并验证 RY 的公网版本。主站仍使用 release.json。
