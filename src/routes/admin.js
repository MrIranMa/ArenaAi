// ============================================================
//  ArenaAi — ArenaAi-v1.0.0
//  Author: ArenaAi
//  src/routes/admin.js — secure admin API
//  Login: /admin  (not linked from the public chat page)
// ============================================================

import { APP, LIMITS, PLATFORMS, PLATFORM_ORDER } from '../config.js';
import { PERSONAS, PERSONA_ORDER } from '../personas.js';
import {
  hasDB, jsonResp, getSettings, saveSettings, getCreds, setCreds,
  setProviderKey, getCfAccount, setCfAccount,
  getTgBot, saveTgBot, getTgAdmins, saveTgAdmins,
  getProfile, saveProfile, deleteProfile, getMind, wipeMind, indexList, indexCount,
  getLogs, clearLogs, getStats, log, bumpStat, maskKey, safeInt
} from '../store.js';
import {
  ensureCreds, verifyPassword, hashPassword, createSession, getSession,
  requireAdmin, requireCsrf, destroySession, adminCookie, clearAdminCookie,
  isSecureRequest, loginGuard, sameOrigin, randomToken
} from '../auth.js';
import {
  providerStatus, listModels, testProvider, validateBaseUrl
} from '../providers.js';
import {
  tgGetMe, tgSetWebhook, tgDeleteWebhook, tgGetWebhookInfo,
  tgSetMyCommands, tgSendMessage, splitText
} from '../tgapi.js';

/* ============================ entry ============================ */

export async function handleAdminApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!hasDB(env)) {
    return jsonResp({ ok: false, setup: true, error: 'KV namespace DB تنظیم نشده است.' }, 503);
  }

  try {
    if ((path === '/admin/status' || path === '/admin/api/status') && method === 'GET') {
      return status(request, env);
    }
    if (path === '/admin/login' && method === 'POST') {
      return login(request, env);
    }
    if (path === '/admin/logout' && method === 'POST') {
      return logout(request, env);
    }

    if (!path.startsWith('/admin/api/')) {
      return jsonResp({ ok: false, error: 'not found' }, 404);
    }

    const session = await requireAdmin(request, env);
    if (!session) return jsonResp({ ok: false, error: 'unauthorized' }, 401);

    if (method === 'POST') {
      if (!sameOrigin(request)) return jsonResp({ ok: false, error: 'cross-origin request rejected' }, 403);
      if (!(await requireCsrf(request, session))) {
        return jsonResp({ ok: false, error: 'invalid csrf token' }, 403);
      }
    }

    /* -------------------- dashboard -------------------- */
    if (path === '/admin/api/overview' && method === 'GET') return overview(env, session);
    if (path === '/admin/api/settings' && method === 'GET') return getSettingsApi(env);
    if (path === '/admin/api/settings' && method === 'POST') return updateSettings(request, env);

    /* -------------------- provider keys -------------------- */
    if (path === '/admin/api/keys' && method === 'GET') return keys(env);
    if (path.startsWith('/admin/api/keys/') && method === 'POST') {
      const parts = path.split('/').filter(Boolean); // admin api keys <platform> [action]
      const platform = parts[3];
      const action = parts[4] || '';
      if (action === 'test') return testKey(request, env, platform);
      if (action === 'delete') return deleteKey(env, platform);
      return saveKey(request, env, platform);
    }
    if (path === '/admin/api/models' && method === 'GET') return adminModels(env, url);

    /* -------------------- telegram -------------------- */
    if (path === '/admin/api/telegram' && method === 'GET') return telegramInfo(request, env);
    if (path === '/admin/api/telegram/token' && method === 'POST') return telegramToken(request, env);
    if (path === '/admin/api/telegram/admins' && method === 'POST') return telegramAdmins(request, env);
    if (path === '/admin/api/telegram/webhook' && method === 'POST') return telegramWebhook(request, env);
    if (path === '/admin/api/telegram/test' && method === 'POST') return telegramTest(request, env);
    if (path === '/admin/api/telegram/broadcast' && method === 'POST') return telegramBroadcast(request, env);

    /* -------------------- users -------------------- */
    if (path === '/admin/api/users' && method === 'GET') return users(env, url);
    if (path.startsWith('/admin/api/users/')) return userAction(request, env, path, method);

    /* -------------------- logs -------------------- */
    if (path === '/admin/api/logs' && method === 'GET') return logs(env, url);
    if (path === '/admin/api/logs/clear' && method === 'POST') {
      await clearLogs(env);
      await log(env, 'admin', 'logs cleared by ' + session.u);
      return jsonResp({ ok: true });
    }

    /* -------------------- security -------------------- */
    if (path === '/admin/api/security' && method === 'GET') return securityInfo(env, session);
    if (path === '/admin/api/security/password' && method === 'POST') return changePassword(request, env, session);
    if (path === '/admin/api/security/logout-all' && method === 'POST') return logoutAll(request, env, session);

    /* -------------------- maintenance -------------------- */
    if (path === '/admin/api/maintenance' && method === 'POST') return maintenance(request, env);

    return jsonResp({ ok: false, error: 'not found' }, 404);
  } catch (e) {
    await log(env, 'error', 'admin api ' + path + ': ' + String((e && e.message) || e).slice(0, 220));
    return jsonResp({ ok: false, error: 'خطای داخلی پنل مدیریت.' }, 500);
  }
}

