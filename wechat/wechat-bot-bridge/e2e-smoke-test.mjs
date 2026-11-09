#!/usr/bin/env node
// e2e-smoke-test.mjs — 端到端冒烟测试（Bob HTTP API）
// 用法: node e2e-smoke-test.mjs
//
// 前置条件：bob-agent 已启动（或 `cargo tauri dev`）
//
// 测试内容：
//   1. GET /v1/health   — 健康检查
//   2. GET /v1/conversations — 会话列表
//   3. POST /v1/chat    — SSE 流式对话

const BASE_URL = 'http://127.0.0.1:3721';

async function testHealth() {
  console.log('\n[1/3] 健康检查 GET /v1/health');
  const res = await fetch(`${BASE_URL}/v1/health`);
  const data = await res.json();
  console.log('  ✅ 状态码:', res.status, '| 响应:', JSON.stringify(data));
  if (data.status !== 'ok') throw new Error('健康检查失败');
}

async function testConversations() {
  console.log('\n[2/3] 会话列表 GET /v1/conversations');
  const res = await fetch(`${BASE_URL}/v1/conversations`);
  const data = await res.json();
  console.log('  ✅ 状态码:', res.status, '| 会话数量:', Array.isArray(data) ? data.length : '未知');
  if (!res.ok) throw new Error('会话列表请求失败');
}

async function testChat() {
  console.log('\n[3/3] SSE 对话 POST /v1/chat');
  const body = {
    message: '你好，请用一句话介绍自己。',
    conversation_id: null,
    from_channel: 'test',
  };

  const res = await fetch(`${BASE_URL}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) throw new Error(`POST /v1/chat 失败: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let conversationId = '';
  let fullText = '';
  let chunkCount = 0;

  console.log('  📡 开始接收 SSE 流...');
  let timeout = setTimeout(() => {
    console.error('  ❌ 超时（30 秒内未收到 done 事件）');
    process.exit(1);
  }, 30000);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (trimmed.startsWith('data: ')) {
        try {
          const payload = JSON.parse(trimmed.slice(6));
          if (payload.content) {
            process.stdout.write(payload.content);
            fullText += payload.content;
            chunkCount++;
          }
          if (payload.conversation_id) conversationId = payload.conversation_id;
          if (payload.full_text) {
            fullText = payload.full_text;
            clearTimeout(timeout);
            console.log('\n  ✅ done 事件收到 | conv_id:', conversationId, '| chunks:', chunkCount);
          }
        } catch { /* ignore */ }
      }
    }
  }

  if (!fullText) throw new Error('未收到任何回复内容');
  console.log('\n  📝 完整回复长度:', fullText.length, '字符');
}

// ── 主流程 ─────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║   Bob-Agent E2E Smoke Test             ║');
  console.log('╚═══════════════════════════════════════╝');

  try {
    await testHealth();
    await testConversations();
    await testChat();
    console.log('\n✅✅✅ 所有测试通过！端到端管道验证成功。\n');
  } catch (err) {
    console.error('\n❌ 测试失败:', err.message);
    process.exit(1);
  }
}

main();
