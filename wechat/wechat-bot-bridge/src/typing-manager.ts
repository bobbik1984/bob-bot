// typing-manager.ts — sendTyping 心跳管理
// Bob 处理中时，每 4 秒向微信刷新一次 "对方正在输入" 状态
import { sendTyping } from '@gemini/wechat-bot-core';

interface TypingContext {
  baseUrl: string;
  token: string;
  toUserId: string;
}

/** 启动 sendTyping 心跳，返回停止函数 */
export function startTypingHeartbeat(ctx: TypingContext): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await sendTyping({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
        body: {
          ilink_user_id: ctx.toUserId,
          status: 1, // 1 = typing
        },
      });
    } catch {
      // 静默失败
    }
    if (!stopped) {
      setTimeout(tick, 4_000);
    }
  };

  // 立即发送第一次
  tick();

  return () => {
    stopped = true;
  };
}
