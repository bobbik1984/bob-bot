// send-server.ts — 供 BobBot 主动发消息（提醒/任务结果）的本地 HTTP 接口
import http from 'node:http';

import { sendMessageWeixin, resolveWeixinAccount } from '@gemini/wechat-bot-core';

export interface SendServerOptions {
  port: number;
  /** 当前已登录的账号 id；由 index.ts 在登录后维护 */
  accountId: () => string;
  /** 默认接收人：扫码登录者，或最近一次给机器人发消息的人 */
  owner: () => string;
  /** 该用户最近一次来信携带的 context_token；主动推送要用它 */
  context: (to: string) => { token?: string; at?: number };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 256 * 1024) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function startSendServer({ port, accountId, owner, context }: SendServerOptions) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        const account = resolveWeixinAccount(accountId());
        return json(200, {
          connected: Boolean(account.token),
          accountId: account.accountId,
          owner: owner(),
        });
      }
      if (req.method === 'POST' && url.pathname === '/send') {
        const body = JSON.parse((await readBody(req)) || '{}') as { text?: string; to?: string };
        const text = String(body.text ?? '').trim();
        const to = String(body.to ?? '').trim() || owner();
        if (!text) return json(400, { ok: false, error: 'text is required' });
        const account = resolveWeixinAccount(accountId());
        if (!account.token) return json(409, { ok: false, error: '微信尚未登录' });
        if (!to) return json(409, { ok: false, error: '还没有接收人：请先给机器人发一条消息' });
        const ctx = context(to);
        await sendMessageWeixin({
          to,
          text,
          opts: { baseUrl: account.baseUrl, token: account.token, contextToken: ctx.token },
        });
        return json(200, {
          ok: true,
          usedContext: Boolean(ctx.token),
          tokenAgeMs: ctx.at ? Date.now() - ctx.at : null,
        });
      }
      return json(404, { ok: false, error: 'not found' });
    } catch (error) {
      return json(500, { ok: false, error: String((error as Error)?.message ?? error) });
    }
  });
  server.on('error', (error) => console.error('[send-server] 启动失败:', error.message));
  server.listen(port, '127.0.0.1', () => console.log(`[send-server] 监听 http://127.0.0.1:${port}/send`));
  return server;
}
