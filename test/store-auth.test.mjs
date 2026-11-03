// ============================================================
//  ArenaAi — KV store, isolation and admin auth tests
//  Author: ArenaAi
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureProfile, getProfile, saveProfile, deleteProfile,
  getMind, saveMind, wipeMind, indexCount, indexList,
  getSettings, saveSettings, getLogs, clearLogs, log,
  rateLimit, bumpStat, getStats, maskKey, safeInt, escapeHtml
} from '../src/store.js';
import {
  hashPassword, verifyPassword, ensureCreds, createSession, getSession,
  requireCsrf, destroySession, adminCookie, readCookie, sameOrigin
} from '../src/auth.js';
import { createEnv } from './helpers.mjs';

test('KV settings merge defaults and preserve unrelated provider defaults', async () => {
  const env = createEnv();
  const initial = await getSettings(env);
  assert.equal(initial.defaultPlatform, 'workersai');
  const changed = await saveSettings(env, { siteTitle: 'عنوان تست', roundsCap: 9 });
  assert.equal(changed.siteTitle, 'عنوان تست');
  assert.equal(changed.roundsCap, 9);
  assert.equal(changed.defaultModel.orcarouter, initial.defaultModel.orcarouter);
});

test('web and Telegram profiles and memories are isolated', async () => {
  const env = createEnv();
  const webId = 'a'.repeat(32);
  const tgId = 987654321;
  const web = await ensureProfile(env, 'web', webId, { name: 'وب' });
  const tg = await ensureProfile(env, 'tg', tgId, { name: 'تلگرام' });
  assert.equal(web.isNew, true);
  assert.equal(tg.isNew, true);
  assert.equal((await getProfile(env, 'web', webId)).name, 'وب');
  assert.equal((await getProfile(env, 'tg', tgId)).name, 'تلگرام');
  assert.equal(await getProfile(env, 'web', tgId), null);

  await saveMind(env, 'web', webId, {
    rounds: [{ q: 'سؤال وب', a: 'پاسخ وب', t: Date.now() }],
    summary: 'خلاصهٔ وب',
    facts: ['فکت وب']
  });
  await saveMind(env, 'tg', tgId, {
    rounds: [{ q: 'سؤال تلگرام', a: 'پاسخ تلگرام', t: Date.now() }],
    summary: 'خلاصهٔ تلگرام',
    facts: ['فکت تلگرام']
  });
  const webMind = await getMind(env, 'web', webId);
  const tgMind = await getMind(env, 'tg', tgId);
  assert.equal(webMind.summary, 'خلاصهٔ وب');
  assert.equal(tgMind.summary, 'خلاصهٔ تلگرام');
  assert.equal(webMind.rounds[0].q, 'سؤال وب');

  assert.equal(await indexCount(env, 'web'), 1);
  assert.equal(await indexCount(env, 'tg'), 1);
  const list = await indexList(env, 'web', 1, 20);
  assert.deepEqual(list.ids, [webId]);

  await wipeMind(env, 'web', webId, 'chat');
  assert.equal((await getMind(env, 'web', webId)).rounds.length, 0);
  assert.equal((await getMind(env, 'web', webId)).summary, 'خلاصهٔ وب');
  await wipeMind(env, 'web', webId, 'memory');
  assert.equal((await getMind(env, 'web', webId)).summary, '');
  assert.deepEqual((await getMind(env, 'web', webId)).facts, []);

  await deleteProfile(env, 'web', webId);
  assert.equal(await getProfile(env, 'web', webId), null);
  assert.equal(await indexCount(env, 'web'), 0);
});

test('admin password hashing supports current and legacy iteration fields', async () => {
  const env = createEnv();
  env.ADMIN_PBKDF2_ITERATIONS = '1000';
  const current = await hashPassword('correct horse battery staple', env);
  assert.equal(current.iter, 1000);
  assert.equal(await verifyPassword('correct horse battery staple', current), true);
  assert.equal(await verifyPassword('wrong', current), false);

  const legacy = { salt: current.salt, iterations: current.iter, hash: current.hash };
  assert.equal(await verifyPassword('correct horse battery staple', legacy), true);
});