/* ============================ auth ============================ */

async function status(request, env) {
  await ensureCreds(env);
  const cred = await getCreds(env);
  const session = await getSession(env, request);
  return jsonResp({
    ok: true,
    authed: !!session,
    csrf: session ? session.csrf : null,
    mustChange: !!(cred && cred.mustChange),
    app: {
      name: APP.name,
      faName: APP.faName,
      version: APP.version,
      package: APP.package,
      author: APP.author
    }
  });
}

async function login(request, env) {
  if (!sameOrigin(request)) return jsonResp({ ok: false, error: 'cross-origin request rejected' }, 403);
  const guard = await loginGuard(env, request);
  if (!guard.ok) {
    return jsonResp({ ok: false, error: 'تلاش‌های ورود بیش از حد مجاز است. چند دقیقه صبر کنید.' }, 429);
  }

  let body;
  try { body = await request.json(); } catch { return jsonResp({ ok: false, error: 'JSON نامعتبر است.' }, 400); }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return jsonResp({ ok: false, error: 'نام کاربری و رمز عبور را وارد کنید.' }, 400);

  const cred = await ensureCreds(env);
  const usernameOk = username === cred.username;
  const passwordOk = await verifyPassword(password, cred);
  if (!usernameOk || !passwordOk) {
    await log(env, 'security', 'failed admin login from ' + (request.headers.get('cf-connecting-ip') || 'unknown'));
    return jsonResp({ ok: false, error: 'نام کاربری یا رمز عبور اشتباه است.' }, 401);
  }

  const session = await createSession(env, cred.username, cred.epoch || 0);
  await log(env, 'security', 'admin login: ' + username);
  return jsonResp({
    ok: true,
    csrf: session.csrf,
    mustChange: !!cred.mustChange
  }, 200, {
    'Set-Cookie': adminCookie(session.token, isSecureRequest(request))
  });
}

async function logout(request, env) {
  const session = await getSession(env, request);
  if (session) {
    if (!sameOrigin(request) || !(await requireCsrf(request, session))) {
      return jsonResp({ ok: false, error: 'invalid csrf token' }, 403);
    }
    await destroySession(env, request);
  }
  return jsonResp({ ok: true }, 200, {
    'Set-Cookie': clearAdminCookie(isSecureRequest(request))
  });
}

