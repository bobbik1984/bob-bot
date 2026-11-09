export { monitorWeixinProvider as startMonitor } from './monitor/monitor.js';
export type { MonitorWeixinOpts as MonitorOpts, OnMessageCallback } from './monitor/monitor.js';
export { startWeixinLoginWithQr as startLoginWithQr, waitForWeixinLogin as waitForLogin } from './auth/login-qr.js';
export { sendMessageWeixin, sendImageMessageWeixin, sendVideoMessageWeixin, sendFileMessageWeixin } from './messaging/send.js';
export { sendTyping } from './api/api.js';
export type { WeixinMessage, MessageItem } from './api/types.js';
export { resolveWeixinAccount, loadWeixinAccount, normalizeAccountId, saveWeixinAccount, registerWeixinAccountId, listIndexedWeixinAccountIds } from './auth/accounts.js';
export type { WeixinAccountData, ResolvedWeixinAccount } from './auth/accounts.js';
