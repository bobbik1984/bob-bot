# BobBot test prototype

A small Node.js server that combines PIN login, chat through DeepSeek Harness (DSH), and one persistent cloud browser you can take over from your phone.

This is a test prototype. Use test accounts and do not connect financial accounts.

The interface follows the browser language, and Settings → Language lets you pin 简体中文 or English.

The orb draws its own mood: sleeping bubbles while idle, a thought cloud while working, and little dots from its mouth while answering. No status words are shown.

## WeChat (official bridge only)

There is no unofficial WeChat client built into BobBot. WeChat is reached through the official iLink bot (the same one bob-agent uses: `ilinkai.weixin.qq.com` plus a `liteapp.weixin.qq.com` login QR) with your own `wechat_bot` and `wechat-bot-bridge` processes.

BobBot exposes the same local API that bob-agent did, so the bridge only needs its base URL changed:

- `POST /v1/chat` — SSE with `text`, `thinking`, `tool_start`, `tool_end` and `done` (carrying `conversation_id` and `full_text`)
- `GET /v1/conversations`, `GET /v1/health`
- request: `{ message, conversation_id, from_channel, from_user, from_name? }`
- each `from_user` becomes its own conversation, titled `WeChat · <name or wxid>`

Default: `127.0.0.1:3721`. Set `BOB_COMPAT_HOST=100.64.0.3` (a Tailscale address) to let a bridge on another machine reach it; keep it off the public internet, since this endpoint is trusted like a local process.

## Run it

Needs Node.js 24.9+ (DSH requires it) and Chrome, Edge or Chromium. Set `CHROME_PATH` if it is installed somewhere unusual.

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

## Chats and history

The front page is a single large orb. Once a chat has something in it, the orb moves to the top left and shrinks, and tapping it opens the history panel: a list of chats, a "New chat" button, and swipe left on a chat to reveal the red cross that deletes it. Deleting also removes the model's saved copy of that chat.

Each chat is its own conversation with its own context. Bob works in one chat at a time, because every chat shares the same browser and server, so a message to another chat while Bob is busy is refused until it finishes. Approval cards stay in the chat they belong to, and a banner above the message box tells you when Bob needs you in a different chat.

After the server or agent restarts, the first message in an old chat gets the earlier text of that chat as context. Earlier tool results and attached file contents are not replayed.

The page follows the system's light or dark setting (Settings → Appearance pins one), and the orb shows what Bob is doing: napping, thinking or replying.

On a window at least 1000px wide the history and the tabs become a sidebar. The front page greets you and shows what is waiting (drafts to approve, jobs that need you, open to-dos, unread results). The message box grows up to a few lines: Enter sends and Shift+Enter starts a new line. New replies follow the bottom only while you are there; if you have scrolled up, a "Latest" button appears instead.

## The clerk: scheduled tasks and reminders

Tell Bob in chat, for example "every morning at 8, check the weather in Shanghai and tell me what to wear and whether to bring an umbrella", or "remind me at 3pm to call the client". Bob shows a card with the schedule he understood, and nothing is scheduled until you confirm it. The Clerk tab lists your jobs (run now, pause, delete, see the run), an inbox of reminders and results with an unread badge, your channels, and your time zone.

- **Reminders** deliver the exact text at the time. **Tasks** wake Bob at the time to do the work, and the result goes to the inbox and your channels. Each task has its own conversation, so you can see what it did.
- **Schedules** are daily, weekly (chosen days), monthly or once, in your time zone, including daylight saving changes. A run more than two hours late (for example because the server was off) is skipped and reported as missed. A task waits while Bob is busy with something else.
- **Unattended rules:** a scheduled task can read web pages with `web_fetch` and browse read-only, but it cannot ask for approval, run commands, install anything or change the schedule. If it hits something that needs approval, it skips that and the run is recorded as partly done. If a login has expired, the run is recorded as needing you: you get a notification, the job in the Clerk tab shows a button that opens the page it stopped on, and the job runs again once you hand back.
- **Time:** every message to Bob starts with the current time and your time zone, so "tomorrow at 3" means what you mean.
- **Cost:** a task is a normal model run and counts toward the monthly spending limit. If the limit is reached, tasks report that they could not run.

**Channels** are where results go besides the inbox. Add them in the Clerk tab, never in chat, so webhooks and tokens never reach the model. They are checked against the real service address, kept only on the server, and shown as `••••` plus the last characters.

