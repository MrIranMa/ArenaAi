// ============================================================
//  ArenaAi — ArenaAi-v1.0.0
//  Author: ArenaAi
//  src/telegram.js — complete Telegram bot:
//  models, personalities, deep mode, memory, support, social links
// ============================================================

import { APP, PLATFORMS, PLATFORM_ORDER, LIMITS } from './config.js';
import { PERSONAS, PERSONA_ORDER } from './personas.js';
import {
  getSettings, getMind, wipeMind, ensureProfile, saveProfile,
  getTgBot, getTgAdmins, log, bumpStat, rateLimit, jsonResp
} from './store.js';
import {
  listModels, providerStatus, startCompletion, describeProviderError
} from './providers.js';
import {
  resolveSelection, buildMessages, persistRound, safePersona, sanitizeUserText, isModelId
} from './chat.js';
import {
  tgSendMessage, tgEditMessageText, tgAnswerCallback, tgSendChatAction,
  randomSecret, splitText
} from './tgapi.js';

const PAGE_SIZE = 6;
const PICKER_TTL = 900;

/* ============================ webhook entry ============================ */

export async function handleTelegram(request, env, ctx, url) {
  const bot = await getTgBot(env);
  if (!bot.token) return jsonResp({ ok: false, error: 'telegram bot not configured' }, 200);

  // Verify the secret in the path and (when present) the Telegram header.
  if (bot.secret) {
    const parts = String(url.pathname).split('/').filter(Boolean);
    const pathSecret = parts[parts.length - 1] || '';
    if (pathSecret !== bot.secret) return jsonResp({ ok: false, error: 'not found' }, 404);
    const headerSecret = request.headers.get('x-telegram-bot-api-secret-token');
    if (headerSecret && headerSecret !== bot.secret) return jsonResp({ ok: false, error: 'forbidden' }, 403);
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return jsonResp({ ok: false, error: 'bad json' }, 400);
  }

  try {
    await processUpdate(env, ctx, update, bot);
  } catch (e) {
    await log(env, 'error', 'telegram: ' + String((e && e.message) || e).slice(0, 220));
  }
  return jsonResp({ ok: true });
}

/* ============================ update routing ============================ */

async function processUpdate(env, ctx, update, bot) {
  if (update && update.callback_query) return handleCallback(env, ctx, update.callback_query, bot);
  if (update && update.message) return handleMessage(env, ctx, update.message, bot);
}

async function handleMessage(env, ctx, msg, bot) {
  const chat = msg.chat || {};
  if (chat.type !== 'private') {
    await send(env, chat.id, 'برای حفظ حریم خصوصی و حافظهٔ اختصاصی، لطفاً ربات را در چت خصوصی (@' + (bot.username || '') + ') استفاده کنید.');
    return;
  }
  if (msg.from && msg.from.is_bot) return;

  const chatId = chat.id;
  const from = msg.from || {};
  const settings = await getSettings(env);
  const admins = await getTgAdmins(env);
  const isAdmin = admins.includes(Number(chatId));

  if (settings.maintenance && !isAdmin) {
    await send(env, chatId, '🛠 تکناموز موقتاً در حال به‌روزرسانی است. لطفاً چند دقیقهٔ دیگر دوباره تلاش کنید.');
    return;
  }

  const { profile } = await ensureProfile(env, 'tg', chatId, {
    name: [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 80),
    username: from.username || '',
    platform: settings.defaultPlatform,
    model: settings.defaultModel[settings.defaultPlatform] || PLATFORMS[settings.defaultPlatform].defaultModel,
    persona: settings.defaultPersona,
    deep: false,
    msgs: 0
  });

  if (profile.banned) {
    await send(env, chatId, '⛔️ دسترسی شما به تکناموز مسدود شده است. برای پیگیری به پشتیبانی پیام دهید: ' + APP.supportHandle);
    return;
  }

  const text = String(msg.text || '').trim();
  if (!text) {
    await send(env, chatId, 'فقط پیام متنی پشتیبانی می‌شود. متن سؤالت را بنویس یا از /help استفاده کن.');
    return;
  }

  if (text.startsWith('/')) {
    return handleCommand(env, ctx, msg, text, profile, settings, bot, isAdmin);
  }

  const limited = await rateLimit(env, 'tg:' + chatId, 30, 600);
  if (!limited.ok) {
    await send(env, chatId, '⏳ کمی سریع پیش می‌روی! چند دقیقهٔ دیگر دوباره پیام بده.');
    return;
  }

  await chatAnswer(env, ctx, chatId, text, profile, settings, bot);
}

