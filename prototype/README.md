# BobBot test prototype

A small Node.js server that combines PIN login, chat through DeepSeek Harness (DSH), and one persistent cloud browser you can take over from your phone.

This is a test prototype. Use test accounts and do not connect financial accounts.

## Run it

Needs Node.js 22+ and Chrome, Edge or Chromium. Set `CHROME_PATH` if it is installed somewhere unusual.

```sh
npm install
npm run set-pin -- 1234
npm start
```

Open `http://127.0.0.1:8787`, enter the PIN, and paste a DeepSeek API key when asked.

To change the PIN, run `npm run set-pin -- 5678` on the server. This also clears any lockout and logs out every device.

## Testing from a phone

The server listens only on this machine by default. To reach it from a phone, put it behind HTTPS with a reverse proxy such as Caddy, or a private network such as Tailscale, and set `HOST` only if you need to:

```sh
HOST=0.0.0.0 PORT=8787 npm start
```

Do not expose plain HTTP to the internet, because the PIN and session cookie would travel unencrypted.

A 4-digit PIN is weak on its own. Five wrong tries lock login for 15 minutes, and the lock doubles each time up to 24 hours. Anyone who repeatedly enters wrong PINs can also lock you out, and `set-pin` clears that.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Listen address |
| `BOBBOT_MODEL` | `deepseek-flash` | Model name, which must exist in `prices.json` |
| `BOBBOT_CNY_PER_USD` | `7.2` | Exchange rate for the USD spending limit |
| `DEEPSEEK_API_KEY` | none | Used instead of the key saved in Settings |
| `CHROME_PATH` | auto-detected | Browser executable |
| `BOBBOT_CHROME_NO_SANDBOX` | off | Set to `1` only when running Chromium as root in a container |
| `BOBBOT_DATA` | `./data` | Login, key, browser profile and chat history |
| `BOBBOT_DEBUG` | off | Print DSH logs and events |

## How it works

- `server.mjs` serves the web app and the browser tools, and enforces the approvals.
- `agent.mjs` runs `dsh --profile sdk-minimal` over stdio, so DSH opens no port. It also tracks spending.
- `dsh.patch.yml` removes DSH's shell, so the agent can act only through the browser tools.
- `browser.mjs` drives Chromium and streams it to the phone.
- `prices.json` holds DeepSeek prices copied from model-registry, in CNY per 1M tokens.

## Known limits

- Replies appear one step at a time, not word by word.
- The agent's memory of the conversation resets when the server restarts. The visible chat history stays.
- The API key is saved as a private plain-text file in `data/`, and anyone with server access can read it and the browser profile.
- Approval uses button-text rules, so an unusually labelled button can get through.
- QR login needs a second device, and passkeys do not work remotely.
- Only the top-level page is numbered for the agent, so content inside iframes and shadow DOM is invisible to it.

## Test

```sh
npm test
```

This runs real DSH and real Chromium against a scripted fake model, so it needs no API key. It does open `example.com`.
