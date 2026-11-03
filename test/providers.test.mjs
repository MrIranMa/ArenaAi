// ============================================================
//  ArenaAi — provider, persona and SSE tests
//  Author: ArenaAi
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProviderSse, validateBaseUrl, providerStatus, listModels
} from '../src/providers.js';
import { DEFAULT_SETTINGS, PLATFORM_ORDER, LIMITS } from '../src/config.js';
import { PERSONAS, PERSONA_ORDER, buildSystemPrompt } from '../src/personas.js';
import { resolveSelection, buildMessages, tokensFor } from '../src/chat.js';
import { setProviderKey, setCfAccount, saveSettings } from '../src/store.js';
import { createEnv, createFetchMock } from './helpers.mjs';

const enc = new TextEncoder();
const THINK_OPEN = '\x3Cthink\x3E';
const THINK_CLOSE = '\x3C/think\x3E';

function streamOf(pieces, { sse = true } = {}) {
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) {
        controller.enqueue(enc.encode(sse ? 'data: ' + piece + '\n\n' : piece));
      }
      controller.close();
    }
  });
}

async function collectFrames(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) frames.push(JSON.parse(line));
    }
  }
  if (buffer.trim()) frames.push(JSON.parse(buffer.trim()));
  return frames;
}

test('all 16 personas work with all four platforms and recommend valid model ids', () => {
  assert.equal(PERSONA_ORDER.length, 16);
  for (const id of PERSONA_ORDER) {
    const persona = PERSONAS[id];
    assert.ok(persona, 'missing persona ' + id);
    assert.ok(persona.name && persona.emoji && persona.system);
    for (const platform of PLATFORM_ORDER) {
      assert.equal(typeof persona.recommended[platform], 'string');
      assert.ok(persona.recommended[platform].length > 2);
    }
    const prompt = buildSystemPrompt(persona, '', { deep: true });
    assert.match(prompt, /تکناموز/);
    assert.match(prompt, /نهایت قدرت/);
  }
});

test('selection falls back safely and clamps output budgets', () => {
  const selection = resolveSelection({
    platform: 'not-a-platform',
    persona: 'not-a-persona',
    model: '  openrouter/free  ',
    deep: true
  }, DEFAULT_SETTINGS);
  assert.equal(selection.platform, 'workersai');
  assert.equal(selection.personaId, 'general');
  assert.equal(selection.model, 'openrouter/free');
  assert.equal(selection.deep, true);
  assert.equal(selection.maxTokens, Math.min(DEFAULT_SETTINGS.maxTokensDeep, LIMITS.deepTokensLimit));
  assert.equal(tokensFor({ maxTokensNormal: 1, maxTokensDeep: 999999 }, false), 512);
  assert.equal(tokensFor({ maxTokensNormal: 1, maxTokensDeep: 999999 }, true), LIMITS.deepTokensLimit);
});

test('buildMessages keeps the newest turns and respects the context budget', () => {
  const rounds = [];
  for (let i = 0; i < 60; i++) {
    rounds.push({ q: 'سؤال ' + i, a: 'پاسخ ' + i + ' '.repeat(2000) });
  }
  const messages = buildMessages({
    persona: PERSONAS.general,
    mind: { rounds, summary: 'خلاصهٔ حافظه', facts: ['نام کاربر تست'] },
    userText: 'آخرین سؤال',
    settings: { ...DEFAULT_SETTINGS, extraInstructions: '' },
    deep: false
  });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /خلاصهٔ حافظه/);
  assert.match(messages[0].content, /نام کاربر تست/);
  assert.equal(messages[messages.length - 1].content, 'آخرین سؤال');
  assert.ok(messages.length >= 5);
  assert.ok(messages.length <= 40);
  assert.match(messages[messages.length - 2].content, /پاسخ 59/);
});

test('validateBaseUrl only accepts approved OneRouter HTTPS hosts', () => {
  for (const value of [
    'https://llm.onerouter.pro/v1',
    'https://onerouter.ai/v1/',
    'https://api.onerouter.com/v1',
    'https://infron.ai/api/v1'
  ]) {
    assert.equal(validateBaseUrl(value).ok, true, value);
  }
  for (const value of [
    'http://llm.onerouter.pro/v1',
    'https://evil.example.com/v1',
    'https://onerouter.pro.evil.com/v1',
    'not a url',
    ''
  ]) {
    assert.equal(validateBaseUrl(value).ok, false, value);
  }
});

