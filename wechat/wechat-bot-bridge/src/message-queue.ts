// message-queue.ts — 按 wxid 串行化请求，防止同一用户并发乱序
export class MessageQueue {
  private queues: Record<string, Promise<void>> = {};

  /**
   * 将 task 加入指定 wxid 的串行队列。
   * 前一个任务完成后才会开始执行当前任务（无论成功/失败）。
   */
  enqueue(wxid: string, task: () => Promise<void>): Promise<void> {
    const prev = this.queues[wxid] ?? Promise.resolve();
    const next = prev.then(task).catch((err) => {
      console.error(`[msg-queue] wxid=${wxid} task error:`, err);
    });
    this.queues[wxid] = next;
    return next;
  }
}

export const msgQueue = new MessageQueue();
