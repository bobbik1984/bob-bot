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

## Service

`bobbot-wechat.service` runs the bridge with `BOB_API_URL=http://127.0.0.1:3721`.
