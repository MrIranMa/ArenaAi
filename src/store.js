// ============================================================
//  ArenaAi — ArenaAi-v1.0.0
//  Author: ArenaAi
//  src/store.js — Cloudflare KV storage layer
//  (settings, keys, users, isolated memory, logs, rate limits, stats)
// ============================================================

import { KV_KEYS, DEFAULT_SETTINGS, PLATFORMS } from './config.js';

/* ============================ primitives ============================ */

export function hasDB(env) {
  return !!(env && env.DB && typeof env.DB.get === 'function' && typeof env.DB.put === 'function');
}

async function kvGet(env, key, type = 'json') {
  try {
    if (!hasDB(env)) return null;
    return await env.DB.get(key, type);
  } catch {
    return null;
  }
}

async function kvPut(env, key, value, options) {
  if (!hasDB(env)) throw new Error('KV binding DB is missing');
  await env.DB.put(key, value, options);
}

async function kvDelete(env, key) {
  try {
    if (hasDB(env)) await env.DB.delete(key);
  } catch { /* ignore */ }
}

/* ============================ settings ============================ */

export async function getSettings(env) {
  const custom = (await kvGet(env, KV_KEYS.settings, 'json')) || {};
  return {
    ...DEFAULT_SETTINGS,
    ...custom,
    defaultModel: {
      ...DEFAULT_SETTINGS.defaultModel,
      ...(custom.defaultModel && typeof custom.defaultModel === 'object' ? custom.defaultModel : {})
    }
  };
}

export async function saveSettings(env, patch) {
  const current = await getSettings(env);
  const next = {
    ...current,
    ...patch,
    defaultModel: {
      ...current.defaultModel,
      ...(patch && patch.defaultModel && typeof patch.defaultModel === 'object' ? patch.defaultModel : {})
    }
  };
  await kvPut(env, KV_KEYS.settings, JSON.stringify(next));
  return next;
}

/* ============================ admin credentials ============================ */

export async function getCreds(env) {
  return (await kvGet(env, KV_KEYS.creds, 'json')) || null;
}

export async function setCreds(env, creds) {
  await kvPut(env, KV_KEYS.creds, JSON.stringify(creds));
}

/* ============================ provider credentials ============================ */

export async function getProviderCredentials(env, platform) {
  const p = PLATFORMS[platform];
  if (!p) return { key: null, baseUrl: null };
  if (platform === 'workersai') return { key: null, baseUrl: null };
  const rec = (await kvGet(env, KV_KEYS.providerKey(platform), 'json')) || null;
  return {
    key: rec && rec.key ? String(rec.key) : null,
    baseUrl: (rec && rec.baseUrl) || p.baseUrl || null,
    updatedAt: (rec && rec.updatedAt) || 0
  };
}

export async function getProviderKey(env, platform) {
  const c = await getProviderCredentials(env, platform);
  return c.key;
}

export async function setProviderKey(env, platform, key, baseUrl) {
  const p = PLATFORMS[platform];
  if (!p) throw new Error('unknown platform');
  const record = {
    key: key ? String(key).trim() : null,
    baseUrl: baseUrl ? String(baseUrl).trim().replace(/\/+$/, '') : (p.baseUrl || null),
    updatedAt: Date.now()
  };
  await kvPut(env, KV_KEYS.providerKey(platform), JSON.stringify(record));
  return record;
}

export async function getCfAccount(env) {
  const rec = (await kvGet(env, KV_KEYS.cfAccount, 'json')) || null;
  if (!rec || !rec.accountId) return null;
  return {
    accountId: String(rec.accountId),
    token: rec.token ? String(rec.token) : null,
    updatedAt: rec.updatedAt || 0
  };
}

export async function setCfAccount(env, accountId, token) {
  const rec = {
    accountId: String(accountId || '').trim(),
    token: token ? String(token).trim() : null,
    updatedAt: Date.now()
  };
  await kvPut(env, KV_KEYS.cfAccount, JSON.stringify(rec));
  return rec;
}

/* ============================ telegram ============================ */

const TG_DEFAULT = {
  token: null,
  username: null,
  secret: null,
  webUrl: null,
  commandsSet: false,
  updatedAt: 0
};

export async function getTgBot(env) {
  return { ...TG_DEFAULT, ...((await kvGet(env, KV_KEYS.tgBot, 'json')) || {}) };
}

export async function saveTgBot(env, patch) {
  const current = await getTgBot(env);
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await kvPut(env, KV_KEYS.tgBot, JSON.stringify(next));
  return next;
}

export async function getTgAdmins(env) {
  const ids = (await kvGet(env, KV_KEYS.tgAdmins, 'json')) || [];
  return Array.isArray(ids) ? [...new Set(ids.map(Number).filter((n) => Number.isFinite(n) && n !== 0))] : [];
}

export async function saveTgAdmins(env, ids) {
  const clean = [...new Set((ids || []).map(Number).filter((n) => Number.isFinite(n) && n !== 0))];
  await kvPut(env, KV_KEYS.tgAdmins, JSON.stringify(clean));
  return clean;
}