test('ensureCreds creates defaults and normalizes a missing epoch', async () => {
  const env = createEnv();
  env.ADMIN_PBKDF2_ITERATIONS = '1000';
  const cred = await ensureCreds(env);
  assert.equal(cred.username, 'admin');
  assert.equal(cred.mustChange, true);
  assert.equal(await verifyPassword('admin', cred), true);

  const env2 = createEnv();
  env2.ADMIN_PBKDF2_ITERATIONS = '1000';
  const h = await hashPassword('legacy-pass', env2);
  await env2.DB.put('creds:admin', JSON.stringify({
    username: 'admin', salt: h.salt, iter: h.iter, hash: h.hash
  }));
  const normalized = await ensureCreds(env2);
  assert.equal(normalized.epoch, 0);
});

test('sessions are CSRF-protected, cookie-based and revoked by epoch bump', async () => {
  const env = createEnv();
  env.ADMIN_PBKDF2_ITERATIONS = '1000';
  const cred = await ensureCreds(env);
  const session = await createSession(env, cred.username, cred.epoch);
  const request = new Request('https://test.technamooz.ai/admin/api/overview', {
    headers: { Cookie: adminCookie(session.token, true) }
  });
  const loaded = await getSession(env, request);
  assert.equal(loaded.u, 'admin');
  assert.equal(await requireCsrf(request, loaded), false);
  const withCsrf = new Request(request.url, {
    headers: {
      Cookie: adminCookie(session.token, true),
      'X-CSRF-Token': session.csrf
    }
  });
  assert.equal(await requireCsrf(withCsrf, loaded), true);
  assert.equal(readCookie(withCsrf, 'tm_admin'), session.token);

  await env.DB.put('creds:admin', JSON.stringify({ ...cred, epoch: cred.epoch + 1 }));
  assert.equal(await getSession(env, withCsrf), null);
  await destroySession(env, withCsrf);
});

test('sameOrigin rejects a different browser origin but allows CLI clients', () => {
  const same = new Request('https://test.technamooz.ai/admin/login', {
    headers: { Origin: 'https://test.technamooz.ai' }
  });
  const evil = new Request('https://test.technamooz.ai/admin/login', {
    headers: { Origin: 'https://evil.example.com' }
  });
  const cli = new Request('https://test.technamooz.ai/admin/login');
  assert.equal(sameOrigin(same), true);
  assert.equal(sameOrigin(evil), false);
  assert.equal(sameOrigin(cli), true);
});

test('rate limiting, logs and daily stats are best-effort but functional', async () => {
  const env = createEnv();
  assert.equal((await rateLimit(env, 'test', 2, 60)).ok, true);
  assert.equal((await rateLimit(env, 'test', 2, 60)).ok, true);
  assert.equal((await rateLimit(env, 'test', 2, 60)).ok, false);

  await log(env, 'test', 'hello');
  await log(env, 'test', 'world');
  assert.equal((await getLogs(env, 10)).length, 2);
  await clearLogs(env);
  assert.equal((await getLogs(env, 10)).length, 0);

  await bumpStat(env, 'web_msgs');
  await bumpStat(env, 'web_msgs');
  const stats = await getStats(env, 2);
  assert.equal(stats.length, 2);
  assert.equal(stats[stats.length - 1].web_msgs, 2);
});

test('small helpers escape HTML and mask secrets without leaking full values', () => {
  assert.equal(maskKey('sk-or-1234567890'), 'sk-or-1…7890');
  assert.equal(maskKey('short'), '••••••');
  assert.equal(maskKey(''), null);
  assert.equal(safeInt('15', 5, 1, 10), 10);
  assert.equal(safeInt('nope', 5, 1, 10), 5);
  assert.equal(escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});
