# BobBot (`bob-bot`)

**住在你个人 VPS 里的 7×24 小时云端数字分身：打开网页填个 API Key 就能聊，内置持久化云端浏览器，遇到登录或验证码直接在手机网页弹出虚拟窗口点一下接力，手把手教一次就能变成每日自动运行的 Routine。**

> **状态：`0.1.0` 原型已上线（https://ry.bobbik.org），进入 BB1 自测阶段。** 基于 `bob-agent` (`v1.0.1`) 验证成熟的单一 Rust 内核（`bob-kernel` / `bob-runtime` / `bob-node`）孵化，剥离面向极客的多节点 CLI 舰队管理复杂性，专注于**普通办公室白领的轻量助理体验**，当前先由项目所有者在所在地区的 VPS 上自测，核心对标 Grok Bot。

## 核心文档导航

- **为什么做、为谁做（项目愿景）**：[docs/PROJECT_VISION.md](docs/PROJECT_VISION.md)
- **系统架构与五大缺失技术细节**：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **核心产品功能与验收标准**：[docs/FEATURES.md](docs/FEATURES.md)
- **分阶段开发路线与退出门**：[docs/DEVELOPMENT_ROUTE.md](docs/DEVELOPMENT_ROUTE.md)
- **当前施工合同（What Now）**：[docs/CURRENT_STAGE.md](docs/CURRENT_STAGE.md)
- **测试原型（Node.js + DSH）**：[prototype/README.md](prototype/README.md)
- **本轮更新与功能优势**：[docs/UPDATES.md](docs/UPDATES.md)
- **交接说明（给下一个 Agent）**：[docs/HANDOFF.md](docs/HANDOFF.md)
- **部署到 RY 测试机**：[scripts/deploy-ry.sh](scripts/deploy-ry.sh)（见下文「部署到 RY」）
- **Super-agent 研究笔记**：[docs/SUPER_AGENT_NOTES.md](docs/SUPER_AGENT_NOTES.md)
- **需求与待办池**：[todo.md](todo.md)
- **机器可读进度投影**：[progress.yaml](progress.yaml)
- **Agent 工作准则**：[AGENTS.md](AGENTS.md)

## 当前能力与主要优势（2026-11-10）

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

RY 是当前的自测 VPS（`ubuntu@82.157.186.181`，腾讯云 2C/2G，Ubuntu 24.04，Node 24.22.2 / Chrome 157），已作为 systemd 服务运行测试原型，并通过 Cloudflare 隧道对外提供 **https://ry.bobbik.org**。

日常迭代只需要三步，全部在 x1t 上完成：

```sh
# 1. 改代码并提交
git add -A && git commit -m "..."

# 2. 把这个提交直接推给 RY，自动重启、验收（GitHub 只作备份）
bash scripts/deploy-ry.sh
```

RY 在国内，常连不上 GitHub，所以它从不需要访问 GitHub：脚本通过 SSH 把提交直接送到 RY（git 增量传输，写入旁路引用 `refs/deploy/main`，不动 RY 当前分支）。部署前会先从 x1t 向 GitHub 推一份备份，失败也不影响部署。`--no-github` 跳过备份，`--via-github` 才是让 RY 自己去 GitHub 拉。

脚本会：（备份推送 GitHub）→ 把提交推给 RY → RY 上 `git reset --hard refs/deploy/main`（若 RY 上有未提交的改动，会先存成 `~/bob-bot-discarded/*.patch` 再替换）→ 依赖变化时 `npm install` → 重启 `bobbot.service` → 写入构建戳（`prototype/data/build.json`）→ 本机与公网双重健康检查，最后打印 `/api/version`。

**验收方式**：打开 https://ry.bobbik.org 登录后进入「设置」，底部会显示当前版本号与部署时间；`curl https://ry.bobbik.org/api/version` 也会返回同一个 commit。

`prototype/data/`（对话、浏览器登录态、密钥）和 `prototype/node_modules/` 不进仓库，部署时不会被覆盖。

### 一次性初始化（仅新机器或重建时需要）

```sh
ssh ubuntu@<RY-IP>
sudo mkdir -p /home/ubuntu/bob-bot && sudo chown ubuntu:ubuntu /home/ubuntu/bob-bot
git clone https://github.com/bobbik1984/bob-bot.git /home/ubuntu/bob-bot
cd /home/ubuntu/bob-bot/prototype && npm install && npm run set-pin -- <PIN>
sudo tee /etc/systemd/system/bobbot.service >/dev/null <<'EOF'
[Unit]
Description=BobBot test prototype
After=network-online.target
Wants=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/bob-bot/prototype
Environment=HOST=127.0.0.1 PORT=8787
ExecStart=/usr/bin/node server.mjs
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now bobbot
```

