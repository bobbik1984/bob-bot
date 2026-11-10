# BobBot 交接说明（给下一个 Agent）

> 目标：让接手的 Agent 在 10 分钟内知道项目在哪、读什么、怎么改、怎么发布、哪里不能碰。

## 0. 30 秒版

- 仓库：`/home/bobbik/dsh_projects/bob-bot`（GitHub `bobbik1984/bob-bot`，分支 `main`）
- 线上：**https://ry.bobbik.org**（VPS `ubuntu@82.157.186.181`，Cloudflare 隧道 → 127.0.0.1:8787）
- 形态：`prototype/` 是 Node.js + DSH 测试原型，**当前真正在维护和部署的就是它**；`docs/` 里的 Rust 正式版是后续路线
- 发布：`bash scripts/deploy-ry.sh`；验收看设置页版本号或 `curl https://ry.bobbik.org/api/version`
- 数据：`prototype/data/`（PIN、密钥、会话、记忆、功能包、微信登录态），**不提交、不删除**

## 1. 位置与环境

| 项 | 值 |
|---|---|
| 本机工作区 | `/home/bobbik/dsh_projects/bob-bot` |
| 原型目录 | `/home/bobbik/dsh_projects/bob-bot/prototype` |
| 远程 | `https://github.com/bobbik1984/bob-bot.git` |
| VPS | `ubuntu@82.157.186.181`（RY，腾讯云，Ubuntu 24.04，2C/2G+2G swap，Node 24.22.2，Chrome 157） |
| SSH 钥匙 | RY 只接受 x1t-workstation，文件 `~/.ssh/id_ed25519_github`；`vps1_deploy_ed25519` 只对 vps1 有效。ssh-agent 里没有时，先 `ssh-add` 或用 `BOB_RY_HOST` 指向带 `IdentityFile` 的别名。不要往 RY 的 `authorized_keys` 加临时钥匙 |
| 线上域名 | `https://ry.bobbik.org`（Cloudflare 隧道） |
| 服务 | `bobbot.service`（站点 8787 + bob-agent 兼容 API 3721）、`bobbot-wechat.service`（官方微信桥 + 发送接口 3722）、`cloudflared.service` |

注意：**本机 x1t 没有 `prototype/node_modules`，也没有 Chrome**，所以 `npm test` 在本机跑不了。正确做法：部署到 RY 后在那里跑，或按第 5 节用临时克隆。

## 2. 先读什么（按这个顺序）

1. [`AGENTS.md`](../AGENTS.md) —— 项目工作准则、边界规则、安全门禁（必读）
2. [`docs/UPDATES.md`](UPDATES.md) —— **当前已实现功能、主要优势、限制、提交时间线**
3. [`docs/CURRENT_STAGE.md`](CURRENT_STAGE.md) —— 当前阶段与下一步
4. [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) —— 系统设计；重点 §5（渠道、推送、功能包、记忆与主动性）
5. [`prototype/README.md`](../prototype/README.md) —— 原型的运行方式与行为约定
6. [`README.md`](../README.md) 的「部署到 RY」—— 一键发布与一次性初始化
7. [`todo.md`](../todo.md) / [`progress.yaml`](../progress.yaml) —— 未完成事项与机器可读进度

## 3. 代码地图（prototype/）

| 文件 | 职责 |
|---|---|
| `server.mjs` | 唯一入口：HTTP/SSE/WebSocket、会话、审批、clerk、微信/推送/记忆/主动关心/功能包的路由与调度 |
| `public/index.html` | 单页前端（无构建）：聊天、文员、设置、浏览器接管窗口、卡片、Orb、i18n、语音 |
| `agent.mjs` | DSH 子进程管理、模型调用、预算 |
| `browser.mjs` | 共享 Headless Chromium、CDP、截图/推流；页面快照（框架与 Shadow DOM）、标签页、下载、地址检查、崩溃恢复 |
| `store.mjs` | 状态文件原子写入与合并写入 |
| `clerk.mjs` | 待办、定时任务、收件箱、渠道数据模型 |
| `cards.mjs` | 模型生成信息卡的校验 |
| `channels.mjs` | 出站渠道（Lark/企微/Telegram/Discord/微信/手机通知） |
| `extensions.mjs` | MCP、技能、包安装 |
| `features.mjs` | 功能包：安装校验、试用与回退、旧版本、与沙箱进程通信（`data/features/`、`data/feature-storage/`） |
| `plugin-host.mjs` | 运行功能包服务器代码的受限子进程，不持有任何密钥 |
| `memory.mjs` | 长期记忆存储与做梦结果合并 |
| `compat-api.mjs` | bob-agent `/v1/*` 兼容 API（给微信 bridge 用） |
| `wechat/` | 官方微信核心与 bridge（vendored，勿换成非官方方案） |
| `scripts/deploy-ry.sh` | 发布脚本 |
| `test/unit.mjs`、`test/browser.mjs`、`test/e2e.mjs`、`test/ui-click.mjs` | 单元、浏览器引擎、端到端、手机/电脑窗口测试 |

## 4. 数据、密钥与不可提交项

RY 上 `prototype/data/` 包含：`pin.json`、`secrets.json`、`conversations/`、`memory.json`、`proactive.json`、`features/`、`vapid.json`、`push-subscriptions.json`、`wechat/`、`browser_profile/`。

