// index.ts — wechat-bot-bridge 入口
// 职责：微信消息 ↔ Bob-Agent HTTP API 路由 + 指令状态机 + 消息串行队列
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  startMonitor,
  startLoginWithQr,
  waitForLogin,
  resolveWeixinAccount,
  saveWeixinAccount,
  registerWeixinAccountId,
} from '@gemini/wechat-bot-core';
import type { WeixinMessage } from '@gemini/wechat-bot-core';

import { config } from './config.js';
import { sessionMgr } from './session-mgr.js';
import { msgQueue } from './message-queue.js';
import { chatWithBob, getRecentConversations, checkBobHealth } from './bob-client.js';
import { startTypingHeartbeat } from './typing-manager.js';
import { startSendServer } from './send-server.js';

// ── 指令帮助文本 ──────────────────────────────────────────
const HELP_TEXT = `可用指令：
/chat  — 列出最近会话，回复序号切换
/new   — 开启全新会话
/status — 查看当前会话 ID
/help  — 显示此帮助

直接发送文字即可与 Bob 对话 🤖`;

// ── 非文字消息类型映射 ────────────────────────────────────
const MSG_TYPE_NAMES: Record<number, string> = {
  3: '图片',
  34: '语音',
  43: '视频',
  49: '文件',
};

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const OWNER_FILE = path.join(DATA_DIR, 'owner.txt');
const ACCOUNT_FILE = path.join(DATA_DIR, 'account.txt');

function readFileSafe(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8').trim();
  } catch {
    return '';
  }
}

/** 提醒的默认接收人：扫码登录的人，或最近给机器人发消息的人。 */
function readOwner(): string {
  return readFileSafe(OWNER_FILE);
}

function writeOwner(wxid: string | undefined): void {
  if (!wxid) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(OWNER_FILE, wxid);
  } catch (error) {
    console.error('[main] 写入 owner.txt 失败:', error);
  }
}

const CONTEXT_FILE = path.join(DATA_DIR, 'context.json');

