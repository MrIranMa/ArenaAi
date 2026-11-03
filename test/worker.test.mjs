// ============================================================
//  Technamooz AI — Worker route integration test
//  Uses mock KV, ASSETS, Workers AI and Telegram/OpenRouter fetch.
//  Author: Amir Parsa (امیر پارسا)
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEnv, createFetchMock, callWorker, cookieFrom, jsonHeaders
} from './helpers.mjs';

const { default: worker } = await import('../src/index.js');

test('Worker public chat, admin panel and Telegram flows', async () => {
  const env = createEnv();
  env.ADMIN_PBKDF2_ITERATIONS = '1000';
  const originalFetch = globalThis.fetch;
  const fetchMock = createFetchMock();
  globalThis.fetch = fetchMock;

  try {
    /* ---------------- static pages and security headers ---------------- */
    const home = await callWorker(worker, env, '/');
    assert.equal(home.response.status, 200);
    assert.match(home.text, /آرنا ای‌آی/);
    assert.match(home.response.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.equal(home.response.headers.get('x-frame-options'), 'DENY');
    assert.equal(home.text.includes('href="/admin"'), false, 'public page must not link to admin');

    const head = await callWorker(worker, env, '/', { method: 'HEAD' });
    assert.equal(head.response.status, 200);
    assert.equal(head.text, '');

    const adminPage = await callWorker(worker, env, '/admin');
    assert.equal(adminPage.response.status, 200);
    assert.match(adminPage.text, /پنل مدیریت/);
    assert.match(adminPage.response.headers.get('x-robots-tag') || '', /noindex/);
    assert.match(adminPage.response.headers.get('cache-control') || '', /no-store/);

    const favicon = await callWorker(worker, env, '/favicon.ico');
    assert.equal(favicon.response.status, 200);
    assert.equal(favicon.response.headers.get('content-type'), 'image/png');

    const notFound = await callWorker(worker, env, '/does-not-exist');
    assert.equal(notFound.response.status, 404);
    assert.match(notFound.text, /۴۰۴/);

    /* ---------------- public config, personas and model lists ---------------- */
    const health = await callWorker(worker, env, '/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.data.ok, true);
    assert.equal(health.data.kv, true);
    assert.equal(health.data.providers.workersai.ready, true);

    const config = await callWorker(worker, env, '/api/config');
    assert.equal(config.data.ok, true);
    assert.equal(config.data.app.package, 'technamooz-ai-version1.0.0');
    assert.equal(config.data.app.authorEn, 'Amir Parsa');
    assert.equal(config.data.platforms.length, 4);
    assert.equal(config.data.providers.openrouter.keyMask, null);
    assert.equal(config.data.social.every((s) => s.handle === '@technamooz'), true);
    assert.equal(config.data.support.handle, '@technamooz_support');

    const personas = await callWorker(worker, env, '/api/personas');
    assert.equal(personas.data.personas.length, 16);
    assert.equal(personas.data.personas.some((p) => p.id === 'translator'), true);
    assert.equal(personas.data.personas.some((p) => p.id === 'thinker'), true);

    const workersModels = await callWorker(worker, env, '/api/models?platform=workersai');
    assert.equal(workersModels.response.status, 200);
    assert.ok(workersModels.data.count >= 4);
    assert.ok(workersModels.data.models.some((m) => m.id === '@cf/meta/llama-3.3-70b-instruct-fp8-fast'));

    const openrouterModels = await callWorker(worker, env, '/api/models?platform=openrouter');
    assert.equal(openrouterModels.response.status, 200);
    assert.equal(openrouterModels.data.count, 2);
    assert.equal(openrouterModels.data.provider.keyMask, null);

    /* ---------------- web session, prefs, chat SSE and history ---------------- */
    const session = await callWorker(worker, env, '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(session.response.status, 200);
    const webCookie = cookieFrom(session.response);
    assert.match(webCookie, /^tm_uid=[a-f0-9]{32}$/);

    const prefs = await callWorker(worker, env, '/api/prefs', {
      method: 'POST',
      headers: jsonHeaders(webCookie),
      body: JSON.stringify({
        platform: 'openrouter',
        model: 'openrouter/free',
        persona: 'translator',
        deep: true
      })
    });
    assert.equal(prefs.response.status, 200);
    assert.equal(prefs.data.user.platform, 'openrouter');
    assert.equal(prefs.data.user.persona, 'translator');
    assert.equal(prefs.data.user.deep, true);

    const chat = await callWorker(worker, env, '/api/chat', {
      method: 'POST',
      headers: jsonHeaders(webCookie),
      body: JSON.stringify({
        message: 'سلام',
        platform: 'workersai',
        model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        persona: 'general'
      })
    });
    assert.equal(chat.response.status, 200);
    assert.match(chat.response.headers.get('content-type') || '', /text\/event-stream/);
    assert.match(chat.text, /"type":"meta"/);
    assert.match(chat.text, /"type":"delta"/);
    assert.match(chat.text, /"type":"done"/);
    assert.match(chat.text, /"v":"سلام "/);
    assert.match(chat.text, /"v":"از Workers AI"/);
    assert.equal(env.AI.calls.length >= 1, true);
    assert.equal(env.AI.calls[0].input.stream, true);

    const history = await callWorker(worker, env, '/api/history', {
      headers: { Cookie: webCookie }
    });
    assert.equal(history.response.status, 200);
    assert.equal(history.data.rounds.length, 1);
    assert.equal(history.data.rounds[0].q, 'سلام');
    assert.match(history.data.rounds[0].a, /Workers AI/);

    const reset = await callWorker(worker, env, '/api/reset', {
      method: 'POST',
      headers: jsonHeaders(webCookie),
      body: JSON.stringify({ mode: 'chat' })
    });
    assert.equal(reset.response.status, 200);
    const emptyHistory = await callWorker(worker, env, '/api/history', {
      headers: { Cookie: webCookie }
    });
    assert.equal(emptyHistory.data.rounds.length, 0);

    const feedback = await callWorker(worker, env, '/api/feedback', {
      method: 'POST',
      headers: jsonHeaders(webCookie),
      body: JSON.stringify({ text: 'تست بازخورد تکناموز' })
    });
    assert.equal(feedback.response.status, 200);
    assert.equal(feedback.data.ok, true);

    /* ---------------- admin authentication ---------------- */
    const adminStatus = await callWorker(worker, env, '/admin/status');
    assert.equal(adminStatus.response.status, 200);
    assert.equal(adminStatus.data.authed, false);
    assert.equal(adminStatus.data.mustChange, true);
    assert.equal(adminStatus.data.app.package, 'technamooz-ai-version1.0.0');

    const badLogin = await callWorker(worker, env, '/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' })
    });
    assert.equal(badLogin.response.status, 401);

    const login = await callWorker(worker, env, '/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' })
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.data.ok, true);
    assert.equal(login.data.mustChange, true);
    const adminCookie = cookieFrom(login.response);
    const csrf = login.data.csrf;
    assert.match(adminCookie, /^tm_admin=/);
    assert.ok(csrf && csrf.length >= 20);

    const overview = await callWorker(worker, env, '/admin/api/overview', {
      headers: { Cookie: adminCookie }
    });
    assert.equal(overview.response.status, 200);
    assert.equal(overview.data.ok, true);
    assert.equal(overview.data.personas, 16);
    assert.equal(overview.data.platforms, 4);
    assert.equal(overview.data.counts.web >= 1, true);
    assert.equal(overview.data.providers.workersai.ready, true);
    assert.equal(overview.data.providers.openrouter.ready, false);
    assert.equal(overview.data.stats.length, 7);

    const keys = await callWorker(worker, env, '/admin/api/keys', {
      headers: { Cookie: adminCookie }
    });
    assert.equal(keys.response.status, 200);
    assert.equal(keys.data.docs.length, 4);
    assert.equal(keys.data.cloudflare.aiBinding, true);

    const settings = await callWorker(worker, env, '/admin/api/settings', {
      headers: { Cookie: adminCookie }
    });
    assert.equal(settings.response.status, 200);
    assert.equal(settings.data.platforms.length, 4);
    assert.equal(settings.data.personas.length, 16);

    const noCsrf = await callWorker(worker, env, '/admin/api/settings', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ announcement: 'بدون CSRF' })
    });
    assert.equal(noCsrf.response.status, 403);

    const crossOrigin = await callWorker(worker, env, '/admin/api/settings', {
      method: 'POST',
      headers: { ...jsonHeaders(adminCookie, csrf), Origin: 'https://evil.example.com' },
      body: JSON.stringify({ announcement: 'cross origin' })
    });
    assert.equal(crossOrigin.response.status, 403);

    const saveSettings = await callWorker(worker, env, '/admin/api/settings', {
      method: 'POST',
      headers: jsonHeaders(adminCookie, csrf),
      body: JSON.stringify({ announcement: 'اعلان تست', roundsCap: 10 })
    });
    assert.equal(saveSettings.response.status, 200);
    assert.equal(saveSettings.data.settings.announcement, 'اعلان تست');
    assert.equal(saveSettings.data.settings.roundsCap, 10);

    /* ---------------- provider key lifecycle ---------------- */
    const saveKey = await callWorker(worker, env, '/admin/api/keys/openrouter', {
      method: 'POST',
      headers: jsonHeaders(adminCookie, csrf),
      body: JSON.stringify({ key: 'sk-or-test-secret-1234567890', test: false })
    });
    assert.equal(saveKey.response.status, 200);
    assert.equal(saveKey.data.ok, true);
    assert.equal(saveKey.data.providers.openrouter.ready, true);
    assert.match(saveKey.data.providers.openrouter.keyMask, /^sk-or-t/);

    const keysAfterSave = await callWorker(worker, env, '/admin/api/keys', {
      headers: { Cookie: adminCookie }
    });
    assert.equal(keysAfterSave.data.providers.openrouter.ready, true);
    assert.match(keysAfterSave.data.providers.openrouter.keyMask, /^sk-or-t/);

    const publicConfigAfterKey = await callWorker(worker, env, '/api/config');
    assert.equal(publicConfigAfterKey.data.providers.openrouter.keyMask, null);

    const deleteKey = await callWorker(worker, env, '/admin/api/keys/openrouter/delete', {
      method: 'POST',
      headers: jsonHeaders(adminCookie, csrf),
      body: '{}'
    });
    assert.equal(deleteKey.response.status, 200);
    assert.equal(deleteKey.data.providers.openrouter.ready, false);

    const evilProviderTest = await callWorker(worker, env, '/admin/api/keys/onerouter/test', {
      method: 'POST',
      headers: jsonHeaders(adminCookie, csrf),
      body: JSON.stringify({ key: 'sk-test-key-123456', baseUrl: 'https://evil.example.com/v1' })
    });
    assert.equal(evilProviderTest.response.status, 400);

    const adminModels = await callWorker(worker, env, '/admin/api/models?platform=workersai', {
      headers: { Cookie: adminCookie }
    });
    assert.equal(adminModels.response.status, 200);
    assert.ok(adminModels.data.count >= 4);

    /* ---------------- users, logs and security ---------------- */
    const users = await callWorker(worker, env, '/admin/api/users?source=web&page=1', {
      headers: { Cookie: adminCookie }
    });
    assert.equal(users.response.status, 200);
    assert.equal(users.data.users.length, 1);
    const webId = users.data.users[0].id;

    const userDetail = await callWorker(worker, env, '/admin/api/users/web/' + webId, {
      headers: { Cookie: adminCookie }
    });
    assert.equal(userDetail.response.status, 200);
    assert.equal(userDetail.data.profile.id, webId);
    assert.equal(Array.isArray(userDetail.data.memory.recent), true);

    const block = await callWorker(worker, env, '/admin/api/users/web/' + webId + '/block', {
      method: 'POST',
      headers: jsonHeaders(adminCookie, csrf),
      body: JSON.stringify({ banned: true })
    });
    assert.equal(block.response.status, 200);
    assert.equal(block.data.banned, true);
    const blockedChat = await callWorker(worker, env, '/api/chat', {
      method: 'POST',
      headers: jsonHeaders(webCookie),
      body: JSON.stringify({ message: 'سلام دوباره', platform: 'workersai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' })
    });
    assert.equal(blockedChat.response.status, 403);
    await callWorker(worker, env, '/admin/api/users/web/' + webId + '/block', {
      method: 'POST',
      headers: jsonHeaders(adminCookie, csrf),
      body: JSON.stringify({ banned: false })
    });

    const logs = await callWorker(worker, env, '/admin/api/logs?limit=50', {
      headers: { Cookie: adminCookie }
    });
    assert.equal(logs.response.status, 200);
    assert.ok(logs.data.logs.length > 0);

    const security = await callWorker(worker, env, '/admin/api/security', {
      headers: { Cookie: adminCookie }
    });
    assert.equal(security.response.status, 200);
    assert.equal(security.data.username, 'admin');
    assert.equal(security.data.iterations, 1000);

    /* ---------------- Telegram token, webhook, test and broadcast ---------------- */
    const token = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const tgToken = await callWorker(worker, env, '/admin/api/telegram/token', {
      method: 'POST',
      headers: jsonHeaders(adminCookie, csrf),
      body: JSON.stringify({ token })
    });
    assert.equal(tgToken.response.status, 200);
    assert.equal(tgToken.data.ok, true);
    assert.equal(tgToken.data.bot.username, 'technamooz_test');

    const tgAdmins = await callWorker(worker, env, '/admin/api/telegram/admins', {
      method: 'POST',
      headers: jsonHeaders(adminCookie, csrf),
      body: JSON.stringify({ ids: [123456789] })
    });
    assert.equal(tgAdmins.response.status, 200);
    assert.deepEqual(tgAdmins.data.admins, [123456789]);

    const webhook = await callWorker(worker, env, '/admin/api/telegram/webhook', {
      method: 'POST',
      headers: jsonHeaders(adminCookie, csrf),
      body: JSON.stringify({ action: 'set' })
    });
    assert.equal(webhook.response.status, 200);
    assert.match(webhook.data.webhookUrl, /^https:\/\/test\.technamooz\.ai\/telegram\/webhook\/[a-f0-9]+$/);

    const tgInfo = await callWorker(worker, env, '/admin/api/telegram', {
      headers: { Cookie: adminCookie }
    });
    assert.equal(tgInfo.response.status, 200);
    assert.equal(tgInfo.data.bot.configured, true);
    const secret = tgInfo.data.bot.secret;
    assert.ok(secret);

    const tgTest = await callWorker(worker, env, '/admin/api/telegram/test', {
      method: 'POST',
      headers: jsonHeaders(adminCookie, csrf),
      body: JSON.stringify({ text: 'تست ربات' })
    });
    assert.equal(tgTest.response.status, 200);
    assert.equal(tgTest.data.ok, true);

    const telegramUpdate = await callWorker(worker, env, '/telegram/webhook/' + secret, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': secret
      },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 123456789, type: 'private' },
          from: { id: 123456789, first_name: 'Test' },
          text: '/start'
        }
      })
    });
    assert.equal(telegramUpdate.response.status, 200);
    assert.equal(telegramUpdate.data.ok, true);
    assert.ok(fetchMock.calls.some((c) => c.url.includes('/sendMessage')));

    const telegramChat = await callWorker(worker, env, '/telegram/webhook/' + secret, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': secret
      },
      body: JSON.stringify({
        update_id: 2,
        message: {
          message_id: 2,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 123456789, type: 'private' },
          from: { id: 123456789, first_name: 'Test' },
          text: 'سلام از تلگرام'
        }
      })
    });
    assert.equal(telegramChat.response.status, 200);
    const sentTexts = fetchMock.calls
      .filter((c) => c.url.includes('/sendMessage'))
      .map((c) => {
        try { return JSON.parse(c.options.body).text; } catch { return ''; }
      });
    assert.ok(sentTexts.some((text) => text.includes('Workers AI')));
    const tgProfile = await env.DB.get('profile:tg:123456789', 'json');
    assert.equal(tgProfile.msgs, 1);
    const tgMind = await env.DB.get('mind:tg:123456789', 'json');
    assert.equal(tgMind.rounds.length, 1);
    assert.equal(tgMind.rounds[0].q, 'سلام از تلگرام');

    const personaCallback = await callWorker(worker, env, '/telegram/webhook/' + secret, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': secret
      },
      body: JSON.stringify({
        update_id: 3,
        callback_query: {
          id: 'cb-persona',
          from: { id: 123456789, first_name: 'Test' },
          message: {
            message_id: 3,
            chat: { id: 123456789, type: 'private' }
          },
          data: 'per:translator'
        }
      })
    });
    assert.equal(personaCallback.response.status, 200);
    const personaProfile = await env.DB.get('profile:tg:123456789', 'json');
    assert.equal(personaProfile.persona, 'translator');

    const recommendedCallback = await callWorker(worker, env, '/telegram/webhook/' + secret, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': secret
      },
      body: JSON.stringify({
        update_id: 4,
        callback_query: {
          id: 'cb-recommended',
          from: { id: 123456789, first_name: 'Test' },
          message: {
            message_id: 4,
            chat: { id: 123456789, type: 'private' }
          },
          data: 'rec:translator'
        }
      })
    });
    assert.equal(recommendedCallback.response.status, 200);
    const recommendedProfile = await env.DB.get('profile:tg:123456789', 'json');
    assert.equal(recommendedProfile.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');

    const tgUsers = await callWorker(worker, env, '/admin/api/users?source=tg&page=1', {
      headers: { Cookie: adminCookie }
    });
    assert.equal(tgUsers.response.status, 200);
    assert.equal(tgUsers.data.users.length, 1);

    const broadcast = await callWorker(worker, env, '/admin/api/telegram/broadcast', {
      method: 'POST',
      headers: jsonHeaders(adminCookie, csrf),
      body: JSON.stringify({ text: 'پیام همگانی تست' })
    });
    assert.equal(broadcast.response.status, 200);
    assert.equal(broadcast.data.ok, true);
    assert.equal(broadcast.data.sent, 1);

    /* ---------------- password change, session revocation, logout ---------------- */
    const password = await callWorker(worker, env, '/admin/api/security/password', {
      method: 'POST',
      headers: jsonHeaders(adminCookie, csrf),
      body: JSON.stringify({
        currentPassword: 'admin',
        newPassword: 'new-strong-password-123',
        username: 'admin'
      })
    });
    assert.equal(password.response.status, 200);
    assert.equal(password.data.ok, true);
    const freshCookie = cookieFrom(password.response);
    const freshCsrf = password.data.csrf;

    const oldSession = await callWorker(worker, env, '/admin/api/overview', {
      headers: { Cookie: adminCookie }
    });
    assert.equal(oldSession.response.status, 401);

    const freshOverview = await callWorker(worker, env, '/admin/api/overview', {
      headers: { Cookie: freshCookie }
    });
    assert.equal(freshOverview.response.status, 200);

    const logoutNoCsrf = await callWorker(worker, env, '/admin/logout', {
      method: 'POST',
      headers: { Cookie: freshCookie, 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(logoutNoCsrf.response.status, 403);

    const logout = await callWorker(worker, env, '/admin/logout', {
      method: 'POST',
      headers: jsonHeaders(freshCookie, freshCsrf),
      body: '{}'
    });
    assert.equal(logout.response.status, 200);
    assert.equal(logout.data.ok, true);

    const afterLogout = await callWorker(worker, env, '/admin/api/overview', {
      headers: { Cookie: freshCookie }
    });
    assert.equal(afterLogout.response.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
