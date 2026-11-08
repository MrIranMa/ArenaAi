// ============================================================
//  ArenaAi — ArenaAi-v1.0.0
//  Author: ArenaAi
//  src/routes/user.js — public web-chat API (SSE streaming)
// ============================================================

import { APP, LIMITS, PLATFORMS, platformList } from '../config.js';
import { PERSONAS } from '../personas.js';
import {
  hasDB, jsonResp, newUid, ensureProfile, getProfile, saveProfile,
  getMind, wipeMind, getSettings, rateLimit, log, bumpStat
} from '../store.js';
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
    if (path === '/api/personas' && method === 'GET') return getPersonas();
    if (path === '/api/models' && method === 'GET') return getModels(request, env, url);

    if (path === '/api/session' && (method === 'POST' || method === 'GET')) return getSession(request, env);
    if (path === '/api/history' && method === 'GET') return getHistory(request, env);
    if (path === '/api/prefs' && method === 'POST') return setPrefs(request, env);
    if (path === '/api/reset' && method === 'POST') return resetMemory(request, env);
    if (path === '/api/feedback' && method === 'POST') return feedback(request, env);
    if (path === '/api/chat' && method === 'POST') return chat(request, env, ctx || {});
    if (path === '/api/project' && method === 'POST') return buildProject(request, env);
    if (path === '/api/search' && method === 'GET') return webSearchApi(request, env, url);
    if (path === '/api/image' && method === 'POST') return generateImage(request, env);

    return jsonResp({ ok: false, error: 'مسیر API پیدا نشد.' }, 404);
  } catch (e) {
    await log(env, 'error', 'user api ' + path + ': ' + String((e && e.message) || e).slice(0, 220));
    return jsonResp({ ok: false, error: 'خطای داخلی سرور. لطفاً دوباره تلاش کنید.' }, 500);
  }
}

/* ============================ free web search ============================ */

