# WeChat bridge (official iLink)

Two projects, vendored so RY can run them without extra downloads:

- `wechat_bot/` — Tencent's official OpenClaw WeChat channel (`@gemini/wechat-bot-core`), talking to `ilinkai.weixin.qq.com`
- `wechat-bot-bridge/` — turns WeChat messages into `POST /v1/chat` calls against BobBot and sends the reply back

BobBot serves the same `/v1/*` contract as bob-agent on `127.0.0.1:3721` (see `prototype/compat-api.mjs`), so the bridge only needs `BOB_API_URL`.

## First run

```sh
cd wechat/wechat_bot && npm install --omit=dev
cd ../wechat-bot-bridge && npm install --omit=dev
node --import tsx/esm src/index.ts
```

Without a saved token the bridge prints a `liteapp.weixin.qq.com` login link and waits up to eight minutes. After the scan it stores the token under `~/.wechat-bot/` and the account id in `data/account.txt`, so later restarts skip the login.

## Proactive messages (reminders)

Official iLink hands out a per-conversation `context_token` with each inbound message, and proactive pushes are unreliable without a fresh one: the API can accept the call while the user sees nothing. The bridge now stores the latest token per contact in `data/context.json` and passes it on every `/send`. Reminders therefore work best when the owner has written to the bot recently; the app records the delivery result honestly, and the in-app inbox is always authoritative.

## Service

`bobbot-wechat.service` runs the bridge with `BOB_API_URL=http://127.0.0.1:3721`.