- 已被 `.gitignore` 覆盖（`prototype/data/`、`node_modules/`、`.env`、日志、`debug/ui-shots/`）
- **不要**把任何 data 文件提交到 Git，也不要为了“干净”删除 RY 上的 data
- 微信登录态在 `~/.wechat-bot/` 与 `wechat/wechat-bot-bridge/data/`（`account.txt`、`owner.txt`、`context.json` 均不应提交）

## 5. 日常开发循环

```sh
cd /home/bobbik/dsh_projects/bob-bot
# 改代码 → 自测（见下）→ 提交
git add -A && git commit -m "..."
bash scripts/deploy-ry.sh          # 提交直推 RY（不经 GitHub）+ 依赖安装 + 重启 + 双端健康检查
```

验证：`curl -s https://ry.bobbik.org/api/version`，或打开站点 → 设置 → 底部的版本号与部署时间。

**测试**（在 RY 上用临时克隆，避免影响线上数据）：

```sh
ssh ubuntu@82.157.186.181
mkdir -p /tmp/bobtest/prototype
rsync -a --exclude node_modules --exclude data --exclude .git \
  /path/to/bob-bot/prototype/ ubuntu@82.157.186.181:/tmp/bobtest/prototype/   # 从本机执行
ssh ... 'ln -sfn /home/ubuntu/bob-bot/prototype/node_modules /tmp/bobtest/prototype/node_modules'
ssh ... 'cd /tmp/bobtest/prototype && node test/unit.mjs && node test/e2e.mjs'
```

当前基线：`unit 36/36`、`plugins 9/9`、`browser 20/20`、`e2e 73/73`、`ui 8/8`。e2e 需要 Chrome 与空闲端口；跑之前 `fuser -k 8799/tcp`。

**部署不依赖 GitHub**：RY 在国内，常连不上 GitHub。`deploy-ry.sh` 通过 SSH 把当前提交直接推给 RY（旁路引用 `refs/deploy/main`），RY 再 `git reset --hard` 到它；GitHub 备份在 x1t 上尽力推送，失败只警告。只部署已提交的内容，且必须在 `main` 上。`--via-github` 才让 RY 自己拉 GitHub。

**注意：部署会让 RY 的工作区与该提交完全一致**，RY 上直接改的文件会被替换。脚本会先把差异存成 `~/bob-bot-discarded/<时间>.patch` 并提示，需要时可用 `git apply` 找回。仍然不要在 RY 上直接做实验；先在本地提交再部署。`prototype/data/` 与未被跟踪的文件不受影响。

## 6. 当前状态（2026-11-10）

- 已上线能力、主要优势、限制：见 [`docs/UPDATES.md`](UPDATES.md)
- 一句话：卡片化对话 + 文员（待办/定时任务/收件箱）+ 官方微信桥 + PWA 推送 + 记忆/做梦/可调主动关心 + 受控功能包 + 一键部署
- 安全模型：危险动作审批；功能包安装展示代码；扩展启动失败自动降级；微信/推送失败如实记录
- 浏览器：**用户没有入口**，只有 agent 请求 `browser_request_human` 时才自动弹出接管窗口，处理完自动关闭
- 下一步：Android APK、邮件/Server酱兜底、主动性接受率学习、对话中提醒注入、审批风险分级、功能包子进程隔离、微信多媒体/群聊

## 7. 不要做的事

1. 不要把微信换回 wechaty/非官方协议
2. 不要把浏览器入口加回用户界面（只能由 agent 触发接管）
3. 不要绕过审批门禁，或让功能包写到 `data/features/` 以外；不要让功能包代码回到主进程里运行，也不要给页面注入功能包的脚本（只能用沙箱 iframe）
4. 不要提交 `prototype/data/`、密钥、微信登录态
5. 不要在 RY 上直接改代码后忘记同步回 Git（否则线上与仓库漂移）
6. 不要在未跑 unit/e2e 的情况下部署

## 8. 排障入口

```sh
ssh ubuntu@82.157.186.181
systemctl status bobbot bobbot-wechat cloudflared
journalctl -u bobbot -n 80 --no-pager
journalctl -u bobbot-wechat -n 80 --no-pager
curl -s http://127.0.0.1:8787/api/version
curl -s http://127.0.0.1:3722/status     # 微信桥是否登录
ss -tlnp | grep -E '8787|3721|3722'
```

常见问题：部署报 GitHub 超时（默认已不经 GitHub；若用了 `--via-github` 就改回默认）；Chromium 启动失败（检查 `data/browser_profile` 的 SingletonLock 与内存）；端口 3721/3722 被临时实例占用（`fuser -k`）；`node_modules` 缺包（`npm install`）。

## 9. 交接检查单（10 分钟）

- [ ] `git -C /home/bobbik/dsh_projects/bob-bot status` 干净，HEAD 与 origin 一致
- [ ] `curl -s https://ry.bobbik.org/api/version` 与本地 HEAD 一致
- [ ] `systemctl is-active bobbot bobbot-wechat cloudflared` 全部 active
- [ ] 读完 `AGENTS.md` + `docs/UPDATES.md` + 本文件
- [ ] 在临时克隆跑通 `unit` 与 `e2e`
- [ ] 知道 data 目录不能提交/删除
- [ ] 知道浏览器只在 takeover 时打开