| Channel | You provide | Works from a server in mainland China |
| --- | --- | --- |
| Lark / Feishu group bot | Webhook, and the signing secret if you turned signing on | Yes |
| WeCom (企业微信) group bot | Webhook | Yes |
| Telegram bot | Bot token (chat id is found automatically after you message the bot) | No |
| Discord webhook | Webhook | No |

Personal WeChat is reached only through the official iLink bridge described above, and it can only reach contacts who messaged recently. "Send a test" tells you whether the service accepted the message and why not if it did not.

## Routines and drafts

After Bob finishes real work in a chat, a "Save as a routine" link appears, or you can ask in your own words. Bob builds the routine from the steps that actually happened, with a success check, the points where a person must decide, and what to do if the source data is missing. You confirm it, it gets one trial run whose result stays in the app, and it is scheduled only after you turn it on.

Each run reports whether the success check was met. That is the model's own judgement of its result, so read the first few results. A routine that misses its check is recorded as failed, and one that does not report is recorded as partly done.

When a scheduled run reaches something that needs approval (a command, writing a file, a risky click or submit on a page), it saves the exact action as a draft and carries on. Drafts appear at the top of the Clerk tab with what they will do. Approving runs that saved action without asking the model again: a page action is repeated on a fresh copy of the page, and stops if a recorded element is gone or is no longer unique. Discarded drafts never run, and unanswered ones expire after 7 days. Installing software and changing the schedule are never drafted.

## Memory, dreaming and check-ins

Every chat, WeChat conversation and scheduled task now receives what Bob remembers: unfinished work and preferences first, then whatever the message mentions, up to about 1500 characters. A new chat also gets open to-dos, scheduled jobs and what the last few chats were about. Memory supplies facts such as your city. Weather is always fetched fresh.

- **Dreaming** runs once a night between 03:30 and 08:00 and retries if it fails, so it works with check-ins off. Settings shows the last failure. A single dream can remove at most 3 memories, and what it removed is logged.
- **Check-ins** are off by default. The switch controls only whether Bob may message you first. Memory, dreaming, reminders and tasks work either way. The level sets the daily message limit and tone, and adds check moments at 12:30, 15:30 and 20:30 when your own times are too few for that limit.

## Installing tools by chat

Ask Bob for what you need, for example "install the GitHub tool" or "teach yourself my weekly report format". Every install shows a card with exactly what will happen, and nothing happens until you confirm.

