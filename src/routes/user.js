// ============================================================
//  Technamooz AI — technamooz-ai-version1.0.0
//  Author: Amir Parsa (امیر پارسا)
//  src/routes/user.js — public web-chat API (SSE streaming)
// ============================================================

import { APP, LIMITS, PLATFORMS, platformList } from '../config.js';
import { PERSONAS } from '../personas.js';
import {
  hasDB, jsonResp, newUid, ensureProfile, getProfile, saveProfile,
  getMind, wipeMind, getSettings, rateLimit, log, bumpStat
} from '../store.js';
import { uidCookie, readCookie, isSecureRequest } from '../auth.js';
import {
  listModels, providerStatus, startCompletion, describeProviderError
} from '../providers.js';
import {
  resolveSelection, buildMessages, persistRound, allPublicPersonas,
  sanitizeUserText, isModelId, safePersona
} from '../chat.js';

/* ============================ entry ============================ */

export async function handleUserApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!hasDB(env)) {
    return jsonResp({
      ok: false,
      setup: true,
      message: 'KV namespace «DB» تنظیم نشده است. راهنمای نصب را در README ببینید.'
    }, 503);
  }

  try {
    if (path === '/health' && method === 'GET') return health(env);
    if (path === '/api/config' && method === 'GET') return getConfig(env);
    if (path === '/api/session' && (method === 'POST' || method === 'GET')) return getSession(request, env);
    if (path === '/api/personas' && method === 'GET') return getPersonas();
    if (path === '/api/models' && method === 'GET') return getModels(request, env, url);
    if (path === '/api/history' && method === 'GET') return getHistory(request, env);
    if (path === '/api/prefs' && method === 'POST') return setPrefs(request, env);
    if (path === '/api/reset' && method === 'POST') return resetMemory(request, env);
    if (path === '/api/feedback' && method === 'POST') return feedback(request, env);
    if (path === '/api/chat' && method === 'POST') return chat(request, env, ctx || {});

    return jsonResp({ ok: false, error: 'مسیر API پیدا نشد.' }, 404);
  } catch (e) {
    await log(env, 'error', 'user api ' + path + ': ' + String((e && e.message) || e).slice(0, 220));
    return jsonResp({ ok: false, error: 'خطای داخلی سرور. لطفاً دوباره تلاش کنید.' }, 500);
  }
}

/* ============================ basic ============================ */

async function health(env) {
  const status = await providerStatus(env);
  const providers = {};
  for (const [id, s] of Object.entries(status)) providers[id] = { ready: !!s.ready, label: s.label };
  return jsonResp({
    ok: true,
    app: APP.name,
    faName: APP.faName,
    version: APP.version,
    package: APP.package,
    author: APP.author,
    kv: hasDB(env),
    ai: !!env.AI,
    providers
  });
}

async function getConfig(env) {
  const settings = await getSettings(env);
  const status = await providerStatus(env);
  return jsonResp({
    ok: true,
    app: {
      name: APP.name,
      faName: APP.faName,
      version: APP.version,
      package: APP.package,
      author: APP.author,
      authorEn: APP.authorEn,
      tagline: APP.tagline,
      description: APP.description
    },
    social: APP.social,
    support: { url: APP.supportTelegram, handle: APP.supportHandle },
    platforms: platformList(),
    providers: status,
    settings: {
      siteTitle: settings.siteTitle,
      announcement: settings.announcement,
      memoryEnabled: settings.memoryEnabled,
      fallbackEnabled: settings.fallbackEnabled,
      maintenance: !!settings.maintenance,
      defaultPlatform: settings.defaultPlatform,
      defaultPersona: settings.defaultPersona,
      maxTokensNormal: settings.maxTokensNormal,
      maxTokensDeep: settings.maxTokensDeep
    },
    limits: {
      messageMaxChars: LIMITS.messageMaxChars,
      chatRateLimit: LIMITS.chatRateLimit
    }
  });
}

async function getPersonas() {
  return jsonResp({ ok: true, personas: allPublicPersonas() });
}

/* ============================ session ============================ */

function validUid(uid) {
  return typeof uid === 'string' && /^[a-f0-9]{16,64}$/i.test(uid);
}

async function webUser(request, env, settings) {
  const cookieUid = readCookie(request, 'tm_uid');
  const uid = validUid(cookieUid) ? cookieUid : newUid();
  const { profile, isNew } = await ensureProfile(env, 'web', uid, {
    platform: settings.defaultPlatform,
    model: settings.defaultModel[settings.defaultPlatform] || PLATFORMS[settings.defaultPlatform].defaultModel,
    persona: settings.defaultPersona,
    deep: false
  });
  return { uid, profile, isNew: isNew || uid !== cookieUid };
}