/* ============================ user profiles ============================ */

export function newUid() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function profileKey(source, id) {
  return 'profile:' + source + ':' + id;
}

function legacyProfileKey(id) {
  return 'upref:' + id;
}

export async function getProfile(env, source, id) {
  if (!id) return null;
  const fresh = await kvGet(env, profileKey(source, id), 'json');
  if (fresh) return fresh;

  // Backward compatibility with the first release.
  const legacy = await kvGet(env, legacyProfileKey(id), 'json');
  if (legacy) {
    const migrated = { ...legacy, source: legacy.source || source };
    try {
      await saveProfile(env, source, id, migrated);
      await kvDelete(env, legacyProfileKey(id));
    } catch { /* ignore */ }
    return migrated;
  }
  return null;
}

export async function saveProfile(env, source, id, profile) {
  await kvPut(env, profileKey(source, id), JSON.stringify(profile));
  return profile;
}

/**
 * Create the profile on first contact and update lastSeen otherwise.
 * Returns { profile, isNew }.
 */
export async function ensureProfile(env, source, id, patch = {}) {
  const existing = await getProfile(env, source, id);
  if (existing) {
    existing.lastSeen = Date.now();
    Object.assign(existing, patch);
    await saveProfile(env, source, id, existing);
    return { profile: existing, isNew: false };
  }

  const profile = {
    source,
    id,
    createdAt: Date.now(),
    lastSeen: Date.now(),
    msgs: 0,
    banned: false,
    ...patch
  };
  await saveProfile(env, source, id, profile);
  await indexPush(env, source, id);
  return { profile, isNew: true };
}

export async function deleteProfile(env, source, id) {
  await kvDelete(env, profileKey(source, id));
  await kvDelete(env, legacyProfileKey(id));
  await indexRemove(env, source, id);
}

/* ============================ isolated memory ============================ */

const MIND_DEFAULT = { v: 1, rounds: [], summary: '', facts: [], updatedAt: 0 };

function mindKey(source, id) {
  return 'mind:' + source + ':' + id;
}

export async function getMind(env, source, id) {
  const raw = (await kvGet(env, mindKey(source, id), 'json')) || null;
  if (!raw) return { ...MIND_DEFAULT, rounds: [], facts: [] };
  return {
    ...MIND_DEFAULT,
    ...raw,
    rounds: Array.isArray(raw.rounds) ? raw.rounds : [],
    facts: Array.isArray(raw.facts) ? raw.facts : [],
    summary: typeof raw.summary === 'string' ? raw.summary : ''
  };
}

export async function saveMind(env, source, id, mind) {
  mind.updatedAt = Date.now();
  await kvPut(env, mindKey(source, id), JSON.stringify(mind));
  return mind;
}

/**
 * mode:
 *  - chat   → only the visible conversation is cleared
 *  - memory → long-term summary + facts are cleared (last few turns kept)
 *  - all    → the whole mind is deleted
 * The user profile/preferences are intentionally kept.
 */
export async function wipeMind(env, source, id, mode = 'all') {
  if (mode === 'all') {
    await kvDelete(env, mindKey(source, id));
    return { ok: true, mode };
  }
  const mind = await getMind(env, source, id);
  if (mode === 'chat') mind.rounds = [];
  if (mode === 'memory') {
    mind.summary = '';
    mind.facts = [];
    mind.rounds = mind.rounds.slice(-4);
  }
  await saveMind(env, source, id, mind);
  return { ok: true, mode };
}

/* ============================ user index ============================ */

const CHUNK = 200;

function indexCountKey(source) { return 'uindex:' + source + ':count'; }
function indexNKey(source) { return 'uindex:' + source + ':n'; }
function indexChunkKey(source, i) { return 'uindex:' + source + ':' + i; }

export async function indexPush(env, source, id) {
  // Read the count BEFORE appending. indexCount() may rebuild a legacy
  // index by scanning chunks, so calling it after the append would count
  // the new id twice.
  const countBefore = await indexCount(env, source);
  const n = Number((await kvGet(env, indexNKey(source), 'json')) || 0);
  let last = n - 1;
  if (last < 0) {
    await kvPut(env, indexChunkKey(source, 0), JSON.stringify([id]));
    await kvPut(env, indexNKey(source), '1');
    await kvPut(env, indexCountKey(source), String(countBefore + 1));
    return;
  }

  const key = indexChunkKey(source, last);
  const arr = (await kvGet(env, key, 'json')) || [];
  if (arr.includes(id)) return;
  if (arr.length >= CHUNK) {
    await kvPut(env, indexChunkKey(source, last + 1), JSON.stringify([id]));
    await kvPut(env, indexNKey(source), String(last + 2));
  } else {
    arr.push(id);
    await kvPut(env, key, JSON.stringify(arr));
  }
  await kvPut(env, indexCountKey(source), String(countBefore + 1));
}