async function securityInfo(env, session) {
  const cred = await getCreds(env);
  return jsonResp({
    ok: true,
    username: cred ? cred.username : null,
    mustChange: !!(cred && cred.mustChange),
    sessionStarted: session.c,
    sessionTtl: LIMITS.sessionTtlSec,
    iterations: cred ? (cred.iter || cred.iterations || null) : null,
    epoch: cred ? cred.epoch : 0
  });
}

async function changePassword(request, env, session) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ ok: false, error: 'JSON نامعتبر است.' }, 400); }
  const current = String(body.currentPassword || '');
  const next = String(body.newPassword || '');
  const nextUser = String(body.username || '').trim();

  const cred = await getCreds(env);
  if (!cred || !(await verifyPassword(current, cred))) {
    return jsonResp({ ok: false, error: 'رمز عبور فعلی اشتباه است.' }, 401);
  }
  if (next.length < LIMITS.passwordMin || next.length > LIMITS.passwordMax) {
    return jsonResp({ ok: false, error: 'رمز جدید باید بین ' + LIMITS.passwordMin + ' و ' + LIMITS.passwordMax + ' نویسه باشد.' }, 400);
  }
  if (nextUser && !/^[A-Za-z0-9_.-]{3,32}$/.test(nextUser)) {
    return jsonResp({ ok: false, error: 'نام کاربری باید ۳ تا ۳۲ نویسه و شامل حروف، عدد، نقطه، خط تیره یا زیرخط باشد.' }, 400);
  }

  const { salt, iter, hash } = await hashPassword(next, env);
  const epoch = (Number(cred.epoch) || 0) + 1;
  await setCreds(env, {
    username: nextUser || cred.username,
    salt,
    iter,
    hash,
    epoch,
    mustChange: false,
    createdAt: cred.createdAt || Date.now(),
    updatedAt: Date.now()
  });
  const fresh = await createSession(env, nextUser || cred.username, epoch);
  await log(env, 'security', 'admin credentials changed');
  return jsonResp({
    ok: true,
    csrf: fresh.csrf,
    username: nextUser || cred.username
  }, 200, {
    'Set-Cookie': adminCookie(fresh.token, isSecureRequest(request))
  });
}

async function logoutAll(request, env, session) {
  const cred = await getCreds(env);
  if (!cred) return jsonResp({ ok: false, error: 'credentials missing' }, 400);
  await setCreds(env, { ...cred, epoch: (Number(cred.epoch) || 0) + 1, updatedAt: Date.now() });
  await log(env, 'security', 'all admin sessions revoked by ' + session.u);
  return jsonResp({ ok: true }, 200, {
    'Set-Cookie': clearAdminCookie(isSecureRequest(request))
  });
}

/* ============================ overview / settings ============================ */

async function overview(env, session) {
  const settings = await getSettings(env);
  const status = await providerStatus(env, { includeMask: true });
  const tg = await getTgBot(env);
  const admins = await getTgAdmins(env);
  const stats = await getStats(env, 7);
  const [webCount, tgCount] = await Promise.all([indexCount(env, 'web'), indexCount(env, 'tg')]);
  const recent = await getLogs(env, 15);

  const totals = { web_msgs: 0, tg_msgs: 0, feedbacks: 0, image_generations: 0 };
  for (const day of stats) {
    for (const k of Object.keys(totals)) totals[k] += Number(day[k]) || 0;
  }

  const providerUsage = {};
  for (const day of stats) {
    for (const [key, value] of Object.entries(day)) {
      if (key.startsWith('usage_')) providerUsage[key.slice(6)] = (providerUsage[key.slice(6)] || 0) + (Number(value) || 0);
    }
  }

  return jsonResp({
    ok: true,
    app: {
      name: APP.name,
      faName: APP.faName,
      version: APP.version,
      package: APP.package,
      author: APP.author,
      authorEn: APP.authorEn
    },
    session: { user: session.u, started: session.c },
    stats,
    totals,
    providerUsage,
    counts: { web: webCount, tg: tgCount, total: webCount + tgCount },
    providers: status,
    telegram: {
      configured: !!tg.token,
      username: tg.username,
      tokenMasked: tg.token ? maskKey(tg.token) : null,
      webhookConfigured: !!tg.webUrl,
      admins: admins.length
    },
    settings,
    recent,
    personas: PERSONA_ORDER.length,
    platforms: PLATFORM_ORDER.length
  });
}