function prefs(profile, settings) {
  return {
    platform: PLATFORMS[profile.platform] ? profile.platform : settings.defaultPlatform,
    model: profile.model || settings.defaultModel[profile.platform] || '',
    persona: safePersona(profile.persona, settings.defaultPersona),
    deep: !!profile.deep,
    freeOnly: profile.freeOnly !== false,
    msgs: Number(profile.msgs) || 0,
    createdAt: profile.createdAt || 0
  };
}

async function getSession(request, env) {
  const settings = await getSettings(env);
  const { uid, profile, isNew } = await webUser(request, env, settings);
  const headers = {};
  if (isNew) headers['Set-Cookie'] = uidCookie(uid, isSecureRequest(request));
  return jsonResp({
    ok: true,
    uid,
    user: prefs(profile, settings),
    settings: {
      memoryEnabled: settings.memoryEnabled,
      fallbackEnabled: settings.fallbackEnabled,
      maintenance: !!settings.maintenance,
      announcement: settings.announcement,
      siteTitle: settings.siteTitle
    }
  }, 200, headers);
}

/* ============================ models ============================ */

async function getModels(request, env, url) {
  const settings = await getSettings(env);
  const requested = url.searchParams.get('platform') || settings.defaultPlatform;
  const platform = PLATFORMS[requested] ? requested : settings.defaultPlatform;
  const refresh = url.searchParams.get('refresh') === '1';

  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const limited = await rateLimit(env, 'models:' + ip, 80, 600);
  if (!limited.ok) return jsonResp({ ok: false, error: 'تعداد درخواست‌های لیست مدل زیاد است؛ کمی صبر کنید.' }, 429);

  try {
    const models = await listModels(env, platform, { refresh });
    const status = await providerStatus(env);
    return jsonResp({
      ok: true,
      platform,
      models,
      provider: status[platform],
      count: models.length
    });
  } catch (e) {
    return jsonResp({
      ok: false,
      platform,
      error: 'دریافت لیست مدل‌ها ناموفق بود: ' + String((e && e.message) || e).slice(0, 220),
      models: []
    }, 502);
  }
}

/* ============================ history / prefs ============================ */

async function getHistory(request, env) {
  const settings = await getSettings(env);
  const { uid, profile } = await webUser(request, env, settings);
  const mind = await getMind(env, 'web', uid);
  const rounds = mind.rounds.slice(-60).map((r) => ({
    q: r.q,
    a: r.a,
    t: r.t,
    p: r.p,
    pf: r.pf,
    m: r.m,
    deep: !!r.deep
  }));
  return jsonResp({
    ok: true,
    user: prefs(profile, settings),
    rounds,
    memory: {
      rounds: mind.rounds.length,
      hasSummary: !!mind.summary,
      facts: mind.facts.length
    }
  });
}

async function setPrefs(request, env) {
  const settings = await getSettings(env);
  const { uid, profile } = await webUser(request, env, settings);
  let body;
  try { body = await request.json(); } catch { return jsonResp({ ok: false, error: 'JSON نامعتبر است.' }, 400); }

  if (body.platform != null) {
    if (!PLATFORMS[body.platform]) return jsonResp({ ok: false, error: 'پلتفرم نامعتبر است.' }, 400);
    profile.platform = body.platform;
    if (body.model == null) {
      profile.model = settings.defaultModel[body.platform] || PLATFORMS[body.platform].defaultModel;
    }
  }
  if (body.model != null) {
    if (!isModelId(body.model)) return jsonResp({ ok: false, error: 'شناسهٔ مدل نامعتبر است.' }, 400);
    profile.model = String(body.model).trim();
  }
  if (body.persona != null) {
    if (!PERSONAS[body.persona]) return jsonResp({ ok: false, error: 'شخصیت نامعتبر است.' }, 400);
    profile.persona = body.persona;
  }
  if (body.deep != null) profile.deep = !!body.deep;
  if (body.freeOnly != null) profile.freeOnly = !!body.freeOnly;

  profile.lastSeen = Date.now();
  await saveProfile(env, 'web', uid, profile);
  return jsonResp({ ok: true, user: prefs(profile, settings) });
}

async function resetMemory(request, env) {
  const settings = await getSettings(env);
  const { uid, profile } = await webUser(request, env, settings);
  let body = {};
  try { body = await request.json(); } catch { /* default */ }
  const mode = ['chat', 'memory', 'all'].includes(body.mode) ? body.mode : 'all';
  await wipeMind(env, 'web', uid, mode);
  await log(env, 'user', 'web reset ' + mode + ' ' + uid.slice(0, 8));
  return jsonResp({ ok: true, mode, user: prefs(profile, settings) });
}