export async function indexCount(env, source) {
  const stored = Number((await kvGet(env, indexCountKey(source), 'json')) || 0);
  if (stored > 0) return stored;
  // Legacy indexes did not store a count.
  const n = Number((await kvGet(env, indexNKey(source), 'json')) || 0);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const arr = (await kvGet(env, indexChunkKey(source, i), 'json')) || [];
    total += Array.isArray(arr) ? arr.length : 0;
  }
  if (total > 0) await kvPut(env, indexCountKey(source), String(total));
  return total;
}

export async function indexList(env, source, page = 1, pageSize = 50) {
  const total = await indexCount(env, source);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(1, Math.min(pages, Number(page) || 1));
  const start = (safePage - 1) * pageSize;
  const end = Math.min(total, start + pageSize);
  const ids = [];
  if (total === 0) return { ids, page: 1, pages: 1, total: 0, pageSize };

  let chunk = Math.floor(start / CHUNK);
  let offset = start % CHUNK;
  while (ids.length < end - start) {
    const arr = (await kvGet(env, indexChunkKey(source, chunk), 'json')) || [];
    if (!Array.isArray(arr) || !arr.length) break;
    for (let i = offset; i < arr.length && ids.length < end - start; i++) ids.push(arr[i]);
    chunk += 1;
    offset = 0;
  }
  return { ids, page: safePage, pages, total, pageSize };
}

export async function indexRemove(env, source, id) {
  const countBefore = await indexCount(env, source);
  const n = Number((await kvGet(env, indexNKey(source), 'json')) || 0);
  for (let i = 0; i < n; i++) {
    const key = indexChunkKey(source, i);
    const arr = (await kvGet(env, key, 'json')) || [];
    const idx = Array.isArray(arr) ? arr.indexOf(id) : -1;
    if (idx >= 0) {
      arr.splice(idx, 1);
      await kvPut(env, key, JSON.stringify(arr));
      await kvPut(env, indexCountKey(source), String(Math.max(0, countBefore - 1)));
      return true;
    }
  }
  return false;
}

/* ============================ logs ============================ */

const LOG_CAP = 200;

export async function log(env, type, msg) {
  try {
    if (!hasDB(env)) return;
    const arr = (await kvGet(env, KV_KEYS.logs, 'json')) || [];
    arr.unshift({
      t: Date.now(),
      type: String(type || 'info').slice(0, 24),
      msg: String(msg == null ? '' : msg).slice(0, 600)
    });
    while (arr.length > LOG_CAP) arr.pop();
    await kvPut(env, KV_KEYS.logs, JSON.stringify(arr));
  } catch { /* logging must never break a request */ }
}

export async function getLogs(env, limit = 100) {
  const arr = (await kvGet(env, KV_KEYS.logs, 'json')) || [];
  return arr.slice(0, Math.max(1, Math.min(LOG_CAP, limit)));
}

export async function clearLogs(env) {
  await kvPut(env, KV_KEYS.logs, JSON.stringify([]));
}

/* ============================ rate limit ============================ */

export async function rateLimit(env, bucket, limit, windowSec) {
  const key = 'rl:' + String(bucket).slice(0, 120);
  const now = Date.now();
  let rec = await kvGet(env, key, 'json');
  if (!rec || typeof rec !== 'object' || !rec.ts || now - rec.ts >= windowSec * 1000) {
    rec = { n: 1, ts: now };
    try {
      await kvPut(env, key, JSON.stringify(rec), { expirationTtl: Math.max(60, windowSec) });
    } catch { /* if KV is unavailable, fail open */ }
    return { ok: true, remaining: limit - 1, resetAt: now + windowSec * 1000 };
  }
  if (rec.n >= limit) {
    return { ok: false, remaining: 0, resetAt: rec.ts + windowSec * 1000 };
  }
  rec.n += 1;
  try {
    await kvPut(env, key, JSON.stringify(rec), { expirationTtl: Math.max(60, windowSec) });
  } catch { /* ignore */ }
  return { ok: true, remaining: limit - rec.n, resetAt: rec.ts + windowSec * 1000 };
}

/* ============================ stats ============================ */

export async function bumpStat(env, field, amount = 1) {
  try {
    if (!hasDB(env)) return;
    const safe = String(field).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32) || 'events';
    const day = new Date().toISOString().slice(0, 10);
    const key = 'stats:' + day;
    const stats = (await kvGet(env, key, 'json')) || {};
    stats[safe] = (Number(stats[safe]) || 0) + amount;
    await kvPut(env, key, JSON.stringify(stats));
  } catch { /* stats are best-effort */ }
}

export async function getStats(env, days = 7) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const stats = (await kvGet(env, 'stats:' + date, 'json')) || {};
    out.push({ date, ...stats });
  }
  return out;
}

/* ============================ helpers ============================ */

export function jsonResp(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

export function htmlResp(html, status = 200, headers = {}) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

export function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function maskKey(key) {
  if (!key) return null;
  const s = String(key);
  if (s.length <= 10) return '••••••';
  return s.slice(0, 7) + '…' + s.slice(-4);
}

export function safeInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