test('providerStatus hides key masks from public callers and exposes them to admin callers', async () => {
  const env = createEnv();
  await setProviderKey(env, 'openrouter', 'sk-or-test-secret-1234567890');
  await setCfAccount(env, 'a'.repeat(32), 'cloudflare-test-token-1234567890');
  const publicStatus = await providerStatus(env);
  const adminStatus = await providerStatus(env, { includeMask: true });
  assert.equal(publicStatus.openrouter.ready, true);
  assert.equal(publicStatus.openrouter.keyMask, null);
  assert.equal(publicStatus.workersai.keyMask, null);
  assert.match(adminStatus.openrouter.keyMask, /^sk-or-t…/);
  assert.match(adminStatus.workersai.keyMask, /^cloudfl…/);
});

test('curated Workers AI and OneRouter lists are available without network keys', async () => {
  const env = createEnv();
  const workers = await listModels(env, 'workersai');
  assert.ok(workers.length >= 4);
  assert.ok(workers.some((m) => m.id === '@cf/meta/llama-3.3-70b-instruct-fp8-fast'));
  const one = await listModels(env, 'onerouter');
  assert.ok(one.length >= 10);
  assert.ok(one.some((m) => m.id === 'deepseek/deepseek-v4.1-flash:free'));
});

test('live OpenRouter and OrcaRouter model adapters normalize free/paid metadata', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = createFetchMock();
  try {
    const env = createEnv();
    const openrouter = await listModels(env, 'openrouter');
    assert.equal(openrouter.length, 2);
    assert.equal(openrouter[0].id, 'openrouter/free');
    assert.equal(openrouter[0].free, true);
    assert.equal(openrouter[0].platform, 'openrouter');
    const orca = await listModels(env, 'orcarouter');
    assert.equal(orca[0].id, 'orcarouter/free');
    assert.equal(orca[0].free, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('SSE parser handles split UTF-8, split think tags, CF reasoning and keep-alives', async () => {
  const pieces = [
    '{"choices":[{"delta":{"content":"سلام"}}]}',
    '{"choices":[{"delta":{"content":"' + THINK_OPEN.slice(0, 4) + '"}}]}',
    '{"choices":[{"delta":{"content":"' + THINK_OPEN.slice(4) + '"}}]}',
    '{"choices":[{"delta":{"content":"تحلیل"}}]}',
    '{"choices":[{"delta":{"content":"' + THINK_CLOSE.slice(0, 5) + '"}}]}',
    '{"choices":[{"delta":{"content":"' + THINK_CLOSE.slice(5) + '"}}]}',
    '{"choices":[{"delta":{"content":"پاسخ"}}]}',
    '[DONE]'
  ];
  const frames = await collectFrames(parseProviderSse(streamOf(pieces)));
  assert.equal(frames[0].type, 'delta');
  assert.ok(frames.some((f) => f.type === 'reasoning' && f.v === 'تحلیل'));
  assert.equal(frames.filter((f) => f.type === 'delta').map((f) => f.v).join(''), 'سلامپاسخ');

  const cfFrames = await collectFrames(parseProviderSse(streamOf([
    '{"reasoning":"فکر"}',
    '{"response":"' + THINK_OPEN + 'داخل' + THINK_CLOSE + 'نتیجه"}',
    '[DONE]'
  ])));
  assert.equal(cfFrames[0].type, 'reasoning');
  assert.equal(cfFrames[cfFrames.length - 1].v, 'نتیجه');

  const keepAlive = await collectFrames(parseProviderSse(streamOf([
    ': OPENROUTER PROCESSING',
    '{"choices":[{"delta":{}}]}',
    '{"choices":[{"delta":{"content":"ok"}}]}',
    '[DONE]'
  ])));
  assert.equal(keepAlive.length, 1);
  assert.equal(keepAlive[0].v, 'ok');
});

test('SSE parser emits a normalized error frame for a mid-stream provider error', async () => {
  const frames = await collectFrames(parseProviderSse(streamOf([
    '{"error":{"message":"quota exhausted"}}',
    '[DONE]'
  ])));
  assert.equal(frames[0].type, 'error');
  assert.match(frames[0].msg, /quota/);
});

test('saving settings keeps provider defaults and validates unknown personas elsewhere', async () => {
  const env = createEnv();
  const next = await saveSettings(env, { maintenance: true, roundsCap: 12 });
  assert.equal(next.maintenance, true);
  assert.equal(next.roundsCap, 12);
  assert.equal(next.defaultModel.openrouter, DEFAULT_SETTINGS.defaultModel.openrouter);
});
