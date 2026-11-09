// session-mgr.ts — 微信用户 wxid ↔ Bob conversation_id 持久化状态机
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_PATH = path.join(__dirname, '..', 'data', 'sessions.json');

export interface ConversationMeta {
  id: string;
  title: string;
  updated_at: number;
}

interface SessionState {
  convId: string | null;
  /** 正常聊天 | 等待用户选择会话序号 */
  state: 'chat' | 'selecting';
  selectingExpiry?: number;
  pendingList?: ConversationMeta[];
}

class SessionManager {
  private sessions: Record<string, SessionState> = {};

  constructor() {
    this.load();
  }

  // ── 持久化 ────────────────────────────────────────────
  private load(): void {
    try {
      if (fs.existsSync(SESSIONS_PATH)) {
        const raw = fs.readFileSync(SESSIONS_PATH, 'utf-8');
        this.sessions = JSON.parse(raw);
        console.log(`[session-mgr] 恢复 ${Object.keys(this.sessions).length} 个会话绑定`);
      }
    } catch {
      this.sessions = {};
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(SESSIONS_PATH);
      fs.mkdirSync(dir, { recursive: true });
      // 保存时去掉 pendingList（体积大且无需持久化），仅保留 convId 和 state
      const toSave: Record<string, Omit<SessionState, 'pendingList'>> = {};
      for (const [wxid, s] of Object.entries(this.sessions)) {
        toSave[wxid] = { convId: s.convId, state: s.state };
      }
      fs.writeFileSync(SESSIONS_PATH, JSON.stringify(toSave, null, 2), 'utf-8');
    } catch (e) {
      console.error('[session-mgr] sessions.json 写入失败:', e);
    }
  }

  // ── 选单模式（/chat 指令触发）────────────────────────
  setSelecting(wxid: string, list: ConversationMeta[]): void {
    this.sessions[wxid] = {
      ...this.sessions[wxid],
      convId: this.sessions[wxid]?.convId ?? null,
      state: 'selecting',
      pendingList: list,
      selectingExpiry: Date.now() + 60_000, // 60 秒 TTL
    };
    this.save();
  }

  isSelecting(wxid: string): boolean {
    const s = this.sessions[wxid];
    if (!s || s.state !== 'selecting') return false;
    if (s.selectingExpiry && Date.now() > s.selectingExpiry) {
      this.cancelSelecting(wxid);
      return false;
    }
    return true;
  }

  getPendingList(wxid: string): ConversationMeta[] | undefined {
    return this.sessions[wxid]?.pendingList;
  }

  cancelSelecting(wxid: string): void {
    if (this.sessions[wxid]) {
      this.sessions[wxid].state = 'chat';
      delete this.sessions[wxid].pendingList;
      delete this.sessions[wxid].selectingExpiry;
      this.save();
    }
  }

  // ── 绑定会话 ─────────────────────────────────────────
  bindSession(wxid: string, convId: string | null): void {
    this.sessions[wxid] = { convId, state: 'chat' };
    this.save();
  }

  getConvId(wxid: string): string | null {
    return this.sessions[wxid]?.convId ?? null;
  }
}

export const sessionMgr = new SessionManager();