async function getSettingsApi(env) {
  const settings = await getSettings(env);
  return jsonResp({
    ok: true,
    settings,
    platforms: PLATFORM_ORDER.map((id) => ({
      id,
      label: PLATFORMS[id].faLabel,
      defaultModel: settings.defaultModel[id] || PLATFORMS[id].defaultModel
    })),
    personas: PERSONA_ORDER.map((id) => ({ id, name: PERSONAS[id].name }))
  });
}

async function updateSettings(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ ok: false, error: 'JSON نامعتبر است.' }, 400); }
  const current = await getSettings(env);
  const patch = {};

  if (body.siteTitle != null) patch.siteTitle = String(body.siteTitle).trim().slice(0, 80) || current.siteTitle;
  if (body.announcement != null) patch.announcement = String(body.announcement).trim().slice(0, 600);
  if (body.extraInstructions != null) patch.extraInstructions = String(body.extraInstructions).trim().slice(0, 2500);
  if (body.feedbackPrompt != null) patch.feedbackPrompt = String(body.feedbackPrompt).trim().slice(0, 200);
  if (body.defaultPlatform != null) {
    if (!PLATFORMS[body.defaultPlatform]) return jsonResp({ ok: false, error: 'پلتفرم پیش‌فرض نامعتبر است.' }, 400);
    patch.defaultPlatform = body.defaultPlatform;
  }
  if (body.defaultPersona != null) {
    if (!PERSONAS[body.defaultPersona]) return jsonResp({ ok: false, error: 'شخصیت پیش‌فرض نامعتبر است.' }, 400);
    patch.defaultPersona = body.defaultPersona;
  }
  if (body.defaultModel != null && typeof body.defaultModel === 'object') {
    const next = { ...current.defaultModel };
    for (const id of PLATFORM_ORDER) {
      const value = body.defaultModel[id];
      if (value != null) {
        const v = String(value).trim().slice(0, 180);
        if (!/^[A-Za-z0-9@._:/+-]+$/.test(v)) return jsonResp({ ok: false, error: 'شناسهٔ مدل پیش‌فرض نامعتبر است.' }, 400);
        next[id] = v;
      }
    }
    patch.defaultModel = next;
  }
  if (body.maxTokensNormal != null) patch.maxTokensNormal = safeInt(body.maxTokensNormal, current.maxTokensNormal, 512, 8192);
  if (body.maxTokensDeep != null) patch.maxTokensDeep = safeInt(body.maxTokensDeep, current.maxTokensDeep, 1024, LIMITS.deepTokensLimit);
  if (body.roundsCap != null) patch.roundsCap = safeInt(body.roundsCap, current.roundsCap, 6, 80);
  if (body.memoryEnabled != null) patch.memoryEnabled = !!body.memoryEnabled;
  if (body.factsEnabled != null) patch.factsEnabled = !!body.factsEnabled;
  if (body.fallbackEnabled != null) patch.fallbackEnabled = !!body.fallbackEnabled;
  if (body.maintenance != null) patch.maintenance = !!body.maintenance;

  const next = await saveSettings(env, patch);
  await log(env, 'admin', 'settings updated');
  return jsonResp({ ok: true, settings: next });
}

async function maintenance(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ ok: false, error: 'JSON نامعتبر است.' }, 400); }
  const next = await saveSettings(env, { maintenance: !!body.enabled });
  await log(env, 'admin', 'maintenance ' + (next.maintenance ? 'enabled' : 'disabled'));
  return jsonResp({ ok: true, maintenance: next.maintenance });
}

/* ============================ keys ============================ */

