// bob-client.ts — Bob-Agent HTTP API 客户端（SSE 流式 + 会话列表）
import { config } from './config.js';
import type { ConversationMeta } from './session-mgr.js';

// ── 会话列表 ──────────────────────────────────────────────

/** 获取 Bob 中最近 N 条会话 */
export async function getRecentConversations(limit = 5): Promise<ConversationMeta[]> {
  try {
    const res = await fetch(`${config.bob.baseUrl}/v1/conversations`);
    if (!res.ok) return [];
    const data = await res.json() as Array<{ id: string; title: string; updated_at: number }>;
    return data.slice(0, limit).map((c) => ({
      id: c.id,
      title: c.title || '未命名对话',
      updated_at: c.updated_at,
    }));
  } catch (e) {
    console.error('[bob-client] getRecentConversations 失败:', e);
    return [];
  }
}

// ── 聊天（SSE 流式消费）────────────────────────────────────

export interface ChatOptions {
  message: string;
  conversationId?: string | null;
  fromUser?: string;
  /** 每次收到 typing 占位 chunk 时调用，用于刷新微信"对方正在输入"状态 */
  onTyping?: () => void;
}

export interface ChatResult {
  /** 最终完整回复文本 */
  fullText: string;
  /** Bob 实际使用的会话 ID（可能是新建的） */
  conversationId: string;
}

/**
 * 向 Bob POST /v1/chat，消费 SSE 流，返回完整回复文本和会话 ID。
 * 每接收到 text chunk 时触发 onTyping 回调，让微信侧持续刷新 typing 状态。
 */
export async function chatWithBob(opts: ChatOptions): Promise<ChatResult> {
  const body = {
    message: opts.message,
    conversation_id: opts.conversationId ?? null,
    from_channel: 'wechat',
    from_user: opts.fromUser,
  };

  const res = await fetch(`${config.bob.baseUrl}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const msg = `[bob-client] POST /v1/chat 失败: ${res.status}`;
    console.error(msg);
    throw new Error(msg);
  }

  // ── 逐行解析 SSE ──────────────────────────────────────
  let fullText = '';
  let conversationId = opts.conversationId ?? '';

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // 最后一行可能不完整，留到下次

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue; // 空行/注释跳过

      // 解析 "event: xxx" + "data: xxx" 对
      if (trimmed.startsWith('data: ')) {
        const dataStr = trimmed.slice(6);
        try {
          const payload = JSON.parse(dataStr) as Record<string, unknown>;

          if ('content' in payload && typeof payload.content === 'string') {
            fullText += payload.content;
            opts.onTyping?.();
          }
          if ('conversation_id' in payload && typeof payload.conversation_id === 'string') {
            conversationId = payload.conversation_id;
          }
          if ('full_text' in payload && typeof payload.full_text === 'string') {
            // done 事件携带完整文本（比逐片累积更可靠）
            fullText = payload.full_text as string;
          }
        } catch {
          // 忽略解析失败的行
        }
      }
    }
  }

  return { fullText, conversationId };
}

/** 检查 Bob HTTP API 是否在线 */
export async function checkBobHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${config.bob.baseUrl}/v1/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