async function handleCommand(env, ctx, msg, raw, profile, settings, bot, isAdmin) {
  const chatId = msg.chat.id;
  const parts = raw.split(/\s+/);
  const cmd = (parts[0] || '').replace(/@.*$/, '').toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  switch (cmd) {
    case '/start':
      await sendStart(env, chatId, profile, bot);
      return;

    case '/help':
      await sendHelp(env, chatId);
      return;

    case '/models':
    case '/model':
      if (args) {
        await searchModels(env, chatId, profile, args);
      } else {
        await sendPlatformPicker(env, chatId, profile);
      }
      return;

    case '/persona':
    case '/personality':
      if (args) {
        const id = safePersona(args, '');
        if (PERSONAS[id]) {
          profile.persona = id;
          await saveProfile(env, 'tg', chatId, profile);
          await sendPersonaSelected(env, chatId, profile, id);
        } else {
          await send(env, chatId, 'شخصیت پیدا نشد. از /persona لیست را ببین.');
        }
      } else {
        await sendPersonaPicker(env, chatId, profile);
      }
      return;

    case '/deep': {
      const on = args ? /^(on|1|true|روشن|بله)$/i.test(args) : !profile.deep;
      profile.deep = on;
      await saveProfile(env, 'tg', chatId, profile);
      await send(env, chatId, on
        ? '🧠 حالت «نهایت قدرت» روشن شد. پاسخ‌ها برای سؤال‌های سنگین کامل‌تر و عمیق‌تر خواهند بود.'
        : '⚡️ حالت «نهایت قدرت» خاموش شد. پاسخ‌ها متناسب با سؤال، کوتاه‌تر می‌شوند.');
      return;
    }

    case '/new':
      await wipeMind(env, 'tg', chatId, 'chat');
      await send(env, chatId, '🆕 گفتگوی جدید شروع شد. حافظهٔ بلندمدت و شخصیت فعلی حفظ شدند.');
      return;

    case '/reset':
      await sendResetConfirm(env, chatId);
      return;

    case '/settings':
    case '/setting':
      await sendSettings(env, chatId, profile, settings);
      return;

    case '/support':
      await sendSupport(env, chatId);
      return;

    case '/social':
      await sendSocial(env, chatId);
      return;

    case '/about':
      await sendAbout(env, chatId);
      return;

    case '/status':
      await sendStatus(env, chatId);
      return;

    case '/memory':
      await sendMemory(env, chatId);
      return;

    case '/feedback':
      if (!args) {
        await send(env, chatId, 'بازخوردت را بعد از دستور بنویس:\n/feedback متن بازخورد');
        return;
      }
      await bumpStat(env, 'feedbacks');
      await log(env, 'feedback', 'TG ' + chatId + ': ' + args.slice(0, 300));
      await send(env, chatId, settings.feedbackPrompt || 'بازخوردت ثبت شد ❤️');
      return;

    case '/adminstats':
      if (!isAdmin) {
        await send(env, chatId, '⛔️ این دستور فقط برای مدیر است.');
        return;
      }
      await sendStatus(env, chatId, true);
      return;

    default:
      await send(env, chatId, 'دستور ناشناخته. /help را ببین یا فقط سؤالت را بنویس.');
  }
}

/* ============================ chat ============================ */

async function chatAnswer(env, ctx, chatId, userText, profile, settings, bot) {
  const selection = resolveSelection({
    platform: profile.platform,
    persona: profile.persona,
    model: profile.model,
    deep: profile.deep
  }, settings);

  const mind = await getMind(env, 'tg', chatId);
  const messages = buildMessages({
    persona: selection.persona,
    mind,
    userText: sanitizeUserText(userText),
    settings,
    deep: selection.deep
  });

  const stopTyping = startTyping(bot.token, chatId);
  try {
    const result = await startCompletion(env, {
      ...selection,
      messages,
      allowFallback: true
    });

    const collected = await collectStream(result.stream);
    if (collected.error && !collected.text) throw new Error(collected.error);
    if (!collected.text.trim()) {
      throw new Error(collected.error || 'پاسخی از مدل دریافت نشد.');
    }

    if (result.fallback) {
      await send(env, chatId, '⚠️ مدل انتخابی در دسترس نبود؛ با مدل جایگزین پاسخ می‌دهم.');
    }

    const header = selection.deep ? '🧠 ' : '';
    await send(env, chatId, header + collected.text.trim());

    await persistRound(env, 'tg', chatId, {
      userText,
      answerText: collected.text,
      personaId: selection.personaId,
      platform: result.used.platform,
      model: result.used.model,
      deep: selection.deep,
      settings,
      mind
    });

    profile.msgs = (Number(profile.msgs) || 0) + 1;
    profile.lastSeen = Date.now();
    profile.platform = result.used.platform;
    profile.model = result.used.model;
    await saveProfile(env, 'tg', chatId, profile);
    await bumpStat(env, 'tg_msgs');
    if (collected.error) await log(env, 'warn', 'tg partial: ' + collected.error.slice(0, 180));
  } catch (e) {
    await log(env, 'error', 'tg chat: ' + String((e && e.message) || e).slice(0, 240));
    await send(env, chatId, describeProviderError(e));
  } finally {
    stopTyping();
  }
}