async function keys(env) {
  const status = await providerStatus(env, { includeMask: true });
  const cf = await getCfAccount(env);
  return jsonResp({
    ok: true,
    providers: status,
    cloudflare: {
      accountId: cf ? cf.accountId : null,
      hasToken: !!(cf && cf.token),
      tokenMasked: cf && cf.token ? maskKey(cf.token) : null,
      aiBinding: !!env.AI
    },
    docs: PLATFORM_ORDER.map((id) => ({
      id,
      label: PLATFORMS[id].faLabel,
      docs: PLATFORMS[id].docs,
      keysUrl: PLATFORMS[id].keysUrl,
      requiresKey: PLATFORMS[id].requiresKey,
      allowBaseUrl: !!PLATFORMS[id].allowBaseUrl,
      baseUrl: (status[id] && status[id].baseUrl) || PLATFORMS[id].baseUrl
    }))
  });
}

function validKey(key) {
  const s = String(key || '').trim();
  return s.length >= 8 && s.length <= 300 && !/\s/.test(s);
}

function testPayload(result) {
  if (!result || typeof result !== 'object') {
    return { ok: false, valid: false, message: 'نتیجهٔ تست نامعتبر است.' };
  }
  return { ...result, ok: result.ok !== undefined ? !!result.ok : !!result.valid };
}

async function invalidateModelCache(env, platform) {
  try { await env.DB.delete('cache:models:v2:' + platform); } catch { /* best effort */ }
}

async function saveKey(request, env, platform) {
  if (!PLATFORMS[platform]) return jsonResp({ ok: false, error: 'پلتفرم نامعتبر است.' }, 400);
  let body;
  try { body = await request.json(); } catch { return jsonResp({ ok: false, error: 'JSON نامعتبر است.' }, 400); }

  if (platform === 'workersai') {
    const accountId = String(body.accountId || '').trim();
    const token = String(body.token || '').trim();
    if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) {
      return jsonResp({ ok: false, error: 'Account ID کلادفلر باید ۳۲ نویسهٔ هگز باشد.' }, 400);
    }
    if (token && token.length < 20) return jsonResp({ ok: false, error: 'API Token کلادفلر معتبر به نظر نمی‌رسد.' }, 400);
    if (!accountId && !token) return jsonResp({ ok: false, error: 'Account ID و API Token را وارد کنید.' }, 400);
    await setCfAccount(env, accountId, token);
    await log(env, 'admin', 'cloudflare account credentials updated');
    const test = testPayload(await testProvider(env, 'workersai'));
    return jsonResp({ ok: true, test, providers: await providerStatus(env, { includeMask: true }) });
  }

  const key = String(body.key || '').trim();
  if (!validKey(key)) return jsonResp({ ok: false, error: 'کلید API معتبر به نظر نمی‌رسد (حداقل ۸ نویسه، بدون فاصله).' }, 400);

  let baseUrl = null;
  if (PLATFORMS[platform].allowBaseUrl && body.baseUrl) {
    const checked = validateBaseUrl(body.baseUrl);
    if (!checked.ok) return jsonResp({ ok: false, error: checked.error }, 400);
    baseUrl = checked.value;
  }
  await setProviderKey(env, platform, key, baseUrl);
  await log(env, 'admin', 'provider key updated: ' + platform);
  const test = body.test === false ? null : testPayload(await testProvider(env, platform));
  return jsonResp({ ok: true, test, providers: await providerStatus(env, { includeMask: true }) });
}

async function deleteKey(env, platform) {
  if (!PLATFORMS[platform]) return jsonResp({ ok: false, error: 'پلتفرم نامعتبر است.' }, 400);
  if (platform === 'workersai') {
    await setCfAccount(env, '', null);
  } else {
    await setProviderKey(env, platform, '', null);
  }
  await log(env, 'admin', 'provider key deleted: ' + platform);
  return jsonResp({ ok: true, providers: await providerStatus(env, { includeMask: true }) });
}

