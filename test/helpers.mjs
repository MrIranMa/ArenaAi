// ============================================================
//  Technamooz AI — test helpers (no Cloudflare account required)
//  Author: Amir Parsa (امیر پارسا)
// ============================================================

import { webcrypto } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PUBLIC = join(ROOT, 'public');

export class MockKV {
  constructor() {
    this.map = new Map();
    this.puts = 0;
  }

  async get(key, type = 'text') {
    const value = this.map.get(key);
    if (value === undefined) return null;
    if (type === 'json') {
      try { return JSON.parse(value); } catch { return null; }
    }
    return value;
  }

  async put(key, value, _options = {}) {
    this.puts += 1;
    this.map.set(key, String(value));
  }

  async delete(key) {
    this.map.delete(key);
  }

  keys() {
    return [...this.map.keys()];
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

export function createAssets() {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const requested = url.pathname === '/' ? '/index.html' : url.pathname;
      const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
      const file = join(PUBLIC, safe);
      if (!file.startsWith(PUBLIC) || !existsSync(file)) {
        return new Response('not found', { status: 404 });
      }
      return new Response(readFileSync(file), {
        status: 200,
        headers: { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }
      });
    }
  };
}

export class MockD1 {
  constructor() { this.users = new Map(); this.sessions = new Map(); }
  prepare(sql) {
    const database = this;
    return {
      bind(...values) {
        return {
          async first() {
            if (sql.includes('JOIN users')) {
              const [tokenHash, now] = values;
              const session = database.sessions.get(tokenHash);
              if (!session || session.expires_at <= now) return null;
              const user = database.users.get(session.user_id);
              return user ? { id: user.id, email: user.email, uid: user.uid, created_at: user.created_at } : null;
            }
            if (sql.includes('FROM users WHERE email')) {
              return [...database.users.values()].find((u) => u.email.toLowerCase() === String(values[0]).toLowerCase()) || null;
            }
            return null;
          },
          async run() {
            if (sql.includes('INSERT INTO users')) {
              const [id, email, password_salt, password_hash, uid, created_at] = values;
              if ([...database.users.values()].some((u) => u.email.toLowerCase() === String(email).toLowerCase())) {
                throw new Error('UNIQUE constraint failed: users.email');
              }
              database.users.set(id, { id, email, password_salt, password_hash, uid, created_at });
              return { success: true };
            }
            if (sql.includes('INSERT INTO sessions')) {
              const [token_hash, user_id, created_at, expires_at] = values;
              database.sessions.set(token_hash, { token_hash, user_id, created_at, expires_at });
              return { success: true };
            }
            if (sql.includes('DELETE FROM sessions WHERE token_hash')) {
              database.sessions.delete(values[0]);
              return { success: true };
            }
            if (sql.includes('DELETE FROM sessions WHERE expires_at')) {
              for (const [key, row] of database.sessions) if (row.expires_at <= values[0]) database.sessions.delete(key);
              return { success: true };
            }
            return { success: true };
          }
        };
      }
    };
  }
}

export class MockAI {
  constructor() {
    this.calls = [];
    this.chunks = ['سلام ', 'از Workers AI'];
    this.utilityText = 'خلاصهٔ آزمایشی';
  }

  async run(model, input) {
    this.calls.push({ model, input });
    if (!input || input.stream !== true) return { response: this.utilityText };
    const chunks = this.chunks;
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ response: chunk }) + '\n\n'));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    });
  }
}

export function createEnv({ withAI = true } = {}) {
  const env = {
    DB: new MockKV(),
    AUTH_DB: new MockD1(),
    ASSETS: createAssets(),
    APP_VERSION: '1.0.0',
    APP_NAME: 'Technamooz AI'
  };
  if (withAI) env.AI = new MockAI();
  return env;
}

export function createFetchMock() {
  const calls = [];
  const fn = async (url, options = {}) => {
    const href = String(url);
    calls.push({ url: href, options });

    if (href.includes('api.telegram.org')) {
      if (href.includes('/getMe')) {
        return json({ ok: true, result: { id: 123456789, is_bot: true, username: 'technamooz_test' } });
      }
      if (href.includes('/setMyCommands')) return json({ ok: true, result: true });
      if (href.includes('/setWebhook')) return json({ ok: true, result: true });
      if (href.includes('/deleteWebhook')) return json({ ok: true, result: true });
      if (href.includes('/getWebhookInfo')) {
        return json({ ok: true, result: { url: '', has_custom_certificate: false, pending_update_count: 0 } });
      }
      if (href.includes('/sendMessage')) return json({ ok: true, result: { message_id: 1 } });
      if (href.includes('/editMessageText')) return json({ ok: true, result: { message_id: 1 } });
      if (href.includes('/answerCallbackQuery')) return json({ ok: true, result: true });
      if (href.includes('/sendChatAction')) return json({ ok: true, result: true });
      return json({ ok: false, description: 'unhandled telegram method' });
    }

    if (href.includes('openrouter.ai/api/v1/key')) {
      return json({ data: { usage: 0, limit: null, is_free_tier: true } });
    }
    if (href.includes('openrouter.ai/api/v1/models')) {
      return json({
        data: [
          {
            id: 'openrouter/free',
            name: 'OpenRouter Free',
            description: 'Free test model',
            context_length: 8192,
            pricing: { prompt: '0', completion: '0' },
            architecture: { input_modalities: ['text'] },
            supported_parameters: []
          },
          {
            id: 'meta/llama-test',
            name: 'Llama Test',
            description: 'Paid test model',
            context_length: 32768,
            pricing: { prompt: '0.000001', completion: '0.000002' },
            architecture: { input_modalities: ['text'] },
            supported_parameters: ['reasoning']
          }
        ]
      });
    }
    if (href.includes('orcarouter.ai')) {
      return json({
        data: [
          {
            id: 'orcarouter/free',
            name: 'Orca Free',
            description: 'Orca free test model',
            context_length: 8192,
            pricing: { prompt: '0', completion: '0' },
            architecture: { input_modalities: ['text'] },
            supported_parameters: []
          }
        ]
      });
    }
    if (href.includes('onerouter')) {
      return json({
        data: [
          {
            id: 'deepseek/deepseek-v4.1-flash:free',
            name: 'OneRouter Free',
            description: 'OneRouter free test model',
            context_length: 8192,
            pricing: { prompt: '0', completion: '0' },
            architecture: { input_modalities: ['text'] },
            supported_parameters: []
          }
        ]
      });
    }

    throw new Error('Unexpected fetch in test: ' + href);
  };
  fn.calls = calls;
  return fn;
}

function json(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function callWorker(worker, env, path, options = {}) {
  const request = new Request('https://test.technamooz.ai' + path, options);
  const response = await worker.fetch(request, env, {
    waitUntil() {},
    passThroughOnException() {}
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* SSE or HTML */ }
  return { response, text, data };
}

export function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

export function jsonHeaders(cookie, csrf) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  return headers;
}