function startTyping(token, chatId) {
  let active = true;
  let timer = null;
  const tick = async () => {
    if (!active) return;
    await tgSendChatAction(token, chatId, 'typing');
    if (!active) return;
    timer = setTimeout(tick, 4500);
  };
  tick();
  return () => {
    active = false;
    if (timer) clearTimeout(timer);
  };
}

async function collectStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let error = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const frame = JSON.parse(line);
        if (frame.type === 'delta' && frame.v) text += frame.v;
        else if (frame.type === 'reasoning' && frame.v) reasoning += frame.v;
        else if (frame.type === 'error' && frame.msg) error = frame.msg;
      } catch { /* ignore */ }
    }
  }
  if (buffer.trim()) {
    try {
      const frame = JSON.parse(buffer.trim());
      if (frame.type === 'delta' && frame.v) text += frame.v;
      else if (frame.type === 'reasoning' && frame.v) reasoning += frame.v;
      else if (frame.type === 'error' && frame.msg) error = frame.msg;
    } catch { /* ignore */ }
  }
  if (!text.trim() && reasoning.trim()) text = reasoning.trim();
  return { text, reasoning, error };
}

/* ============================ callbacks ============================ */

async function handleCallback(env, ctx, cq, bot) {
  const data = String(cq.data || '');
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const messageId = cq.message && cq.message.message_id;
  const from = cq.from || {};
  if (!chatId) return;

  const settings = await getSettings(env);
  const { profile } = await ensureProfile(env, 'tg', chatId, {
    name: [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 80),
    username: from.username || '',
    platform: settings.defaultPlatform,
    model: settings.defaultModel[settings.defaultPlatform] || PLATFORMS[settings.defaultPlatform].defaultModel,
    persona: settings.defaultPersona,
    deep: false
  });

  if (profile.banned) {
    await tgAnswerCallback(bot.token, cq.id, 'دسترسی شما مسدود است.', true);
    return;
  }

  try {
    if (data.startsWith('pf:')) {
      const platform = data.slice(3);
      if (!PLATFORMS[platform]) throw new Error('platform');
      await tgAnswerCallback(bot.token, cq.id, 'در حال بارگذاری مدل‌ها…');
      await sendModelPicker(env, chatId, profile, platform);
      return;
    }

    if (data.startsWith('mdl:')) {
      const index = parseInt(data.slice(4), 10);
      const snap = await readPicker(env, chatId);
      if (!snap || !snap.view || !snap.view[index]) {
        await tgAnswerCallback(bot.token, cq.id, 'لیست منقضی شده؛ دوباره /models را بزن.', true);
        return;
      }
      const chosen = snap.view[index];
      profile.platform = snap.platform;
      profile.model = chosen.id;
      await saveProfile(env, 'tg', chatId, profile);
      await tgAnswerCallback(bot.token, cq.id, 'مدل انتخاب شد ✓');
      if (messageId) {
        await tgEditMessageText(bot.token, chatId, messageId,
          '✅ مدل انتخاب شد:\n' + chosen.name + '\n\n' + chosen.id +
          '\n\nحالا سؤالت را بنویس. برای تغییر شخصیت /persona را بزن.');
      }
      return;
    }

    if (data.startsWith('pg:')) {
      const snap = await readPicker(env, chatId);
      if (!snap) {
        await tgAnswerCallback(bot.token, cq.id, 'لیست منقضی شده؛ دوباره /models را بزن.', true);
        return;
      }
      snap.page = Math.max(0, (Number(snap.page) || 0) + parseInt(data.slice(3), 10));
      await writePicker(env, chatId, snap);
      const rendered = renderPicker(snap);
      await tgAnswerCallback(bot.token, cq.id, '');
      if (messageId) await tgEditMessageText(bot.token, chatId, messageId, rendered.text, { replyMarkup: rendered.keyboard });
      return;
    }

    if (data === 'flt') {
      const snap = await readPicker(env, chatId);
      if (!snap) {
        await tgAnswerCallback(bot.token, cq.id, 'لیست منقضی شده؛ دوباره /models را بزن.', true);
        return;
      }
      const next = !snap.freeOnly;
      const view = next ? snap.models.filter((m) => m.free) : snap.models;
      if (!view.length) {
        await tgAnswerCallback(bot.token, cq.id, 'برای این پلتفرم مدل رایگان در لیست نیست.', true);
        return;
      }
      snap.freeOnly = next;
      snap.view = view;
      snap.page = 0;
      await writePicker(env, chatId, snap);
      const rendered = renderPicker(snap);
      await tgAnswerCallback(bot.token, cq.id, next ? 'فقط مدل‌های رایگان' : 'همهٔ مدل‌ها');
      if (messageId) await tgEditMessageText(bot.token, chatId, messageId, rendered.text, { replyMarkup: rendered.keyboard });
      return;
    }

    if (data === 'rfr') {
      const snap = await readPicker(env, chatId);
      if (!snap) {
        await tgAnswerCallback(bot.token, cq.id, 'لیست منقضی شده؛ دوباره /models را بزن.', true);
        return;
      }
      await tgAnswerCallback(bot.token, cq.id, 'در حال بروزرسانی…');
      try {
        const models = await listModels(env, snap.platform, { refresh: true });
        await createPicker(env, chatId, snap.platform, models, snap.freeOnly);
        const fresh = await readPicker(env, chatId);
        const rendered = renderPicker(fresh);
        if (messageId) await tgEditMessageText(bot.token, chatId, messageId, rendered.text, { replyMarkup: rendered.keyboard });
      } catch (e) {
        if (messageId) await tgEditMessageText(bot.token, chatId, messageId, '⚠️ بروزرسانی مدل‌ها ناموفق بود:\n' + String(e.message || e).slice(0, 200));
      }
      return;
    }

    if (data === 'close') {
      await tgAnswerCallback(bot.token, cq.id, 'بسته شد');
      if (messageId) await tgEditMessageText(bot.token, chatId, messageId, 'پنجره بسته شد. هر وقت خواستی /models یا /persona را بزن.');
      return;
    }

    if (data.startsWith('per:')) {
      const id = data.slice(4);
      if (!PERSONAS[id]) {
        await tgAnswerCallback(bot.token, cq.id, 'شخصیت پیدا نشد.', true);
        return;
      }
      profile.persona = id;
      await saveProfile(env, 'tg', chatId, profile);
      await tgAnswerCallback(bot.token, cq.id, 'شخصیت انتخاب شد ✓');
      await sendPersonaSelected(env, chatId, profile, id);
      return;
    }

    if (data.startsWith('rec:')) {
      const id = data.slice(4);
      const persona = PERSONAS[id];
      if (!persona) return;
      const rec = persona.recommended[profile.platform] || persona.recommended[settings.defaultPlatform];
      if (!rec) {
        await tgAnswerCallback(bot.token, cq.id, 'برای این پلتفرم مدل پیشنهادی ثبت نشده.', true);
        return;
      }
      profile.model = rec;
      await saveProfile(env, 'tg', chatId, profile);
      await tgAnswerCallback(bot.token, cq.id, 'مدل پیشنهادی انتخاب شد ✓');
      await send(env, chatId, '✅ برای شخصیت «' + persona.name + '» مدل پیشنهادی انتخاب شد:\n' + rec);
      return;
    }

    if (data === 'deep:toggle') {
      profile.deep = !profile.deep;
      await saveProfile(env, 'tg', chatId, profile);
      await tgAnswerCallback(bot.token, cq.id, profile.deep ? 'حالت نهایت قدرت روشن شد' : 'حالت نهایت قدرت خاموش شد');
      await sendSettings(env, chatId, profile, settings);
      return;
    }

    if (data === 'menu:models') {
      await tgAnswerCallback(bot.token, cq.id, '');
      await sendPlatformPicker(env, chatId, profile);
      return;
    }
    if (data === 'menu:persona') {
      await tgAnswerCallback(bot.token, cq.id, '');
      await sendPersonaPicker(env, chatId, profile);
      return;
    }
    if (data === 'menu:settings') {
      await tgAnswerCallback(bot.token, cq.id, '');
      await sendSettings(env, chatId, profile, settings);
      return;
    }
    if (data === 'menu:new') {
      await wipeMind(env, 'tg', chatId, 'chat');
      await tgAnswerCallback(bot.token, cq.id, 'گفتگوی جدید شروع شد');
      await send(env, chatId, '🆕 گفتگوی جدید شروع شد.');
      return;
    }
    if (data === 'menu:deep') {
      profile.deep = !profile.deep;
      await saveProfile(env, 'tg', chatId, profile);
      await tgAnswerCallback(bot.token, cq.id, profile.deep ? 'نهایت قدرت روشن' : 'نهایت قدرت خاموش');
      return;
    }
    if (data === 'menu:support') {
      await tgAnswerCallback(bot.token, cq.id, '');
      await sendSupport(env, chatId);
      return;
    }
    if (data === 'menu:social') {
      await tgAnswerCallback(bot.token, cq.id, '');
      await sendSocial(env, chatId);
      return;
    }

    if (data.startsWith('reset:')) {
      const mode = data.slice(6);
      if (!['chat', 'memory', 'all'].includes(mode)) return;
      await wipeMind(env, 'tg', chatId, mode);
      await tgAnswerCallback(bot.token, cq.id, 'انجام شد ✓');
      if (messageId) {
        await tgEditMessageText(bot.token, chatId, messageId,
          mode === 'chat' ? '🆕 گفتگو پاک شد؛ حافظهٔ بلندمدت حفظ شد.' :
          mode === 'memory' ? '🧠 حافظهٔ بلندمدت پاک شد؛ چند پیام اخیر حفظ شد.' :
          '🗑 همهٔ حافظه و گفتگو پاک شد.');
      }
      return;
    }

    await tgAnswerCallback(bot.token, cq.id, 'گزینه ناشناخته');
  } catch (e) {
    await log(env, 'error', 'tg callback: ' + String((e && e.message) || e).slice(0, 220));
    await tgAnswerCallback(bot.token, cq.id, 'خطا رخ داد؛ دوباره تلاش کن.', true);
  }
}

