# BobBot (`bob-bot`)

**住在你个人 VPS 里的 7×24 小时云端数字分身：打开网页填个 API Key 就能聊，内置持久化云端浏览器，遇到登录或验证码直接在手机网页弹出虚拟窗口点一下接力，手把手教一次就能变成每日自动运行的 Routine。**

> **状态：`0.1.0` 独立立项与架构设计阶段（BB0 → BB1）。** 基于 `bob-agent` (`v1.0.1`) 验证成熟的单一 Rust 内核（`bob-kernel` / `bob-runtime` / `bob-node`）孵化，剥离面向极客的多节点 CLI 舰队管理复杂性，专注于**普通办公室白领的轻量助理体验**，当前先由项目所有者在所在地区的 VPS 上自测，核心对标 Grok Bot。

## 核心文档导航

- **为什么做、为谁做（项目愿景）**：[docs/PROJECT_VISION.md](docs/PROJECT_VISION.md)
- **系统架构与五大缺失技术细节**：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **核心产品功能与验收标准**：[docs/FEATURES.md](docs/FEATURES.md)
- **分阶段开发路线与退出门**：[docs/DEVELOPMENT_ROUTE.md](docs/DEVELOPMENT_ROUTE.md)
- **当前施工合同（What Now）**：[docs/CURRENT_STAGE.md](docs/CURRENT_STAGE.md)
- **测试原型（Node.js + DSH）**：[prototype/README.md](prototype/README.md)
- **Super-agent 研究笔记**：[docs/SUPER_AGENT_NOTES.md](docs/SUPER_AGENT_NOTES.md)
- **需求与待办池**：[todo.md](todo.md)
- **机器可读进度投影**：[progress.yaml](progress.yaml)
- **Agent 工作准则**：[AGENTS.md](AGENTS.md)

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