async function testKey(request, env, platform) {
  if (!PLATFORMS[platform]) return jsonResp({ ok: false, error: 'پلتفرم نامعتبر است.' }, 400);
  let body = {};
  try { body = await request.json(); } catch { /* optional */ }
  let baseUrl = null;
  if (PLATFORMS[platform].allowBaseUrl && body.baseUrl) {
    const checked = validateBaseUrl(body.baseUrl);
    if (!checked.ok) return jsonResp({ ok: false, error: checked.error }, 400);
    baseUrl = checked.value;
  }
  const result = testPayload(await testProvider(env, platform, body.key, baseUrl));
  return jsonResp({ ok: true, test: result });
}

async function adminModels(env, url) {
  const requested = url.searchParams.get('platform') || 'workersai';
  const platform = PLATFORMS[requested] ? requested : 'workersai';
  const refresh = url.searchParams.get('refresh') === '1';
  try {
    const models = await listModels(env, platform, { refresh });
    return jsonResp({ ok: true, platform, models, count: models.length });
  } catch (e) {
    return jsonResp({ ok: false, platform, error: String((e && e.message) || e).slice(0, 240), models: [] }, 502);
  }
}

/* ============================ telegram ============================ */

async function telegramInfo(request, env) {
  const tg = await getTgBot(env);
  const admins = await getTgAdmins(env);
  let info = null;
  if (tg.token) {
    const r = await tgGetWebhookInfo(tg.token);
    if (r && r.ok) info = r.result;
  }
  const origin = new URL(request.url).origin;
  return jsonResp({
    ok: true,
    bot: {
      configured: !!tg.token,
      username: tg.username,
      tokenMasked: tg.token ? maskKey(tg.token) : null,
      secret: tg.secret,
      webhookUrl: tg.secret ? origin + '/telegram/webhook/' + tg.secret : null,
      webhookConfigured: !!tg.webUrl,
      commandsSet: !!tg.commandsSet
    },
    admins,
    webhookInfo: info
  });
}

async function telegramToken(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ ok: false, error: 'JSON نامعتبر است.' }, 400); }
  const token = String(body.token || '').trim();
  if (!/^[0-9]{5,12}:[A-Za-z0-9_-]{25,}$/.test(token)) {
    return jsonResp({ ok: false, error: 'فرمت توکن ربات تلگرام معتبر نیست. توکن را از BotFather بگیرید.' }, 400);
  }
  const me = await tgGetMe(token);
  if (!me.ok) return jsonResp({ ok: false, error: 'توکن تلگرام معتبر نیست: ' + (me.error || 'getMe failed') }, 400);

  const old = await getTgBot(env);
  const secret = old.secret || randomToken(24);
  await saveTgBot(env, { token, username: me.username, secret, commandsSet: false });
  const commands = await tgSetMyCommands(token);
  if (commands.ok) await saveTgBot(env, { commandsSet: true });
  await log(env, 'admin', 'telegram token updated: @' + me.username);
  return jsonResp({
    ok: true,
    bot: { username: me.username, id: me.id, commandsSet: !!commands.ok },
    warning: commands.ok ? null : 'توکن ذخیره شد اما ثبت دستورها ناموفق بود.'
  });
}

async function telegramAdmins(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ ok: false, error: 'JSON نامعتبر است.' }, 400); }
  const raw = Array.isArray(body.ids) ? body.ids.join(',') : String(body.ids || '');
  const ids = raw.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean).map(Number);
  if (ids.some((n) => !Number.isFinite(n) || n === 0)) {
    return jsonResp({ ok: false, error: 'شناسهٔ عددی تلگرام معتبر نیست.' }, 400);
  }
  const clean = await saveTgAdmins(env, ids);
  await log(env, 'admin', 'telegram admins updated: ' + clean.length);
  return jsonResp({ ok: true, admins: clean });
}