/* ============================ pickers ============================ */

async function sendPlatformPicker(env, chatId, profile) {
  const status = await providerStatus(env);
  const rows = PLATFORM_ORDER.map((id) => {
    const p = PLATFORMS[id];
    const ready = status[id] && status[id].ready;
    return [{
      text: (ready ? '✅ ' : '⚠️ ') + p.faLabel,
      callback_data: 'pf:' + id
    }];
  });
  rows.push([{ text: 'بستن', callback_data: 'close' }]);
  await send(env, chatId,
    '🧩 پلتفرم را انتخاب کن:\n\n' +
    '✅ = آماده، ⚠️ = نیاز به کلید در پنل ادمین\n' +
    'پلتفرم فعلی: ' + (PLATFORMS[profile.platform] ? PLATFORMS[profile.platform].faLabel : '—') +
    '\nمدل فعلی: ' + (profile.model || '—'),
    { replyMarkup: { inline_keyboard: rows } });
}

async function sendModelPicker(env, chatId, profile, platform) {
  if (!PLATFORMS[platform]) return;
  let models;
  try {
    models = await listModels(env, platform, {});
  } catch (e) {
    await send(env, chatId, '⚠️ دریافت لیست مدل‌های ' + PLATFORMS[platform].faLabel + ' ناموفق بود:\n' + String(e.message || e).slice(0, 240));
    return;
  }
  const freeOnly = platform !== 'onerouter';
  const withFree = freeOnly ? models.filter((m) => m.free) : models;
  const finalFreeOnly = withFree.length ? freeOnly : false;
  await createPicker(env, chatId, platform, models, finalFreeOnly);
  const snap = await readPicker(env, chatId);
  const rendered = renderPicker(snap);
  const status = await providerStatus(env);
  const ready = status[platform] && status[platform].ready;
  const warning = ready ? '' : '\n\n⚠️ برای استفاده از این پلتفرم، کلید آن را در پنل ادمین ذخیره کن.';
  await send(env, chatId, rendered.text + warning, { replyMarkup: rendered.keyboard });
}