| Ask for | What Bob does | Takes effect |
| --- | --- | --- |
| A package | `install_package` with npm (global), pip (in BobBot's own virtualenv) or apt (needs sudo). Package names only, so no URLs, flags or shell syntax. The card shows the exact command. | At once |
| A tool server (MCP) | `mcp_add` with a local command or a remote https address. Secrets such as `GITHUB_TOKEN` are named in the card, and you enter their values in Settings, never in chat. | On your next message, after Bob restarts |
| A skill | `skill_create` (Bob writes it and you read it first) or `skill_install` from the address of a `SKILL.md`. Skills are loaded live. | At once |

Settings > Extensions lists what is installed, takes the secrets, and removes things. An MCP server's tools run without asking each time once it is installed, so add only servers you trust, and a scheduled task can use them too. DSH's own in-process plugins are not offered: they run inside Bob's process with the API key and could bypass every approval. An MCP server runs as a separate process and covers the same ground.

On a fresh Ubuntu server, installing Python packages needs `python3-venv` first, which Bob can install with apt after you confirm.

## Server tools and approvals

Besides the browser, Bob can work on the machine it runs on: `list_files`, `read_file`, `write_file` and `run_command`. DSH's own shell and file tools stay switched off, so everything goes through BobBot's approval rules:

| Action | Approval |
| --- | --- |
| Read or list files inside Bob's workspace folder (`data/workspace`) | No |
| Read or list anywhere else | Yes, with the path shown |
| Write a file | Always, with a preview |
| Run a command | Always, with the exact command and the folder it runs in |

Commands run as the user who started BobBot, with API keys and tokens removed from their environment, and stop after 60 seconds unless Bob asks for longer (up to 300). BobBot's own data (keys, PIN, browser profile) and `~/.ssh`, `~/.gnupg` and the sudoers files cannot be read or written through the file tools at all.

Read each command before you allow it. A command can do anything its user can do, and the file block does not apply to commands. If that user has passwordless `sudo`, an approved command can act as root, and text from a web page or a file could try to talk Bob into asking for something harmful.

## The browser window

The cloud browser takes the shape of the device that opens it. On a phone it is a phone: a phone-sized page, a mobile user agent and touch, so sites such as ctrip.com serve their mobile version, readable at your screen's scale. On a PC it is a PC: a desktop page as wide as the window, a mouse that can hover, the wheel, and your keyboard typing straight into the page (use the box below the page for Chinese). Rotating the phone or resizing the window fits the page again.

For a site that has no mobile version, the "desktop site" button on a phone lays the page out wide, and pinching with two fingers zooms and moves it. When nobody has the window open, Bob browses the way you last did.

## What Bob can do in the browser

Bob reads the visible page as numbered elements, including iframes, open shadow DOM and clickable elements built from plain `<div>`s. It can click, type, choose from dropdowns, hover, press keys, go back, wait for slow content, read whole pages, tables and link lists in pieces, work across tabs, download into `data/workspace/downloads`, and upload from the workspace (always with approval).

- Bob never types into a password or one-time-code field, and their values never reach the model. It asks you to take over instead.
- Every document, including redirects, frames and clicked links, is checked against the public-address rule.
- A click is refused if something else is on top of the element, so the approval rules always judge what will really be clicked.
- If Chromium crashes, the next action restarts it. Logins are kept on disk.

## Models and keys

Settings shows whether a key is saved (as `sk-••••1234`, never the full key) and lets you replace it. The model dropdown lists the DeepSeek models your key can use.

**Other model (experimental):** choose "Other model" to enter your own endpoint, model name, key and prices. DeepSeek Harness speaks the Anthropic Messages protocol, so the service must support it, and requests go to `<endpoint>/v1/messages`. The endpoint must be https and public, and the prices (USD per 1M tokens) are what the monthly limit counts. This path is not verified against any real service yet, so treat it as a trial. Changing the model starts a fresh conversation.

## Attachments

The paperclip next to the message box attaches up to 5 text files (txt, md, csv, tsv, json, log, xml, html, yaml, sql), up to about 200KB each and 500KB in total. Chinese Excel CSV files saved as GBK are read correctly. The file text is sent to the model labelled as data, not instructions, and the chat history keeps only the file names.

PDF, Word, Excel and images are not supported yet. For a spreadsheet, export it as CSV first.

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
- `dsh.patch.yml` removes DSH's own shell and file tools, so the agent can act only through BobBot's tools.
- `host-tools.mjs` does the file and command work and refuses the protected folders.
- `browser.mjs` drives Chromium, matches it to the owner's device, and streams it to the page.
- `clerk.mjs`, `channels.mjs` and `web-fetch.mjs` are the schedules and inbox, the message senders, and read-only web access.
- `extensions.mjs` validates and builds package installs, MCP server config and skills. `net-guard.mjs` keeps addresses public.
- `prices.json` holds DeepSeek prices copied from model-registry, in CNY per 1M tokens.

## Known limits

- Replies appear one step at a time, not word by word.
- Only one chat can be worked on at a time.
- A chat's saved history keeps the last 400 events, and approval screenshots are not saved.
- The API key is saved as a private plain-text file in `data/`, and anyone with server access can read it and the browser profile.
- Approval uses button-text rules, so an unusually labelled button can get through.
- QR login needs a second device, and passkeys do not work remotely.
- Content inside closed shadow DOM is invisible to the agent. Iframes (including cross-site ones) and open shadow DOM are read and clickable.
- A scheduled run cannot wait for an approval: it skips that step and reports it. Only an expired login can be finished later.
- Downloads stop at 50 MB and only the latest 20 are kept.
- Scheduled tasks and reminders run only while the server is up. A run that was due while it was off is reported as missed, not made up.
- Telegram and Discord cannot be reached from servers in mainland China.
- Installing a package or tool server can run arbitrary code from that package. The card shows what, but not whether the package is safe.
- Phones in "desktop site" mode scroll by dragging and click by tapping, so a slider captcha needs the normal mobile mode.
- Attachments are text files only, and the "Other model" option is untested.

## Test

```sh
npm run test:unit # schedules and daylight saving, clerk store, channel messages, web_fetch (no network needed)
npm test          # server, agent loop, approvals, clerk, extensions, models, attachments, spending limit
npm run test:browser # frames, shadow DOM, tabs, dialogs, downloads, the address guard, crash recovery (local pages, no network)
npm run test:ui   # drives the real page as a phone and as a PC, and clicks, hovers and types into the cloud browser
```

`npm test` runs real DSH and real Chromium against a scripted fake model, so it needs no API key. It needs internet access (real DNS, `example.com`, and one call to the Lark service with a fake token to check that failures are recorded), and it takes a few minutes because it waits for a reminder to fire at its minute. `npm run test:ui` needs Chrome, Edge or Chromium (set `CHROME_PATH` if it is not found).