async function feedback(request, env) {
  const settings = await getSettings(env);
  const { uid } = await webUser(request, env, settings);
  let body;
  try { body = await request.json(); } catch { return jsonResp({ ok: false, error: 'JSON نامعتبر است.' }, 400); }
  const text = sanitizeUserText(body.text || '').slice(0, 2000);
  if (text.length < 2) return jsonResp({ ok: false, error: 'متن بازخورد خیلی کوتاه است.' }, 400);
  await bumpStat(env, 'feedbacks');
  await log(env, 'feedback', 'web ' + uid.slice(0, 8) + ': ' + text.slice(0, 400));
  return jsonResp({ ok: true, message: settings.feedbackPrompt || 'بازخورد شما ثبت شد ❤️' });
}

/* ============================ chat (SSE) ============================ */

async function chat(request, env, ctx) {
  const settings = await getSettings(env);
  const { uid, profile, isNew } = await webUser(request, env, settings);

  if (profile.banned) {
    return jsonResp({ ok: false, error: 'دسترسی شما مسدود شده است. با پشتیبانی تماس بگیرید.' }, 403);
  }
  if (settings.maintenance) {
    return jsonResp({ ok: false, error: 'تکناموز موقتاً در حال به‌روزرسانی است. لطفاً بعداً تلاش کنید.' }, 503);
  }

  let body;
  try { body = await request.json(); } catch { return jsonResp({ ok: false, error: 'JSON نامعتبر است.' }, 400); }

  const limited = await rateLimit(env, 'chat:' + uid, LIMITS.chatRateLimit, LIMITS.chatRateWindowSec);
  if (!limited.ok) {
    return jsonResp({ ok: false, error: 'تعداد پیام‌ها زیاد است. کمی صبر کنید و دوباره تلاش کنید.' }, 429);
  }

  const mind = await getMind(env, 'web', uid);
  const regenerate = !!body.regenerate;
  let userText = sanitizeUserText(body.message || '');
  let replaceLast = false;
  let historyMind = mind;

  if (regenerate) {
    const last = mind.rounds[mind.rounds.length - 1];
    if (!last || !last.q) return jsonResp({ ok: false, error: 'پیامی برای تولید دوباره وجود ندارد.' }, 400);
    userText = String(last.q).slice(0, LIMITS.messageMaxChars);
    replaceLast = true;
    historyMind = { ...mind, rounds: mind.rounds.slice(0, -1) };
  }

  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 2) : [];
  const imageParts = [];
  let attachmentBytes = 0;
  for (const item of attachments) {
    if (!item || !['image/png', 'image/jpeg', 'image/webp'].includes(String(item.type || ''))) {
      return jsonResp({ ok: false, error: 'نوع فایل تصویری پشتیبانی نمی‌شود.' }, 400);
    }
    const data = String(item.data || '');
    const prefix = 'data:' + item.type + ';base64,';
    if (!data.startsWith(prefix) || data.length > 2800000) {
      return jsonResp({ ok: false, error: 'فایل تصویر نامعتبر یا بیش از حد بزرگ است.' }, 400);
    }
    attachmentBytes += data.length;
    imageParts.push({ type: 'image_url', image_url: { url: data } });
  }
  if (attachmentBytes > 5200000) {
    return jsonResp({ ok: false, error: 'مجموع حجم تصاویر بیش از حد مجاز است.' }, 413);
  }
  if (!userText && !imageParts.length) return jsonResp({ ok: false, error: 'متن پیام خالی است.' }, 400);
  if (!userText && imageParts.length) userText = 'لطفاً تصویر پیوست‌شده را تحلیل کن.';
  if (userText.length > LIMITS.messageMaxChars) {
    return jsonResp({ ok: false, error: 'متن پیام خیلی طولانی است.' }, 400);
  }

  const selection = resolveSelection({
    platform: body.platform || profile.platform,
    model: body.model || profile.model,
    persona: body.persona || profile.persona,
    deep: body.deep != null ? body.deep : profile.deep
  }, settings);

  if (!isModelId(selection.model)) {
    return jsonResp({ ok: false, error: 'شناسهٔ مدل نامعتبر است.' }, 400);
  }

  if (imageParts.length && selection.platform === 'workersai') {
    return jsonResp({ ok: false, error: 'برای تحلیل تصویر، یک مدل بینایی از OpenRouter یا سرویس‌دهندهٔ سازگار انتخاب کن؛ Workers AI فعلی این مسیر را پشتیبانی نمی‌کند.' }, 400);
  }
  const userContent = imageParts.length
    ? [{ type: 'text', text: userText || 'لطفاً تصویر پیوست‌شده را تحلیل کن.' }, ...imageParts]
    : null;
  const messages = buildMessages({
    persona: selection.persona,
    mind: historyMind,
    userText: userText || 'تصویر پیوست‌شده را تحلیل کن.',
    userContent,
    settings,
    deep: selection.deep
  });

  let started;
  try {
    started = await startCompletion(env, {
      ...selection,
      messages,
      allowFallback: true
    });
  } catch (e) {
    await log(env, 'error', 'web chat start: ' + String((e && e.message) || e).slice(0, 220));
    return jsonResp({ ok: false, error: describeProviderError(e) }, 502);
  }

  const headers = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  };
  if (isNew) headers['Set-Cookie'] = uidCookie(uid, isSecureRequest(request));

  const stream = sseSource(env, ctx, started, {
    uid,
    profile,
    settings,
    selection,
    userText,
    historyMind,
    replaceLast
  });

  return new Response(stream, { status: 200, headers });
}