async function telegramWebhook(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ ok: false, error: 'JSON نامعتبر است.' }, 400); }
  const tg = await getTgBot(env);
  if (!tg.token) return jsonResp({ ok: false, error: 'اول توکن ربات را ذخیره کنید.' }, 400);

  const action = String(body.action || 'set');
  if (action === 'delete') {
    const r = await tgDeleteWebhook(tg.token);
    if (!r.ok) return jsonResp({ ok: false, error: r.description || r.error || 'deleteWebhook failed' }, 400);
    await saveTgBot(env, { webUrl: null });
    return jsonResp({ ok: true, deleted: true });
  }
  if (action === 'info') {
    const r = await tgGetWebhookInfo(tg.token);
    return jsonResp({ ok: true, info: r.ok ? r.result : null, error: r.ok ? null : (r.description || r.error) });
  }

  const secret = tg.secret || randomToken(24);
  if (!tg.secret) await saveTgBot(env, { secret });
  const origin = new URL(request.url).origin;
  const webhookUrl = origin + '/telegram/webhook/' + secret;
  const r = await tgSetWebhook(tg.token, webhookUrl, secret);
  if (!r.ok) return jsonResp({ ok: false, error: r.description || r.error || 'setWebhook failed' }, 400);
  await saveTgBot(env, { webUrl: webhookUrl, secret });
  /* register the slash-command menu (best effort — never blocks the webhook) */
  let commandsOk = false;
  try { commandsOk = !!(await tgSetMyCommands(tg.token)).ok; } catch { /* ignore */ }
  await log(env, 'admin', 'telegram webhook set' + (commandsOk ? ' + commands registered' : ''));
  return jsonResp({ ok: true, webhookUrl, commandsOk });
}

async function telegramTest(request, env) {
  let body = {};
  try { body = await request.json(); } catch { /* optional */ }
  const tg = await getTgBot(env);
  if (!tg.token) return jsonResp({ ok: false, error: 'توکن ربات تنظیم نشده است.' }, 400);
  const admins = await getTgAdmins(env);
  if (!admins.length) return jsonResp({ ok: false, error: 'ابتدا شناسهٔ عددی ادمین تلگرام را ذخیره کنید.' }, 400);
  const text = String(body.text || '✅ پیام آزمایشی تکناموز — اتصال ربات برقرار است.').slice(0, 2000);
  const results = [];
  for (const id of admins) {
    const r = await tgSendMessage(tg.token, id, text);
    results.push({ id, ok: !!r.ok, error: r.ok ? null : (r.description || r.error || 'failed') });
  }
  return jsonResp({ ok: results.every((x) => x.ok), results });
}

async function telegramBroadcast(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ ok: false, error: 'JSON نامعتبر است.' }, 400); }
  const tg = await getTgBot(env);
  if (!tg.token) return jsonResp({ ok: false, error: 'توکن ربات تنظیم نشده است.' }, 400);
  const text = String(body.text || '').trim().slice(0, 3000);
  if (!text) return jsonResp({ ok: false, error: 'متن پیام خالی است.' }, 400);

  const page = Math.max(1, parseInt(body.cursor, 10) || 1);
  const total = await indexCount(env, 'tg');
  if (total === 0) return jsonResp({ ok: true, sent: 0, failed: 0, total: 0, next: null });
  const list = await indexList(env, 'tg', page, LIMITS.broadcastBatch);
  if (!list.ids.length) return jsonResp({ ok: true, sent: 0, failed: 0, total, next: null });

  let sent = 0;
  let failed = 0;
  const errors = [];
  for (const id of list.ids) {
    const profile = await getProfile(env, 'tg', id);
    if (!profile || profile.banned) continue;
    const r = await tgSendMessage(tg.token, id, text);
    if (r.ok) sent += 1;
    else {
      failed += 1;
      if (errors.length < 5) errors.push({ id, error: String(r.description || r.error || 'failed').slice(0, 120) });
    }
  }
  await bumpStat(env, 'broadcasts');
  await log(env, 'admin', 'telegram broadcast page ' + page + ': ' + sent + ' sent');
  return jsonResp({
    ok: true,
    sent,
    failed,
    total,
    page,
    next: page < list.pages ? page + 1 : null,
    errors
  });
}

