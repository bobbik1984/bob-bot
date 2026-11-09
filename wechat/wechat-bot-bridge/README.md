# wechat-bot-bridge

微信消息 ↔ Bob-Agent 桥接服务。

## 架构

```
微信用户
  │ 发送消息
  ▼
wechat-bot-core (长轮询)
  │ onMessage 回调
  ▼
wechat-bot-bridge (本项目)
  │ 指令路由 / 会话管理 / 消息队列
  ▼
Bob-Agent HTTP API (127.0.0.1:3721)
  │ POST /v1/chat — SSE 流式对话
  ▼
LLM 回复
  │
  ▼
微信用户 (回复消息)
```

## 快速开始

### 1. 配置

编辑 `data/config.json`：

```json
{
  "weixin": {
    "accountId": "你的微信账号 ID"
  },
  "bob": {
    "baseUrl": "http://127.0.0.1:3721"
  }
}
```

也可以用环境变量（优先级更高）：
- `WECHAT_ACCOUNT_ID` — 微信账号 ID
- `BOB_API_URL` — Bob HTTP API 地址（默认 http://127.0.0.1:3721）

### 2. 启动 Bob-Agent

先运行 Bob-Agent（Tauri 桌面应用），确保 `:3721` 端口已开放。

### 3. 启动 Bridge

```bash
npm install
npm run dev   # 开发模式（热重载）
# 或
npm start     # 生产模式
```

## 支持的指令

| 指令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/new` | 开启全新对话 |
| `/chat` | 列出最近会话，回复序号切换 |
| `/status` | 查看当前会话 ID |
| 普通文字 | 直接与 Bob 对话 |

## 注意事项

- 同一微信用户的消息按**串行队列**处理，防止乱序
- Bob 回复超过 3800 字时自动截断
- 会话绑定持久化在 `data/sessions.json`