function sseSource(env, ctx, started, data) {
  const encoder = new TextEncoder();
  const reader = started.stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let reasoning = '';
  let error = '';
  let closed = false;
  let heartbeat = null;

  function frame(obj) {
    if (closed) return;
    try { controllerRef.enqueue(encoder.encode('data: ' + JSON.stringify(obj) + '\n\n')); } catch { /* closed */ }
  }
  let controllerRef = null;

  return new ReadableStream({
    async start(controller) {
      controllerRef = controller;
      heartbeat = setInterval(() => frame({ type: 'ping', t: Date.now() }), 15000);
      frame({
        type: 'meta',
        app: APP.name,
        version: APP.version,
        platform: started.used.platform,
        model: started.used.model,
        persona: data.selection.personaId,
        deep: data.selection.deep,
        fallback: !!started.fallback,
        fallbackFrom: started.fallback ? data.selection.platform : null
      });

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            let f;
            try { f = JSON.parse(line); } catch { continue; }
            if (f.type === 'delta' && f.v) {
              answer += f.v;
              frame({ type: 'delta', v: f.v });
            } else if (f.type === 'reasoning' && f.v) {
              reasoning += f.v;
              frame({ type: 'reasoning', v: f.v });
            } else if (f.type === 'error' && f.msg) {
              error = String(f.msg).slice(0, 400);
              frame({ type: 'error', msg: error });
            }
          }
        }
        if (buffer.trim()) {
          try {
            const f = JSON.parse(buffer.trim());
            if (f.type === 'delta' && f.v) { answer += f.v; frame({ type: 'delta', v: f.v }); }
            if (f.type === 'error' && f.msg) { error = String(f.msg).slice(0, 400); frame({ type: 'error', msg: error }); }
          } catch { /* ignore */ }
        }

        if (!answer.trim() && reasoning.trim()) {
          answer = reasoning.trim();
          frame({ type: 'delta', v: answer });
        }
        if (!answer.trim() && !error) error = 'مدل پاسخی برنگرداند. مدل دیگری انتخاب کنید.';

        let persisted = false;
        if (!error && answer.trim()) {
          frame({ type: 'saving' });
          try {
            await persistRound(env, 'web', data.uid, {
              userText: data.userText,
              answerText: answer,
              personaId: data.selection.personaId,
              platform: started.used.platform,
              model: started.used.model,
              deep: data.selection.deep,
              settings: data.settings,
              mind: data.historyMind,
              replaceLast: data.replaceLast
            });
            data.profile.msgs = (Number(data.profile.msgs) || 0) + 1;
            data.profile.lastSeen = Date.now();
            data.profile.platform = started.used.platform;
            data.profile.model = started.used.model;
            data.profile.persona = data.selection.personaId;
            data.profile.deep = data.selection.deep;
            await saveProfile(env, 'web', data.uid, data.profile);
            await bumpStat(env, 'web_msgs');
            persisted = true;
          } catch (e) {
            await log(env, 'warn', 'web persist: ' + String((e && e.message) || e).slice(0, 200));
          }
        }

        frame({
          type: 'done',
          ok: !error,
          chars: answer.length,
          reasoningChars: reasoning.length,
          persisted,
          fallback: !!started.fallback,
          platform: started.used.platform,
          model: started.used.model
        });
      } catch (e) {
        await log(env, 'error', 'web stream: ' + String((e && e.message) || e).slice(0, 220));
        frame({ type: 'error', msg: describeProviderError(e) });
        frame({ type: 'done', ok: false, chars: answer.length, persisted: false });
      } finally {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch { /* ignore */ }
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      try { reader.cancel(); } catch { /* ignore */ }
    }
  });
}