/* ============================ users ============================ */

function normalizeSource(value) {
  return value === 'tg' || value === 'web' ? value : null;
}

function normalizeId(source, value) {
  if (source === 'tg') {
    const n = Number(value);
    return Number.isFinite(n) && n !== 0 ? n : null;
  }
  return /^[a-f0-9]{16,64}$/i.test(String(value)) ? String(value) : null;
}

async function users(env, url) {
  const source = normalizeSource(url.searchParams.get('source')) || 'web';
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const list = await indexList(env, source, page, LIMITS.adminPageSize);
  const profiles = await Promise.all(list.ids.map(async (id) => {
    const p = await getProfile(env, source, id);
    if (!p) return null;
    return {
      id,
      name: p.name || '',
      username: p.username || '',
      msgs: Number(p.msgs) || 0,
      banned: !!p.banned,
      platform: p.platform || '',
      model: p.model || '',
      persona: p.persona || 'general',
      createdAt: p.createdAt || 0,
      lastSeen: p.lastSeen || 0
    };
  }));
  return jsonResp({
    ok: true,
    source,
    ...list,
    users: profiles.filter(Boolean)
  });
}

async function userAction(request, env, path, method) {
  const parts = path.split('/').filter(Boolean); // admin api users <source> <id> [action]
  const source = normalizeSource(parts[3]);
  const id = source ? normalizeId(source, parts[4]) : null;
  const action = parts[5] || '';
  if (!source || !id) return jsonResp({ ok: false, error: 'کاربر نامعتبر است.' }, 400);

  if (method === 'GET' && !action) {
    const profile = await getProfile(env, source, id);
    if (!profile) return jsonResp({ ok: false, error: 'کاربر پیدا نشد.' }, 404);
    const mind = await getMind(env, source, id);
    return jsonResp({
      ok: true,
      profile,
      memory: {
        rounds: mind.rounds.length,
        summary: mind.summary,
        facts: mind.facts,
        recent: mind.rounds.slice(-5)
      }
    });
  }

  if (method !== 'POST') return jsonResp({ ok: false, error: 'method not allowed' }, 405);
  let body = {};
  try { body = await request.json(); } catch { /* optional */ }

  if (action === 'block') {
    const profile = await getProfile(env, source, id);
    if (!profile) return jsonResp({ ok: false, error: 'کاربر پیدا نشد.' }, 404);
    profile.banned = body.banned == null ? !profile.banned : !!body.banned;
    await saveProfile(env, source, id, profile);
    await log(env, 'admin', source + ' user ' + id + ' banned=' + profile.banned);
    return jsonResp({ ok: true, banned: profile.banned });
  }

  if (action === 'wipe') {
    const mode = ['chat', 'memory', 'all'].includes(body.mode) ? body.mode : 'all';
    await wipeMind(env, source, id, mode);
    await log(env, 'admin', source + ' user ' + id + ' memory wiped: ' + mode);
    return jsonResp({ ok: true, mode });
  }

  if (action === 'delete') {
    await deleteProfile(env, source, id);
    await log(env, 'admin', source + ' user ' + id + ' deleted');
    return jsonResp({ ok: true });
  }

  return jsonResp({ ok: false, error: 'action not found' }, 404);
}

/* ============================ logs ============================ */

async function logs(env, url) {
  const limit = safeInt(url.searchParams.get('limit'), 100, 1, 200);
  const type = url.searchParams.get('type') || '';
  let rows = await getLogs(env, 200);
  if (type) rows = rows.filter((r) => r.type === type);
  return jsonResp({ ok: true, logs: rows.slice(0, limit), total: rows.length });
}

/* ============================ helpers ============================ */

export function adminLoginPageNeeded() {
  return true;
}
