// config.ts — 桥接层配置（从环境变量 / config.json 读取）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

export interface BridgeConfig {
  weixin: {
    accountId: string;
    baseUrl?: string;
  };
  bob: {
    /** Bob-Agent HTTP API 地址，默认 http://127.0.0.1:3721 */
    baseUrl: string;
  };
}

function loadConfig(): BridgeConfig {
  // 从 JSON 文件读取（可选）
  let fileConfig: Partial<BridgeConfig> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch {
      console.warn('[config] config.json 解析失败，使用默认值');
    }
  }

  // A QR login writes the real account id here, so it survives restarts even if config.json has a placeholder.
  let savedAccountId = '';
  try {
    const saved = path.join(__dirname, '..', 'data', 'account.txt');
    if (fs.existsSync(saved)) savedAccountId = fs.readFileSync(saved, 'utf-8').trim();
  } catch { /* no saved account yet */ }

  return {
    weixin: {
      accountId: process.env.WECHAT_ACCOUNT_ID || savedAccountId || fileConfig.weixin?.accountId || '',
      baseUrl: process.env.WECHAT_BASE_URL || fileConfig.weixin?.baseUrl,
    },
    bob: {
      baseUrl: process.env.BOB_API_URL || fileConfig.bob?.baseUrl || 'http://127.0.0.1:3721',
    },
  };
}

export const config = loadConfig();