async function createPicker(env, chatId, platform, models, freeOnly) {
  const view = freeOnly ? models.filter((m) => m.free) : models;
  const snap = {
    platform,
    models,
    view,
    freeOnly,
    page: 0,
    t: Date.now()
  };
  await writePicker(env, chatId, snap);
  return snap;
}

function renderPicker(snap) {
  if (!snap || !snap.view) return { text: 'لیست مدل‌ها خالی است.', keyboard: { inline_keyboard: [[{ text: 'بستن', callback_data: 'close' }]] } };
  const total = snap.view.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.max(0, Math.min(pages - 1, Number(snap.page) || 0));
  snap.page = page;
  const start = page * PAGE_SIZE;
  const slice = snap.view.slice(start, start + PAGE_SIZE);
  const p = PLATFORMS[snap.platform];

  let text = '🤖 مدل‌های ' + (p ? p.faLabel : snap.platform) + '\n' +
    'صفحه ' + (page + 1) + ' از ' + pages + ' · ' + total + ' مدل' +
    (snap.freeOnly ? ' · فقط رایگان 🎁' : ' · همه') + '\n\n';
  if (!slice.length) text += 'مدلی در این فیلتر نیست.';

  const rows = slice.map((m, i) => [{
    text: (m.free ? '🎁 ' : '💳 ') + truncate(m.name || m.id, 48),
    callback_data: 'mdl:' + (start + i)
  }]);

  const nav = [];
  if (page > 0) nav.push({ text: '‹ قبلی', callback_data: 'pg:-1' });
  nav.push({ text: (page + 1) + '/' + pages, callback_data: 'rfr' });
  if (page < pages - 1) nav.push({ text: 'بعدی ›', callback_data: 'pg:1' });
  if (nav.length) rows.push(nav);
  rows.push([
    { text: snap.freeOnly ? 'نمایش همه 💳' : 'فقط رایگان 🎁', callback_data: 'flt' },
    { text: '🔄 بروزرسانی', callback_data: 'rfr' }
  ]);
  rows.push([{ text: 'بستن', callback_data: 'close' }]);

  return { text, keyboard: { inline_keyboard: rows } };
}