function decodeSearchHtml(value) {
  return String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function searchWeb(query) {
  const q = String(query || '').trim().slice(0, 240);
  if (!q) return [];
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
  const response = await fetch(url, {
    headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; ArenaAi/1.0; +https://workers.dev)' },
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) throw new Error('جست‌وجوی وب فعلاً پاسخ نمی‌دهد.');
  const html = await response.text();
  const results = [];
  const blocks = html.match(/<div class="result[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi) || [];
  for (const block of blocks) {
    const a = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const s = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    if (!a) continue;
    let href = decodeSearchHtml(a[1]);
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch { /* keep original */ } }
    if (!/^https?:\/\//i.test(href)) continue;
    results.push({
      title: decodeSearchHtml(a[2]).slice(0, 180),
      url: href.slice(0, 1000),
      snippet: decodeSearchHtml((s && (s[1] || s[2])) || '').slice(0, 360)
    });
    if (results.length >= 5) break;
  }
  return results;
}

async function webSearchApi(request, env, url) {
  const settings = await getSettings(env);
  const { uid, profile } = await webUser(request, env, settings);
  if (profile.banned) return jsonResp({ ok: false, error: 'دسترسی شما مسدود شده است.' }, 403);
  const query = String(url.searchParams.get('q') || '').trim();
  if (query.length < 2) return jsonResp({ ok: false, error: 'عبارت جست‌وجو کوتاه است.' }, 400);
  const limited = await rateLimit(env, 'search:' + uid, 10, 600);
  if (!limited.ok) return jsonResp({ ok: false, error: 'سقف جست‌وجوی رایگان موقتاً پر شده است.' }, 429);
  try {
    const results = await searchWeb(query);
    await bumpStat(env, 'web_searches');
    return jsonResp({ ok: true, query, results });
  } catch (error) {
    await log(env, 'error', 'web search: ' + String(error.message || error).slice(0, 180));
    return jsonResp({ ok: false, error: 'جست‌وجوی وب در دسترس نیست؛ کمی بعد دوباره تلاش کن.' }, 502);
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

function guestUid(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)arenaai_guest=([a-f0-9]{32})(?:;|$)/i);
  return match ? match[1].toLowerCase() : '';
}

async function webUser(request, env, settings) {
  const uid = guestUid(request) || newUid();
  const { profile } = await ensureProfile(env, 'web', uid, {
    platform: settings.defaultPlatform,
    model: settings.defaultModel[settings.defaultPlatform] || PLATFORMS[settings.defaultPlatform].defaultModel,
    persona: settings.defaultPersona,
    deep: false
  });
  return { uid, profile, isNew: false, account: null };
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
  const uid = guestUid(request) || newUid();
  const { profile } = await ensureProfile(env, 'web', uid, {
    platform: settings.defaultPlatform,
    model: settings.defaultModel[settings.defaultPlatform] || PLATFORMS[settings.defaultPlatform].defaultModel,
    persona: settings.defaultPersona,
    deep: false
  });
  const headers = {
    'Set-Cookie': 'arenaai_guest=' + uid + '; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax'
  };
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

/* ============================ image generation ============================ */

async function generateImage(request, env) {
  const { uid, profile } = await webUser(request, env, await getSettings(env));
  if (profile.banned) return jsonResp({ ok: false, error: 'دسترسی شما مسدود شده است.' }, 403);
  if (!env.AI || typeof env.AI.run !== 'function') {
    return jsonResp({ ok: false, error: 'اتصال Cloudflare Workers AI فعال نیست. ابتدا AI Binding را در تنظیمات Worker فعال کن.' }, 503);
  }
  let body;
  try { body = await request.json(); } catch { return jsonResp({ ok: false, error: 'درخواست JSON معتبر نیست.' }, 400); }
  const prompt = sanitizeUserText(body.prompt || '');
  if (prompt.length < 3 || prompt.length > 1200) {
    return jsonResp({ ok: false, error: 'توضیح تصویر باید بین ۳ تا ۱۲۰۰ نویسه باشد.' }, 400);
  }
  const limited = await rateLimit(env, 'image:' + uid, 3, 3600);
  if (!limited.ok) return jsonResp({ ok: false, error: 'سهمیهٔ ساخت تصویر پر شده است؛ یک ساعت دیگر دوباره تلاش کن.' }, 429);
  try {
    const result = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt });
    const encoded = result && (result.image || result.data && result.data[0]);
    if (!encoded || typeof encoded !== 'string') {
      throw new Error('مدل تصویر خروجی Base64 معتبر برنگرداند.');
    }
    await bumpStat(env, 'image_generations');
    await log(env, 'image', 'web ' + uid.slice(0, 8) + ' generated an image');
    return jsonResp({ ok: true, image: 'data:image/jpeg;base64,' + encoded });
  } catch (error) {
    await log(env, 'error', 'image generation: ' + String((error && error.message) || error).slice(0, 220));
    return jsonResp({ ok: false, error: 'ساخت تصویر انجام نشد؛ دسترسی مدل FLUX در Cloudflare Workers AI را بررسی کن.' }, 502);
  }
}

/* ============================ project builder ============================ */
async function buildProject(request, env) {
  const settings = await getSettings(env);
  const { uid, profile } = await webUser(request, env, settings);
  if (profile.banned) return jsonResp({ ok: false, error: 'دسترسی شما مسدود شده است.' }, 403);
  if (settings.maintenance) return jsonResp({ ok: false, error: 'سرویس در حالت تعمیر است.' }, 503);
  let body;
  try { body = await request.json(); } catch { return jsonResp({ ok: false, error: 'درخواست نامعتبر است.' }, 400); }
  const prompt = sanitizeUserText(body.prompt || '');
  if (prompt.length < 8 || prompt.length > 7000) return jsonResp({ ok: false, error: 'شرح پروژه باید بین ۸ تا ۷۰۰۰ نویسه باشد.' }, 400);
  const limited = await rateLimit(env, 'project:' + uid, 2, 3600);
  if (!limited.ok) return jsonResp({ ok: false, error: 'سهمیه ساخت پروژه پر شده است؛ یک ساعت دیگر دوباره تلاش کن.' }, 429);
  const selection = resolveSelection({
    platform: body.platform || profile.platform, model: body.model || profile.model,
    persona: body.persona || profile.persona, deep: body.deep != null ? body.deep : profile.deep
  }, settings);
  if (!isModelId(selection.model)) return jsonResp({ ok: false, error: 'مدل انتخاب‌شده معتبر نیست.' }, 400);
  const system = [
    'You are ArenaAi Project Builder. Build complete, runnable software projects.',
    'Return ONLY one valid JSON object with schema {"name":"project name","summary":"summary","files":[{"path":"relative/path","content":"complete file text"}]}.',
    'Include every required source, config, and documentation file. No placeholders, TODOs, ellipses, or missing essential code.',
    'Use relative paths only. Never create absolute paths, ../ segments, secrets, .env credentials, binaries, or node_modules.',
    'Maximum 35 files and 450000 total source characters. Include README with exact run instructions.',
    'Make sensible assumptions and deliver the best complete implementation without asking questions.',
    'The selected model must perform the entire implementation. Do not delegate.'
  ].join('\n');
  let started;
  try {
    started = await startCompletion(env, {
      ...selection,
      messages: [{ role: 'system', content: system }, { role: 'user', content: 'Build this project completely:\n\n' + prompt }],
      maxTokens: 12000, temperature: 0.2, allowFallback: false
    });
  } catch (e) {
    await log(env, 'error', 'project start: ' + String((e && e.message) || e).slice(0, 200));
    return jsonResp({ ok: false, error: describeProviderError(e) }, 502);
  }
  try {
    const reader = started.stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '', answer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let frame; try { frame = JSON.parse(line); } catch { continue; }
        if (frame.type === 'delta' && frame.v) {
          answer += frame.v;
          if (answer.length > 600000) throw new Error('خروجی پروژه بیش از حد بزرگ شد.');
        }
        if (frame.type === 'error') throw new Error(frame.msg || 'مدل در ساخت پروژه خطا داد.');
      }
    }
    if (buffer.trim()) {
      try {
        const frame = JSON.parse(buffer.trim());
        if (frame.type === 'delta' && frame.v) answer += frame.v;
        if (frame.type === 'error') throw new Error(frame.msg || 'مدل خطا داد.');
      } catch (e) { if (e && e.message && e.message !== 'Unexpected end of JSON input') throw e; }
    }
    const clean = answer.trim().replace(/^\x60{3}(?:json)?\s*/i, '').replace(/\s*\x60{3}$/, '');
    const first = clean.indexOf('{'), last = clean.lastIndexOf('}');
    if (first < 0 || last <= first) throw new Error('مدل خروجی JSON کامل نساخت؛ با شرح کوتاه‌تر دوباره تلاش کن.');
    const project = JSON.parse(clean.slice(first, last + 1));
    if (!Array.isArray(project.files) || !project.files.length || project.files.length > 35) throw new Error('ساختار فایل‌های پروژه معتبر نیست.');
    let total = 0;
    const seen = new Set(), files = [];
    for (const file of project.files) {
      const path = String(file && file.path || '').replace(/\\/g, '/').trim();
      const text = String(file && file.content != null ? file.content : '');
      if (!path || path.length > 180 || path.startsWith('/') || /^[a-z]:/i.test(path) ||
          path.split('/').some(part => !part || part === '.' || part === '..') ||
          /[\u0000-\u001f]/.test(path) || seen.has(path)) throw new Error('مسیر فایل نامعتبر یا تکراری است: ' + path.slice(0, 80));
      if (text.length > 100000) throw new Error('یکی از فایل‌ها بیش از حد بزرگ است: ' + path);
      total += text.length;
      if (total > 450000) throw new Error('حجم کل پروژه بیش از حد مجاز است.');
      seen.add(path); files.push({ path, content: text });
    }
    if (!files.some(f => /(^|\/)readme(?:\.md)?$/i.test(f.path))) {
      files.push({ path: 'README.md', content: '# ' + String(project.name || 'ArenaAi Project') + '\n\n' + String(project.summary || 'پروژه ساخته‌شده با ArenaAi') + '\n' });
    }
    await bumpStat(env, 'project_builds');
    await log(env, 'project', 'web ' + uid.slice(0, 8) + ' built ' + files.length + ' files using ' + started.used.platform + '/' + started.used.model);
    return jsonResp({ ok: true, name: String(project.name || 'ArenaAi Project').slice(0, 100),
      summary: String(project.summary || '').slice(0, 1000), files,
      model: started.used.model, platform: started.used.platform });
  } catch (e) {
    await log(env, 'error', 'project parse: ' + String((e && e.message) || e).slice(0, 220));
    return jsonResp({ ok: false, error: String((e && e.message) || 'ساخت پروژه ناموفق بود.').slice(0, 500) }, 502);
  }
}

/* ============================ chat (SSE) ============================ */

async function chat(request, env, ctx) {
  const settings = await getSettings(env);
  const { uid, profile, isNew } = await webUser(request, env, settings);

  if (profile.banned) {
    return jsonResp({ ok: false, error: 'دسترسی شما مسدود شده است. با پشتیبانی تماس بگیرید.' }, 403);
  }
  if (settings.maintenance) {
    return jsonResp({ ok: false, error: 'آرنا ای‌آی موقتاً در حال به‌روزرسانی است. لطفاً بعداً تلاش کنید.' }, 503);
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
      allowFallback: imageParts.length === 0
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
            await bumpStat(env, 'usage_' + started.used.platform);
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