/** 每个联系人最近一次来信的 context_token：官方接口的主动推送需要它。 */
function readContexts(): Record<string, { token?: string; at?: number }> {
  try {
    return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function rememberContext(wxid: string | undefined, token: string | undefined): void {
  if (!wxid || !token) return;
  try {
    const all = readContexts();
    all[wxid] = { token, at: Date.now() };
    const ids = Object.keys(all).slice(-200);
    fs.writeFileSync(CONTEXT_FILE, JSON.stringify(Object.fromEntries(ids.map((id) => [id, all[id]]))));
  } catch (error) {
    console.error('[main] 写入 context.json 失败:', error);
  }
}

function activeAccountId(): string {
  return readFileSafe(ACCOUNT_FILE) || config.weixin.accountId;
}

// ── 主消息处理逻辑 ────────────────────────────────────────
async function handleMessage(
  wxid: string,
  text: string,
  typingCtx: { baseUrl: string; token: string },
): Promise<string> {

  // 1. /help
  if (text === '/help') return HELP_TEXT;

  // 2. /new — 立即开启新会话
  if (text === '/new') {
    sessionMgr.bindSession(wxid, null);
    return '✅ 已开启全新会话，接下来的消息将进入新对话。';
  }

  // 3. /status — 查看当前绑定
  if (text === '/status') {
    const convId = sessionMgr.getConvId(wxid);
    return convId
      ? `当前会话：${convId.slice(0, 8)}…（发送 /chat 可切换）`
      : '当前无活跃会话（下条消息将自动新建）';
  }

  // 4. /chat 或 /list — 列出最近会话
  if (text === '/chat' || text === '/list') {
    const list = await getRecentConversations(5);
    if (list.length === 0) {
      return '暂无历史会话，直接发消息开始吧 💬';
    }
    sessionMgr.setSelecting(wxid, list);
    let reply = '请回复序号切换会话（60 秒内有效）：\n';
    list.forEach((c, i) => {
      reply += `[${i + 1}] ${c.title || '未命名对话'}\n`;
    });
    reply += '[0] 开启全新会话';
    return reply;
  }

  // 5. 选单模式中处理序号回复
  if (sessionMgr.isSelecting(wxid)) {
    if (/^[0-9]$/.test(text)) {
      const idx = parseInt(text, 10);
      if (idx === 0) {
        sessionMgr.bindSession(wxid, null);
        return '✅ 已开启全新会话。';
      }
      const list = sessionMgr.getPendingList(wxid);
      const target = list?.[idx - 1];
      if (!target) {
        return `❌ 序号无效，请回复 1-${list?.length ?? 5} 之间的数字，或发送 /chat 重新列出。`;
      }
      sessionMgr.bindSession(wxid, target.id);
      sessionMgr.cancelSelecting(wxid);
      return `✅ 已切换至「${target.title || '未命名对话'}」，继续上下文吧。`;
    } else {
      // 输入不是序号 → 自动退出选单，当普通消息处理
      sessionMgr.cancelSelecting(wxid);
    }
  }

  // 6. 正常对话：发给 Bob
  const activeConvId = sessionMgr.getConvId(wxid);

  // 启动 sendTyping 心跳
  const stopTyping = startTypingHeartbeat({
    ...typingCtx,
    toUserId: wxid,
  });

  let result: { fullText: string; conversationId: string };
  try {
    result = await chatWithBob({
      message: text,
      conversationId: activeConvId,
      fromUser: wxid,
    });
  } finally {
    stopTyping();
  }

  // 更新 session 绑定（使用 Bob 返回的实际 conversationId）
  if (result.conversationId) {
    sessionMgr.bindSession(wxid, result.conversationId);
  }

  const reply = result.fullText || '（Bob 未返回内容，请稍后重试）';

  // 7. 长文本分段（微信单条上限约 4000 字符）
  if (reply.length > 3800) {
    return reply.slice(0, 3800) + '\n…（回复「继续」查看剩余内容）';
  }
  return reply;
}

// ── 启动入口 ──────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║     wechat-bot-bridge  starting      ║');
  console.log('╚══════════════════════════════════════╝');

  // 1. 检查 Bob 是否在线
  const bobOnline = await checkBobHealth();
  if (!bobOnline) {
    console.warn('[main] ⚠️  Bob-Agent 未响应 (127.0.0.1:3721)，请先启动 bob-agent！');
    console.warn('[main] Bridge 仍会继续运行，但聊天功能将不可用直到 Bob 上线。');
  } else {
    console.log('[main] ✅ Bob-Agent 在线');
  }

  // 2. 加载微信账号
  if (!config.weixin.accountId) {
    console.error('[main] ❌ 未配置 WECHAT_ACCOUNT_ID，请在 data/config.json 或环境变量中设置');
    process.exit(1);
  }

  let account;
  try {
    account = resolveWeixinAccount(config.weixin.accountId);
  } catch (e) {
    console.error('[main] ❌ 无法加载微信账号信息:', e);
    process.exit(1);
  }

  if (!account.token) {
    console.log('[main] 未找到已保存的 token，开始 QR 登录…');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const qrResult = await startLoginWithQr({ apiBaseUrl: account.baseUrl, accountId: config.weixin.accountId });
    if (!qrResult?.qrcodeUrl) {
      console.error('[main] ❌ 无法获取二维码:', qrResult?.message ?? 'unknown error');
      process.exit(1);
    }
    fs.writeFileSync(path.join(DATA_DIR, 'qr.txt'), qrResult.qrcodeUrl);
    console.log(`[main] 📱 请用手机微信扫码登录（8 分钟内有效）：${qrResult.qrcodeUrl}`);
    const login = await waitForLogin({
      sessionKey: qrResult.sessionKey,
      apiBaseUrl: account.baseUrl,
      timeoutMs: 480_000,
      verbose: false,
    });
    if (!login.connected || !login.accountId || !login.botToken) {
      console.error('[main] ❌ QR 登录未完成:', login.message);
      process.exit(1);
    }
    saveWeixinAccount(login.accountId, { token: login.botToken, baseUrl: login.baseUrl, userId: login.userId });
    registerWeixinAccountId(login.accountId);
    fs.writeFileSync(path.join(DATA_DIR, 'account.txt'), login.accountId);
    writeOwner(login.userId);
    console.log(`[main] ✅ 登录成功，账号 ${login.accountId}`);
    account = resolveWeixinAccount(login.accountId);
  }

  console.log(`[main] 微信账号 ${account.accountId} 已就绪，开始监听消息…`);

  const typingCtx = { baseUrl: account.baseUrl, token: account.token! };

  // BobBot 用这个本地接口主动发提醒和任务结果
  startSendServer({
    port: Number(process.env.WECHAT_SEND_PORT || 3722),
    accountId: activeAccountId,
    owner: readOwner,
    context: (to: string) => readContexts()[to] ?? {},
  });

  // 3. 启动长轮询监听
  await startMonitor({
    accountId: account.accountId,
    baseUrl: account.baseUrl,
    cdnBaseUrl: account.cdnBaseUrl,
    token: account.token!,

    onMessage: async (msg: WeixinMessage) => {
      const wxid = msg.from_user_id;
      if (!wxid) return;
      writeOwner(wxid);
      rememberContext(wxid, msg.context_token);

      // 过滤非文字消息
      const textItem = msg.item_list?.find((i: { type?: number }) => i.type === 1);
      if (!textItem) {
        const msgType = msg.item_list?.[0]?.type ?? 0;
        const typeName = MSG_TYPE_NAMES[msgType] ?? '该类型消息';
        return `暂不支持接收${typeName}，请发送文字消息。`;
      }

      const text = textItem.text_item?.text?.trim();
      if (!text) return;

      // 串行化：同一用户的请求顺序执行
      return new Promise<string>((resolve) => {
        msgQueue.enqueue(wxid, async () => {
          try {
            const reply = await handleMessage(wxid, text, typingCtx);
            resolve(reply);
          } catch (err) {
            console.error(`[main] handleMessage error for wxid=${wxid}:`, err);
            resolve('⚠️ 服务暂时异常，请稍后重试。');
          }
        });
      });
    },
  });
}

// ── 优雅退出 ──────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[main] 收到 SIGINT，正在退出…');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[main] 收到 SIGTERM，正在退出…');
  process.exit(0);
});

main().catch((err) => {
  console.error('[main] 致命错误:', err);
  process.exit(1);
});
