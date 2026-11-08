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

## Chats and history

The menu button at the top left opens the history panel: a list of chats, a "New chat" button, and swipe left on a chat to reveal the red cross that deletes it. Deleting also removes the model's saved copy of that chat.

Each chat is its own conversation with its own context. Bob works in one chat at a time, because every chat shares the same browser and server, so a message to another chat while Bob is busy is refused until it finishes. The pending approvals and browser requests of every chat appear together in the Pending tab.

After the server or agent restarts, the first message in an old chat gets the earlier text of that chat as context. Earlier tool results and attached file contents are not replayed.

The page is light-only for now, and the orb in the header shows what Bob is doing: napping, thinking or replying.

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
- `browser.mjs` drives Chromium and streams it to the phone.
- `prices.json` holds DeepSeek prices copied from model-registry, in CNY per 1M tokens.

## Known limits

- Replies appear one step at a time, not word by word.
- Only one chat can be worked on at a time.
- A chat's saved history keeps the last 400 events, and approval screenshots are not saved.
- The API key is saved as a private plain-text file in `data/`, and anyone with server access can read it and the browser profile.
- Approval uses button-text rules, so an unusually labelled button can get through.
- QR login needs a second device, and passkeys do not work remotely.
- Only the top-level page is numbered for the agent, so content inside iframes and shadow DOM is invisible to it.
- Pages without a mobile viewport tag appear zoomed out on the phone, and there is no pinch zoom or sideways scroll yet.
- Attachments are text files only, and the "Other model" option is untested.

## Test

```sh
npm test        # server, agent loop, approvals, phone window, models, attachments, spending limit
npm run test:ui # drives the real page in a phone-sized Chrome and clicks the cloud browser
```

`npm test` runs real DSH and real Chromium against a scripted fake model, so it needs no API key. It checks the custom-model address against real DNS, so it needs internet access. `npm run test:ui` needs Chrome, Edge or Chromium (set `CHROME_PATH` if it is not found).