async function readPicker(env, chatId) {
  try {
    if (!env.DB) return null;
    return await env.DB.get('tgpick:' + chatId, 'json');
  } catch {
    return null;
  }
}

async function writePicker(env, chatId, snap) {
  try {
    if (!env.DB) return;
    snap.t = Date.now();
    await env.DB.put('tgpick:' + chatId, JSON.stringify(snap), { expirationTtl: PICKER_TTL });
  } catch { /* ignore */ }
}

async function sendPersonaPicker(env, chatId, profile) {
  const rows = [];
  let row = [];
  for (const id of PERSONA_ORDER) {
    const p = PERSONAS[id];
    row.push({
      text: (profile.persona === id ? '✅ ' : p.emoji + ' ') + p.name,
      callback_data: 'per:' + id
    });
    if (row.length === 2) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  rows.push([{ text: 'بستن', callback_data: 'close' }]);
  await send(env, chatId,
    '🎭 شخصیت مورد نظرت را انتخاب کن:\n\nشخصیت فعلی: ' + (PERSONAS[profile.persona] ? PERSONAS[profile.persona].name : '—'),
    { replyMarkup: { inline_keyboard: rows } });
}

function personaSelectedText(profile, id) {
  const p = PERSONAS[id];
  const exp = Array.isArray(p.expertise) && p.expertise.length
    ? '\n\n🎯 تخصص‌ها: ' + p.expertise.join('، ') : '';
  const rec = p.recommended[profile.platform]
    || p.recommended[Object.keys(p.recommended)[0]]
    || '— (مدلی ثبت نشده)';
  return '🎭 شخصیت متخصص انتخاب شد: ' + p.emoji + ' ' + p.name + '\n' + p.tagline + exp +
    '\n\n💡 مدل پیشنهادی برای این عامل روی ' + (PLATFORMS[profile.platform] ? PLATFORMS[profile.platform].faLabel : profile.platform) + ':\n' + rec +
    '\n\nهمین حالا سؤالت را بنویس.';
}

async function sendPersonaSelected(env, chatId, profile, id) {
  await send(env, chatId, personaSelectedText(profile, id), {
    replyMarkup: {
      inline_keyboard: [
        [{ text: '✅ استفاده از مدل پیشنهادی', callback_data: 'rec:' + id }],
        [{ text: '🤖 انتخاب مدل دیگر', callback_data: 'menu:models' }],
        [{ text: 'بستن', callback_data: 'close' }]
      ]
    }
  });
}

/* ============================ menus & info ============================ */

async function sendStart(env, chatId, profile, bot) {
  const persona = PERSONAS[profile.persona] || PERSONAS.general;
  const p = PLATFORMS[profile.platform] || PLATFORMS.workersai;
  const text = [
    '👋 سلام! به ' + APP.faName + ' خوش آمدی.',
    APP.tagline,
    '',
    'من دستیار هوش مصنوعی تو هستم؛ می‌توانی مستقیم پیام بدهی تا گفتگو کنیم.',
    '🧩 پلتفرم فعلی: ' + p.faLabel,
    '🤖 مدل فعلی: ' + (profile.model || p.defaultModel),
    '🎭 شخصیت فعلی: ' + persona.emoji + ' ' + persona.name,
    '🧠 حالت نهایت قدرت: ' + (profile.deep ? 'روشن' : 'خاموش'),
    '',
    'از دکمه‌ها یا دستورها استفاده کن:',
    '/models — انتخاب پلتفرم و مدل',
    '/persona — انتخاب شخصیت',
    '/deep — حالت نهایت قدرت',
    '/new — گفتگوی جدید',
    '/settings — تنظیمات',
    '/support — پشتیبانی',
    '/about — دربارهٔ تکناموز',
    '',
    '📬 پشتیبانی: ' + APP.supportHandle
  ].join('\n');

  await send(env, chatId, text, {
    replyMarkup: {
      inline_keyboard: [
        [{ text: '🤖 انتخاب مدل', callback_data: 'menu:models' }, { text: '🎭 شخصیت', callback_data: 'menu:persona' }],
        [{ text: '🧠 نهایت قدرت', callback_data: 'menu:deep' }, { text: '🆕 گفتگوی جدید', callback_data: 'menu:new' }],
        [{ text: '⚙️ تنظیمات', callback_data: 'menu:settings' }, { text: '🆘 پشتیبانی', callback_data: 'menu:support' }],
        [{ text: '🌐 شبکه‌های اجتماعی', callback_data: 'menu:social' }]
      ]
    }
  });
}

async function sendHelp(env, chatId) {
  await send(env, chatId, [
    '📚 راهنمای تکناموز',
    '',
    'فقط سؤالت را بنویس تا پاسخ بگیری. برای کنترل بیشتر:',
    '',
    '🧩 /models — انتخاب پلتفرم و مدل (Cloudflare، OpenRouter، OrcaRouter، OneRouter)',
    '🎭 /persona — انتخاب شخصیت (مترجم، معلم، متفکر، برنامه‌نویس و…)',
    '🧠 /deep — روشن/خاموش کردن حالت نهایت قدرت',
    '🆕 /new — شروع گفتگوی جدید',
    '🧹 /reset — پاک کردن حافظه',
    '⚙️ /settings — تنظیمات فعلی',
    '🧠 /memory — مشاهدهٔ خلاصهٔ حافظه',
    '📊 /status — وضعیت سرویس‌ها',
    '📬 /support — پشتیبانی',
    '🌐 /social — شبکه‌های اجتماعی',
    'ℹ️ /about — دربارهٔ تکناموز',
    '📝 /feedback متن — ارسال بازخورد',
    '',
    'هر شخصیت با همهٔ مدل‌ها کار می‌کند؛ بهترین مدل را خودت انتخاب کن.'
  ].join('\n'));
}

async function sendSettings(env, chatId, profile, settings) {
  const p = PLATFORMS[profile.platform] || PLATFORMS.workersai;
  const persona = PERSONAS[profile.persona] || PERSONAS.general;
  const text = [
    '⚙️ تنظیمات من',
    '',
    '🧩 پلتفرم: ' + p.faLabel,
    '🤖 مدل: ' + (profile.model || p.defaultModel),
    '🎭 شخصیت: ' + persona.emoji + ' ' + persona.name,
    '🧠 نهایت قدرت: ' + (profile.deep ? 'روشن' : 'خاموش'),
    '💾 حافظه: ' + (settings.memoryEnabled ? 'فعال' : 'غیرفعال'),
    '💬 تعداد پیام‌ها: ' + (Number(profile.msgs) || 0),
    '',
    'با دکمه‌ها تنظیمات را تغییر بده.'
  ].join('\n');
  await send(env, chatId, text, {
    replyMarkup: {
      inline_keyboard: [
        [{ text: '🤖 مدل', callback_data: 'menu:models' }, { text: '🎭 شخصیت', callback_data: 'menu:persona' }],
        [{ text: profile.deep ? '⚡️ خاموش کردن نهایت قدرت' : '🧠 روشن کردن نهایت قدرت', callback_data: 'deep:toggle' }],
        [{ text: '🆕 گفتگوی جدید', callback_data: 'menu:new' }, { text: '🧹 پاک کردن حافظه', callback_data: 'reset:memory' }],
        [{ text: 'بستن', callback_data: 'close' }]
      ]
    }
  });
}

async function sendResetConfirm(env, chatId) {
  await send(env, chatId, 'کدام بخش پاک شود؟', {
    replyMarkup: {
      inline_keyboard: [
        [{ text: '🆕 فقط گفتگوی فعلی', callback_data: 'reset:chat' }],
        [{ text: '🧠 حافظهٔ بلندمدت (چند پیام اخیر می‌ماند)', callback_data: 'reset:memory' }],
        [{ text: '🗑 همهٔ حافظه و گفتگو', callback_data: 'reset:all' }],
        [{ text: 'انصراف', callback_data: 'close' }]
      ]
    }
  });
}

async function sendSupport(env, chatId) {
  await send(env, chatId, [
    '🆘 پشتیبانی تکناموز',
    '',
    'برای ارتباط مستقیم با ادمین:',
    APP.supportHandle,
    APP.supportTelegram,
    '',
    'برای ارسال بازخورد:',
    '/feedback متن پیام',
    '',
    'ساختهٔ ' + APP.author + ' · ' + APP.package
  ].join('\n'));
}

async function sendSocial(env, chatId) {
  await send(env, chatId, [
    '🌐 شبکه‌های اجتماعی تکناموز',
    '',
    ...APP.social.map((s) => s.icon + ' ' + s.nameFa + ': ' + s.handle + '\n' + s.url),
    '',
    '📬 پشتیبانی: ' + APP.supportHandle
  ].join('\n'));
}

async function sendAbout(env, chatId) {
  await send(env, chatId, [
    'ℹ️ دربارهٔ ' + APP.name,
    '',
    APP.tagline,
    'نسخه: ' + APP.version + ' (' + APP.package + ')',
    'سازنده: ' + APP.author + ' (' + APP.authorEn + ')',
    '',
    'یک پلتفرم چت هوش مصنوعی روی Cloudflare Workers با:',
    '• وب‌چت حرفه‌ای',
    '• ربات تلگرام',
    '• پنل مدیریت جداگانه',
    '• چهار پلتفرم هوش مصنوعی',
    '• حافظهٔ اختصاصی هر کاربر',
    '• ۱۶ شخصیت حرفه‌ای',
    '',
    '🌐 ' + APP.social.map((s) => s.handle).join(' · ')
  ].join('\n'));
}

async function sendStatus(env, chatId, admin = false) {
  const status = await providerStatus(env);
  const lines = ['📊 وضعیت سرویس‌ها', ''];
  for (const id of PLATFORM_ORDER) {
    const p = PLATFORMS[id];
    const s = status[id];
    lines.push((s.ready ? '✅ ' : '⚠️ ') + p.faLabel + ' — ' +
      (s.ready ? (s.mode === 'binding' ? 'binding داخلی' : 'کلید تنظیم شده') : 'نیاز به کلید'));
  }
  lines.push('', '🤖 ربات: ' + (env.DB ? 'متصل' : 'بدون KV'));
  if (admin) lines.push('👤 شما مدیر هستید.');
  await send(env, chatId, lines.join('\n'));
}

async function sendMemory(env, chatId) {
  const mind = await getMind(env, 'tg', chatId);
  const lines = ['🧠 حافظهٔ من', ''];
  lines.push('پیام‌های ذخیره‌شده: ' + mind.rounds.length);
  if (mind.summary) lines.push('\nخلاصه:\n' + mind.summary.slice(0, 2500));
  if (mind.facts && mind.facts.length) {
    lines.push('\nدانسته‌های ماندگار:');
    for (const f of mind.facts.slice(0, 12)) lines.push('• ' + f);
  }
  if (!mind.summary && (!mind.facts || !mind.facts.length)) {
    lines.push('\nهنوز حافظهٔ بلندمدتی ساخته نشده. با گفتگو بیشتر، حافظه شکل می‌گیرد.');
  }
  lines.push('\nبرای پاک کردن: /reset');
  await send(env, chatId, lines.join('\n'));
}

async function searchModels(env, chatId, profile, query) {
  const platform = profile.platform || 'workersai';
  let models;
  try {
    models = await listModels(env, platform, {});
  } catch (e) {
    await send(env, chatId, '⚠️ دریافت مدل‌ها ناموفق بود: ' + String(e.message || e).slice(0, 200));
    return;
  }
  const q = String(query).toLowerCase();
  const found = models.filter((m) => (m.id + ' ' + m.name + ' ' + m.desc).toLowerCase().includes(q)).slice(0, 10);
  if (!found.length) {
    await send(env, chatId, 'مدلی با «' + query + '» پیدا نشد. /models را بزن تا همه را ببینی.');
    return;
  }
  await createPicker(env, chatId, platform, found, false);
  const snap = await readPicker(env, chatId);
  const rendered = renderPicker(snap);
  await send(env, chatId, '🔎 نتایج جستجو برای «' + query + '»:\n\n' + rendered.text, { replyMarkup: rendered.keyboard });
}

/* ============================ helpers ============================ */

async function send(env, chatId, text, options = {}) {
  const bot = await getTgBot(env);
  if (!bot.token) return { ok: false, error: 'no token' };
  const result = await tgSendMessage(bot.token, chatId, text, options);
  if (!result.ok) {
    await log(env, 'warn', 'tg send: ' + String(result.error || result.description || 'unknown').slice(0, 180));
  }
  return result;
}

function truncate(text, len) {
  const s = String(text || '');
  if (s.length <= len) return s;
  return s.slice(0, Math.max(1, len - 1)) + '…';
}

export function newWebhookSecret() {
  return randomSecret(24);
}
