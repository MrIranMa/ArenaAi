// ============================================================
//  ArenaAi AI — technamooz-ai-version1.0.0
//  Author: Amir Parsa (امیر پارسا)
//  public/js/app.js — public web chat (paper/console UI, 5 themes)
// ============================================================

(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* ============================ themes ============================ */

  const THEMES = [
    { id: 'night',  label: 'شب — مشکی برنزی',   swatch: '#d9b778', dark: true },
    { id: 'day',    label: 'روز — کاغذ سفید',    swatch: '#0e7a6d', dark: false },
    { id: 'sea',    label: 'دریا — آبی ذغالی',   swatch: '#7cc7ef', dark: true },
    { id: 'sand',   label: 'شن — کاغذ گرم',      swatch: '#a35c25', dark: false },
    { id: 'forest', label: 'جنگل — کاغذ سبز',    swatch: '#7fc79b', dark: true }
  ];
  const THEME_KEY = 'tm-theme';
  const PREFS_KEY = 'tm-prefs';

  // apply saved theme synchronously (before first paint in most cases)
  (function prePaintTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      const valid = THEMES.some((t) => t.id === saved);
      if (valid) document.documentElement.dataset.theme = saved;
      else if (!window.matchMedia || !window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.dataset.theme = 'day';
      }
    } catch { /* ignore */ }
  })();

  const state = {
    config: null,
    session: null,
    personas: [],
    personaMap: new Map(),
    platform: 'workersai',
    model: '',
    modelName: '',
    persona: 'general',
    deep: false,
    freeOnly: true,
    pickerPlatform: 'workersai',
    modelCache: new Map(),
    streaming: false,
    abort: null,
    lastUserText: '',
    lastAnswer: '',
    maintenance: false,
    pendingImages: [],
  };

  const els = {};

  document.addEventListener('DOMContentLoaded', boot);

  async function boot() {
    loadLocalPrefs();
    cacheElements();
    initThemeMenu();
    bindEvents();
    try {
      const [config, personas] = await Promise.all([
        api('/api/config'),
        api('/api/personas')
      ]);
      state.config = config;
      state.personas = personas.personas || [];
      state.personaMap = new Map(state.personas.map((p) => [p.id, p]));
      const session = await api('/api/session', { method: 'POST', body: {} });
      state.session = session;
      state.maintenance = !!(config && config.settings && config.settings.maintenance);
      updateNotices();
      renderStatic();
      updateConnection();
      restorePrefsFromServer(session);
      renderCurrent();
      setComposerState();
      messageInputFocus();
      await loadHistory();
    } catch (e) {
      renderFatal(e);
    }
  }

  function loadLocalPrefs() {
    state.hadLocalPrefs = false;
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        state.hadLocalPrefs = true;
        if (typeof p.platform === 'string') state.platform = p.platform;
        if (typeof p.model === 'string') state.model = p.model;
        if (typeof p.modelName === 'string') state.modelName = p.modelName;
        if (typeof p.persona === 'string') state.persona = p.persona;
        if (typeof p.deep === 'boolean') state.deep = p.deep;
        if (typeof p.freeOnly === 'boolean') state.freeOnly = p.freeOnly;
        if (typeof p.pickerPlatform === 'string') state.pickerPlatform = p.pickerPlatform;
      }
    } catch { /* ignore */ }
  }

  function saveLocalPrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        platform: state.platform,
        model: state.model,
        modelName: state.modelName,
        persona: state.persona,
        deep: state.deep,
        freeOnly: state.freeOnly,
        pickerPlatform: state.pickerPlatform
      }));
    } catch { /* ignore */ }
  }

  /**
   * Adopt server-side prefs only when the visitor has no local prefs yet.
   * Server prefs are the source of truth for first-seen users; local prefs
   * win afterwards for speed and offline behaviour.
   */
  function restorePrefsFromServer(session) {
    if (!session || !session.user || state.hadLocalPrefs) return;
    const u = session.user;
    if (u.platform && platformExists(u.platform)) state.platform = u.platform;
    if (u.model && typeof u.model === 'string') { state.model = u.model; state.modelName = ''; }
    if (u.persona) state.persona = u.persona;
    if (typeof u.deep === 'boolean') state.deep = u.deep;
    if (typeof u.freeOnly === 'boolean') state.freeOnly = u.freeOnly;
  }

  function cacheElements() {
    els.topbar = $('.topbar');
    els.brand = $('.brand');
    els.chipPersona = $('#chipPersona');
    els.chipPersonaEmoji = $('#chipPersonaEmoji');
    els.chipPersonaName = $('#chipPersonaName');
    els.chipModel = $('#chipModel');
    els.chipModelName = $('#chipModelName');
    els.connPill = $('#connPill');
    els.connDot = $('#connDot');
    els.connText = $('#connText');
    els.btnTheme = $('#btnTheme');
    els.themeMenu = $('#themeMenu');
    els.themeOptions = $('#themeOptions');
    els.btnSupportTop = $('#btnSupportTop');
    els.maintenance = $('#maintenance');
    els.announce = $('#announce');
    els.chatLog = $('#chatLog');
    els.composerForm = $('#composerForm');
    els.messageInput = $('#messageInput');
    els.btnAttach = $('#btnAttach');
    els.attachmentInput = $('#attachmentInput');
    els.attachmentStatus = $('#attachmentStatus');
    els.btnVoice = $('#btnVoice');
    els.btnImage = $('#btnImage');
    els.btnSpeak = $('#btnSpeak');
    els.modalImage = $('#modalImage');
    els.imageForm = $('#imageForm');
    els.imagePrompt = $('#imagePrompt');
    els.imageMsg = $('#imageMsg');
    els.btnCreateImage = $('#btnCreateImage');
    els.btnSend = $('#btnSend');
    els.btnStop = $('#btnStop');
    els.btnDeep = $('#btnDeep');
    els.btnNewChat = $('#btnNewChat');
    els.btnReset = $('#btnReset');
    els.charCount = $('#charCount');
    els.streamState = $('#streamState');
    els.socialLinks = $('#socialLinks');
    els.footVersion = $('#footVersion');
    els.modalModel = $('#modalModel');
    els.platformTabs = $('#platformTabs');
    els.modelSearch = $('#modelSearch');
    els.freeOnlyToggle = $('#freeOnly');
    els.btnRefreshModels = $('#btnRefreshModels');
    els.modelCount = $('#modelCount');
    els.modelNote = $('#modelNote');
    els.modelList = $('#modelList');
    els.modalPersona = $('#modalPersona');
    els.personaGrid = $('#personaGrid');
    els.personaCurrentLabel = $('#personaCurrentLabel');
    els.modalSupport = $('#modalSupport');
    els.supportSocials = $('#supportSocials');
    els.feedbackForm = $('#feedbackForm');
    els.feedbackText = $('#feedbackText');
    els.feedbackMsg = $('#feedbackMsg');
    els.modalReset = $('#modalReset');
    els.toastWrap = $('#toastWrap');
  }

  /* ============================ api ============================ */

  async function api(path, options = {}) {
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin'
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-json */ }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }


  /* ============================ theme menu ============================ */

  function initThemeMenu() {
    updateThemeMeta(document.documentElement.dataset.theme || 'night');
    renderThemeOptions();
    if (els.btnTheme) {
      els.btnTheme.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = !els.themeMenu.hidden;
        els.themeMenu.hidden = open;
        els.btnTheme.setAttribute('aria-expanded', String(!open));
      });
    }
    if (els.themeOptions) {
      els.themeOptions.addEventListener('click', (e) => {
        const opt = e.target.closest('[data-theme-id]');
        if (!opt) return;
        setTheme(opt.dataset.themeId);
        els.themeMenu.hidden = true;
        if (els.btnTheme) els.btnTheme.setAttribute('aria-expanded', 'false');
      });
    }
    document.addEventListener('click', (e) => {
      if (!els.themeMenu || els.themeMenu.hidden) return;
      if (e.target.closest && (e.target.closest('.theme-menu') || e.target.closest('#btnTheme'))) return;
      els.themeMenu.hidden = true;
      if (els.btnTheme) els.btnTheme.setAttribute('aria-expanded', 'false');
    });
  }

  function renderThemeOptions() {
    if (!els.themeOptions) return;
    const current = document.documentElement.dataset.theme || 'night';
    els.themeOptions.innerHTML = THEMES.map((t) =>
      '<button type="button" class="theme-opt' + (t.id === current ? ' active' : '') + '" role="menuitemradio" aria-checked="' +
      (t.id === current) + '" data-theme-id="' + t.id + '">' +
      '<span class="swatch" style="background:' + esc(t.swatch) + '"></span><span>' + esc(t.label) + '</span></button>'
    ).join('');
  }

  function setTheme(id) {
    if (!THEMES.some((t) => t.id === id)) return;
    document.documentElement.dataset.theme = id;
    try { localStorage.setItem(THEME_KEY, id); } catch { /* ignore */ }
    updateThemeMeta(id);
    renderThemeOptions();
  }

  function updateThemeMeta(theme) {
    const meta = $('meta[name="theme-color"]');
    if (!meta) return;
    const colors = {
      night: '#0c0e12', day: '#fafaf7', sea: '#0a1420', sand: '#f2ecdf', forest: '#0d1712'
    };
    meta.setAttribute('content', colors[theme] || colors.night);
  }

  /* ============================ static renders ============================ */

  function updateNotices() {
    const cfgSettings = (state.config && state.config.settings) || {};
    if (els.maintenance) {
      if (state.maintenance) {
        els.maintenance.textContent = '🛠 آرنا ای‌آی در حال تعمیر و به‌روزرسانی است؛ کمی بعد برگردید.';
        els.maintenance.hidden = false;
      } else els.maintenance.hidden = true;
    }
    if (els.announce) {
      const msg = cfgSettings.announcement;
      if (msg && String(msg).trim()) {
        els.announce.textContent = String(msg).trim();
        els.announce.hidden = false;
      } else els.announce.hidden = true;
    }
  }

  function renderStatic() {
    const social = (state.config && state.config.social) || [];
    const support = (state.config && state.config.support) || {};

    if (els.socialLinks) {
      els.socialLinks.innerHTML = social.map((s) =>
        '<a href="' + esc(s.url || '#') + '" target="_blank" rel="noopener" title="' + esc(s.nameFa || '') + '">' +
        '<span>' + esc(s.icon || '•') + '</span><span>' + esc(s.nameFa || s.handle || '') + '</span>' +
        '<span class="social-handle">' + esc(s.handle || '') + '</span></a>'
      ).join('');
    }
    if (els.supportSocials) {
      const supportItem = { icon: '🆘', nameFa: 'پشتیبانی', handle: support.handle, url: support.url };
      els.supportSocials.innerHTML = [supportItem, ...social].map((s) =>
        '<a class="social-row" href="' + esc(s.url || '#') + '" target="_blank" rel="noopener">' +
        '<span class="social-icon">' + esc(s.icon || '•') + '</span>' +
        '<span>' + esc(s.nameFa || s.handle || '') + '</span>' +
        (s.handle ? '<span class="social-handle">' + esc(s.handle) + '</span>' : '') + '</a>'
      ).join('');
    }
    if (els.footVersion) {
      const app = (state.config && state.config.app) || {};
      els.footVersion.textContent = 'آرنا ای‌آی نسخهٔ ' + (app.version || '1.0.0');
    }
  }

  function updateConnection() {
    if (!els.connDot) return;
    const ready = (state.config && state.config.providers) ? hasReadyProvider() : false;
    els.connDot.className = 'conn-dot ' + (ready ? 'on' : 'off');
    if (els.chipModel) els.chipModel.classList.toggle('conn-on', ready);
    if (els.connText) {
      const provider = readyPlatform();
      els.connText.textContent = ready
        ? (provider ? provider.faLabel || provider.id : 'متصل')
        : 'پلتفرمی تنظیم نشده';
    }
  }

  function hasReadyProvider() {
    const providers = (state.config && state.config.providers) || {};
    return Object.keys(providers).some((k) => providers[k] && providers[k].ready);
  }

  function platformExists(id) {
    return ((state.config && state.config.platforms) || []).some((p) => p.id === id);
  }

  function platform(id) {
    return ((state.config && state.config.platforms) || []).find((p) => p.id === id) || null;
  }

  function platformLabel(id) {
    const p = platform(id);
    return p ? (p.faLabel || p.id) : id;
  }

  function readyPlatform() {
    /* platformList() items do not carry a `ready` flag — derive from providers */
    const providers = (state.config && state.config.providers) || {};
    return ((state.config && state.config.platforms) || []).find((p) =>
      providers[p.id] && providers[p.id].ready
    ) || null;
  }

  function defaultPlatform() {
    return ((state.config && state.config.platforms) || [])[0] || null;
  }

  function defaultPersona() {
    return state.personas[0] || null;
  }

  function defaultModel(id) {
    const persona = state.personaMap.get(state.persona);
    if (persona && persona.recommended && persona.recommended[id]) return persona.recommended[id];
    const p = platform(id);
    return (p && p.defaultModel) || '';
  }

  function personaById(id) {
    return state.personaMap.get(id) || null;
  }

  /* ============================ current render ============================ */

  function renderCurrent() {
    const persona = personaById(state.persona);
    if (els.chipPersonaName) els.chipPersonaName.textContent = persona ? persona.name : '—';
    if (els.chipPersonaEmoji) els.chipPersonaEmoji.textContent = persona ? (persona.emoji || '•') : '•';
    if (els.chipModelName) {
      els.chipModelName.textContent = state.modelName || prettyModel(state.model) || 'انتخاب مدل';
    }
    if (els.btnDeep) els.btnDeep.classList.toggle('active', state.deep);
  }

  function prettyModel(id) {
    const s = String(id || '');
    if (!s) return '';
    if (s.includes('/')) return s.split('/').pop().replace(/[:-]/g, ' ').trim();
    return s;
  }

  function setComposerState() {
    if (els.btnSend) els.btnSend.disabled = state.streaming;
    if (els.btnStop) els.btnStop.hidden = !state.streaming;
    if (els.messageInput) els.messageInput.disabled = state.maintenance;
    if (els.composerForm) {
      els.composerForm.style.opacity = state.maintenance ? '0.5' : '1';
    }
  }

  function messageInputFocus() {
    if (els.messageInput && window.matchMedia && window.matchMedia('(min-width: 900px)').matches) {
      els.messageInput.focus();
    }
  }

  /* ============================ empty / history ============================ */

  function renderEmpty() {
    if (!els.chatLog) return;
    const support = (state.config && state.config.support) || {};
    const suggestions = [
      { title: 'گفتگو', prompt: 'سلام! خودت رو معرفی کن؛ چه کارهایی از تو برمی‌آید؟' },
      { title: 'برنامه‌نویسی', prompt: 'یک صفحهٔ وب ساده با HTML و CSS برای فرم تماس بنویس.' },
      { title: 'تحلیل', prompt: 'مزایا و معایب فروش محصول به‌صورت آنلاین در ایران را تحلیل کن.' },
      { title: 'یادگیری', prompt: 'پایه‌های ریاضی پایه دهم را برای من ساده توضیح بده.' }
    ];
    els.chatLog.innerHTML =
      '<div class="empty-state">' +
        '<span class="hero-eyebrow">ARENA AI — AGENT CHAT</span>' +
        '<hr class="hero-rule" />' +
        '<h1 class="hero-title">سلام 👋<br />چه کاری برایت انجام دهم؟</h1>' +
        '<p class="hero-sub">۱۶ عامل متخصص، سناریوهای نهایت‌قدرت و حافظهٔ اختصاصی؛ از تعمیر کد تا تجزیه‌وتحلیل کسب‌وکار. از سریع‌راه‌های زیر شروع کن یا مستقیم بنویس.</p>' +
        '<div class="quick-list">' +
        suggestions.map((s) =>
          '<button class="quick-chip" type="button" data-quick="' + esc(s.prompt) + '">' +
          '<b>' + esc(s.title) + '</b><span>' + esc(s.prompt) + '</span></button>'
        ).join('') +
        '</div>' +
        '<p class="hero-support">🆘 پشتیبانی: <a href="' + esc(support.url || 'https://t.me/technamooz_support') + '" target="_blank" rel="noopener">' +
        esc(support.handle || '@technamooz_support') + '</a></p>' +
        '<img class="hero-logo" src="/assets/logo.svg" alt="آرنا ای‌آی" width="72" height="72" />' +
      '</div>';
  }

  async function loadHistory() {
    try {
      const data = await api('/api/history');
      const rounds = (data && data.rounds) || [];
      if (!rounds.length) { renderEmpty(); return; }

      els.chatLog.innerHTML = '';
      const tail = rounds.slice(-30);
      for (const r of tail) {
        const who = (state.personaMap.get(r.p) || {}).name || 'دستیار';
        appendMessage('user', r.q, { silent: true });
        appendMessage('bot', r.a, { silent: true, who, model: r.m || '' });
      }
      scrollBottom(true);
    } catch {
      renderEmpty();
    }
  }

  /* ============================ messages ============================ */

  function appendMessage(role, text, options = {}) {
    if (options.replacingEmpty) removeEmpty();
    else removeEmpty();

    const wrap = document.createElement('article');
    wrap.className = 'msg ' + (role === 'user' ? 'user' : 'bot');

    const who = options.who ||
      (role === 'user' ? 'شما' : ((personaById(state.persona) || {}).name || 'دستیار'));
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = '<span class="m-who">' + esc(who) + '</span>' +
      (options.model ? '<span class="sep">·</span><span class="m-model" dir="ltr">' + esc(options.model) + '</span>' : '') +
      (options.meta ? '<span class="sep">·</span><span class="m-extra">' + esc(options.meta) + '</span>' : '');
    if (role === 'user') meta.classList.add('hide');
    wrap.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'body';
    if (role === 'user') {
      body.textContent = String(text || '');
    } else {
      const md = document.createElement('div');
      md.className = 'md';
      md.innerHTML = text ? mdRender(text) : '<span class="typing" aria-label="در حال نوشتن"><i></i><i></i><i></i></span>';
      body.appendChild(md);
      wrap._md = md;
      wrap._body = body;
      if (!options.silent) {
        wrap.classList.add('fresh');
        setTimeout(() => wrap.classList.remove('fresh'), 2500);
      }
    }
    wrap.appendChild(body);
    els.chatLog.appendChild(wrap);
    if (!options.silent) scrollBottom(true);
    return wrap;
  }

  function setBotText(bot, text) {
    if (!bot || !bot._md) return;
    bot._md.innerHTML = mdRender(text) + '<span class="caret" aria-hidden="true"></span>';
  }

  function setBotFinal(bot, text) {
    if (!bot || !bot._md) return;
    bot._md.innerHTML = mdRender(text);
  }

  function setBotTyping(bot) {
    if (!bot || !bot._md) return;
    bot._md.innerHTML = '<span class="typing" aria-label="در حال نوشتن"><i></i><i></i><i></i></span>';
  }

  function ensureReasoning(bot, text) {
    if (!bot || !bot._body) return;
    let box = $('.reasoning-block', bot._body);
    if (!box) {
      box = document.createElement('div');
      box.className = 'reasoning-block';
      box.innerHTML = '<span class="rb-title">🧠 استدلال</span><span class="rb-text"></span>';
      bot._body.insertBefore(box, bot._body.firstChild);
    }
    const t = $('.rb-text', box);
    if (t) t.textContent = String(text || '').slice(-260);
  }

  function removeEmpty() {
    const empty = $('.empty-state', els.chatLog);
    if (empty) empty.remove();
  }

  function scrollBottom(force) {
    const near = els.chatLog.scrollHeight - (els.chatLog.scrollTop + els.chatLog.clientHeight) < 140;
    if (force || near) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: force ? 'auto' : 'smooth' });
    }
  }

  function timeLabel(ts) {
    try {
      return new Date(ts).toLocaleTimeString('fa-IR', { hour: '2-digit', 'minute': '2-digit' });
    } catch { return ''; }
  }

  function removePreviousRegen() {
    $$('[data-action="regen"]', els.chatLog).forEach((b) => b.closest('.msg-actions') && b.closest('.msg-actions').remove());
  }

  /* ============================ attachments / voice ============================ */

  async function handleAttachments() {
    const files = Array.from((els.attachmentInput && els.attachmentInput.files) || []);
    if (!files.length) return;
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
          toast('فقط تصویر PNG، JPG یا WebP پشتیبانی می‌شود.', 'err');
          continue;
        }
        if (file.size > 2 * 1024 * 1024) {
          toast('حجم هر تصویر باید حداکثر ۲ مگابایت باشد.', 'err');
          continue;
        }
        if (state.pendingImages.length >= 2) {
          toast('حداکثر دو تصویر را می‌توانی هم‌زمان بفرستی.', 'err');
          break;
        }
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('خواندن تصویر ناموفق بود.'));
          reader.readAsDataURL(file);
        }).catch((e) => { toast(e.message, 'err'); return ''; });
        if (data) state.pendingImages.push({ name: file.name, type: file.type, data });
      } else {
        const allowed = /\.(txt|md|json|csv|js|ts|py|html|css|xml|ya?ml|log)$/i.test(file.name);
        if (!allowed) {
          toast('فعلاً فایل متنی و کدنویسی یا تصویر پشتیبانی می‌شود؛ PDF و Word هنوز فعال نیست.', 'err');
          continue;
        }
        if (file.size > 200 * 1024) {
          toast('حجم فایل متنی باید حداکثر ۲۰۰ کیلوبایت باشد.', 'err');
          continue;
        }
        const content = await file.text();
        const block = '\n\n--- فایل پیوست: ' + file.name.replace(/[\\r\\n]/g, '') + ' ---\n' + content + '\n--- پایان فایل ---\n';
        if (els.messageInput) {
          els.messageInput.value = (els.messageInput.value || '') + block;
          resizeInput();
          updateCharCount();
        }
      }
    }
    if (els.attachmentInput) els.attachmentInput.value = '';
    renderAttachmentStatus();
  }

  function renderAttachmentStatus() {
    if (!els.attachmentStatus) return;
    const count = state.pendingImages.length;
    els.attachmentStatus.textContent = count ? ('📎 ' + count + ' تصویر آمادهٔ ارسال') : '';
  }

  function speakLastAnswer() {
    if (!state.lastAnswer) {
      toast('هنوز پاسخی برای خواندن وجود ندارد.', 'err');
      return;
    }
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      toast('مرورگر شما پخش گفتار را پشتیبانی نمی‌کند.', 'err');
      return;
    }
    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      if (els.btnSpeak) els.btnSpeak.textContent = '🔊 خواندن پاسخ';
      return;
    }
    const utterance = new SpeechSynthesisUtterance(state.lastAnswer.slice(0, 12000));
    utterance.lang = 'fa-IR';
    utterance.rate = 1;
    utterance.onend = utterance.onerror = () => {
      if (els.btnSpeak) els.btnSpeak.textContent = '🔊 خواندن پاسخ';
    };
    if (els.btnSpeak) els.btnSpeak.textContent = '⏹ توقف صدا';
    window.speechSynthesis.speak(utterance);
  }

  async function createImage(event) {
    event.preventDefault();
    const prompt = String(els.imagePrompt && els.imagePrompt.value || '').trim();
    if (prompt.length < 3) {
      if (els.imageMsg) els.imageMsg.textContent = 'توضیح تصویر کوتاه است.';
      return;
    }
    if (els.btnCreateImage) {
      els.btnCreateImage.disabled = true;
      els.btnCreateImage.textContent = 'در حال ساخت تصویر…';
    }
    if (els.imageMsg) els.imageMsg.textContent = 'ممکن است ساخت تصویر کمی زمان ببرد.';
    try {
      const result = await api('/api/image', { method: 'POST', body: { prompt } });
      if (!result || !result.image) throw new Error('سرویس تصویر خروجی معتبری برنگرداند.');
      closeModal('modalImage');
      const item = appendMessage('bot', 'تصویر ساخته‌شده با ArenaAi', {});
      const img = document.createElement('img');
      img.className = 'generated-image';
      img.alt = 'تصویر ساخته‌شده با هوش مصنوعی';
      img.loading = 'lazy';
      img.src = result.image;
      item._body.appendChild(img);
      if (els.imagePrompt) els.imagePrompt.value = '';
      if (els.imageMsg) els.imageMsg.textContent = 'تصویر آماده شد.';
      scrollBottom(true);
      toast('تصویر با موفقیت ساخته شد.', 'ok');
    } catch (error) {
      if (els.imageMsg) els.imageMsg.textContent = String(error && error.message || 'ساخت تصویر ناموفق بود.');
      toast(String(error && error.message || 'ساخت تصویر ناموفق بود.'), 'err');
    } finally {
      if (els.btnCreateImage) {
        els.btnCreateImage.disabled = false;
        els.btnCreateImage.textContent = 'ساخت تصویر';
      }
    }
  }

  function startVoiceInput() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      toast('مرورگر شما تبدیل گفتار به متن را پشتیبانی نمی‌کند. از Chrome یا Edge استفاده کن.', 'err');
      return;
    }
    const recognition = new Recognition();
    recognition.lang = 'fa-IR';
    recognition.continuous = false;
    recognition.interimResults = false;
    if (els.btnVoice) {
      els.btnVoice.disabled = true;
      els.btnVoice.textContent = '🎙 در حال شنیدن…';
    }
    recognition.onresult = (event) => {
      const transcript = event.results && event.results[0] && event.results[0][0]
        ? event.results[0][0].transcript : '';
      if (transcript && els.messageInput) {
        els.messageInput.value = (els.messageInput.value ? els.messageInput.value + ' ' : '') + transcript;
        resizeInput();
        updateCharCount();
        els.messageInput.focus();
      }
    };
    recognition.onerror = () => toast('دسترسی میکروفون یا تشخیص گفتار با خطا روبه‌رو شد.', 'err');
    recognition.onend = () => {
      if (els.btnVoice) {
        els.btnVoice.disabled = false;
        els.btnVoice.textContent = '🎙 ورودی صوتی';
      }
    };
    try { recognition.start(); } catch { toast('شروع ورودی صوتی ممکن نشد.', 'err'); if (els.btnVoice) els.btnVoice.disabled = false; }
  }

  /* ============================ send / stream ============================ */

  async function sendMessage(rawText, options = {}) {
    let text = String(rawText == null ? '' : rawText).trim();
    const images = state.pendingImages.slice(0, 2);
    if (!text && !images.length) return;
    if (state.streaming || state.maintenance || !state.platform || !state.model) {
      if (!state.model && text) {
        toast('اول از دکمهٔ «مدل» بالای صفحه یک مدل انتخاب کن.', 'err');
        openModelModal();
      }
      return;
    }

    let regenerate = !!options.regenerate;
    if (regenerate) text = state.lastUserText;

    if (els.messageInput && !regenerate) {
      els.messageInput.value = '';
      resizeInput();
      updateCharCount();
    }

    removeEmpty();
    removePreviousRegen();
    if (!regenerate) appendMessage('user', text + (images.length ? '\n📎 ' + images.length + ' تصویر پیوست شد' : ''), {});

    const placeholder = appendMessage('bot', '', {});
    setBotTyping(placeholder);

    state.streaming = true;
    setComposerState();
    setStreamState('در حال پاسخ…', true);

    const controller = new AbortController();
    state.abort = controller;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({
          message: regenerate ? state.lastUserText : text,
          platform: state.platform,
          model: state.model,
          persona: state.persona,
          deep: state.deep,
          regenerate,
          attachments: regenerate ? [] : images.map((item) => ({ name: item.name, type: item.type, data: item.data }))
        })
      });

      if (!res.ok) {
        let data = null;
        try { data = await res.json(); } catch { /* ignore */ }
        const msg = (data && (data.error || data.message)) || ('خطای سرور (' + res.status + ')');
        throw new Error(msg);
      }
      if (!res.body) throw new Error('پخش پاسخ پشتیبانی نمی‌شود.');
      await readSse(res.body, placeholder);
    } catch (e) {
      if (e && (e.name === 'AbortError')) {
        flushStream(placeholder);
        setStreamState('متوقف شد');
        toast('پاسخ متوقف شد.');
      } else {
        setBotFinal(placeholder, '⚠️ ' + String((e && e.message) || 'خطا در دریافت پاسخ.'));
        setStreamState('خطا');
        toast(String((e && e.message) || 'خطا'), 'err');
      }
    } finally {
      state.streaming = false;
      state.abort = null;
      if (!regenerate && images.length) {
        state.pendingImages = [];
        renderAttachmentStatus();
      }
      setComposerState();
      setStreamState('');
      messageInputFocus();
      if (placeholder && placeholder._md) {
        const plain = placeholder._answer || (placeholder._md.innerText || '');
        /* error placeholders don't count as an answer to regenerate */
        if (plain && plain.trim() && !/^\s*⚠️/.test(plain.trim())) {
          if (!regenerate) state.lastUserText = text;
          state.lastAnswer = plain;
          addRegenAction(placeholder);
        }
      }
    }
  }

  function setStreamState(text, live = false) {
    if (!els.streamState) return;
    els.streamState.textContent = text || '';
    els.streamState.classList.toggle('live', !!live);
  }

  async function readSse(body, bot) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let first = true;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const frame = parseSseFrame(block);
        if (!frame) continue;

        if (frame.type === 'ping') continue;
        if (frame.type === 'meta') {
          if (frame.fallback) setStreamState('پاسخ از ' + (frame.model || 'پلتفرم جایگزین'), true);
          continue;
        }
        if (frame.type === 'reasoning') {
          bot._reasoning = (bot._reasoning || '') + frame.v;
          ensureReasoning(bot, bot._reasoning);
          continue;
        }
        if (frame.type === 'saving') { setStreamState('ذخیره در حافظه…', true); continue; }
        if (frame.type === 'error') {
          throw new Error(frame.msg || 'خطای جریان');
        }
        if (frame.type === 'delta') {
          if (first) {
            first = false;
            ensureVisible(bot);
          }
          bot._answer = (bot._answer || '') + frame.v;
          scheduleStreamRender(bot);
          scrollBottom(false);
          continue;
        }
        if (frame.type === 'done') {
          if (frame.ok === false && !bot._answer) {
            bot._answer = '⚠️ مدل پاسخی برنگرداند. مدل دیگری انتخاب کنید.';
          }
          if (frame.model) {
            const mm = $('.m-model', bot);
            if (mm) mm.textContent = frame.model;
          }
          /* terminal frame: render the final answer, drop the caret */
          flushStream(bot);
        }
      }
    }
    /* safety net: stream ended without a done frame (network cut, server close) */
    if (bot._answer) flushStream(bot);
  }

  /* render at most once per animation frame while deltas flood in */
  function scheduleStreamRender(bot) {
    if (!bot.raf) {
      bot.raf = requestAnimationFrame(() => {
        bot.raf = null;
        if (bot._answer !== undefined) setBotText(bot, bot._answer);
      });
    }
  }

  /* cancel pending throttle and write the final markdown (removes the caret) */
  function flushStream(bot) {
    if (bot.raf) {
      cancelAnimationFrame(bot.raf);
      bot.raf = null;
    }
    if (bot._md) setBotFinal(bot, bot._answer || '');
  }

  function ensureVisible(bot) {
    if (!bot || !bot._md) return;
    const sp = $('.typing', bot._md);
    if (sp) sp.remove();
  }

  /** Wire protocol: `data: {json}` frames, no event: lines. */
  function parseSseFrame(block) {
    for (const line of String(block).split('\n')) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      try {
        const f = JSON.parse(raw);
        if (f && typeof f === 'object' && f.type) return f;
      } catch { /* non-json frame */ }
    }
    return null;
  }

  function addRegenAction(bot) {
    if (!bot || bot.querySelector('[data-action="regen"]')) return;
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const copy = document.createElement('button');
    copy.className = 'mini-btn';
    copy.type = 'button';
    copy.dataset.action = 'copy';
    copy.textContent = '⧉ کپی';
    const regen = document.createElement('button');
    regen.className = 'mini-btn';
    regen.type = 'button';
    regen.dataset.action = 'regen';
    regen.textContent = '↻ دوباره';
    actions.appendChild(copy);
    actions.appendChild(regen);
    bot.appendChild(actions);
  }

  function lastBotMessage() {
    const bots = $$('.msg.bot', els.chatLog);
    return bots.length ? bots[bots.length - 1] : null;
  }

  function lastUserMessageText() {
    const users = $$('.msg.user .body', els.chatLog);
    return users.length ? users[users.length - 1].textContent : state.lastUserText;
  }

  function stopStreaming() {
    if (state.abort) state.abort.abort();
  }

  /* ============================ model picker ============================ */

  function openModelModal() {
    state.pickerPlatform = state.platform || state.pickerPlatform;
    renderPlatformTabs();
    openModal('modalModel');
    loadModels(state.pickerPlatform, false);
    if (els.freeOnlyToggle) els.freeOnlyToggle.checked = state.freeOnly;
  }

  function renderPlatformTabs() {
    if (!els.platformTabs) return;
    const platforms = (state.config && state.config.platforms) || [];
    els.platformTabs.innerHTML = platforms.map((p) => {
      const prov = ((state.config && state.config.providers) || {})[p.id] || {};
      return '<button type="button" class="ptab' + (p.id === state.pickerPlatform ? ' active' : '') + '" role="tab" aria-selected="' +
        (p.id === state.pickerPlatform) + '" data-platform="' + esc(p.id) + '">' +
        '<span>' + esc(p.icon || '') + ' ' + esc(p.faLabel || p.id) + '</span>' +
        (prov.ready ? '' : '<span class="muted-dot" title="کلیدی تنظیم نشده است"></span>') + '</button>';
    }).join('');
  }

  async function loadModels(platformId, refresh) {
    if (!els.modelList) return;
    try {
      els.modelCount.textContent = 'در حال دریافت مدل‌ها…';
      els.modelList.innerHTML = '<div class="model-empty"><span class="spinner"></span>دریافت فهرست واقعی مدل‌ها از ' + esc(platformLabel(platformId)) + '…</div>';
      const data = await api('/api/models?platform=' + encodeURIComponent(platformId) + (refresh ? '&refresh=1' : ''));
      const models = data.models || [];
      state.modelCache.set(platformId, { models, provider: data.provider, ts: Date.now() });
      renderModels(models, data.provider);
    } catch (e) {
      els.modelList.innerHTML = '<div class="model-empty">⚠️ دریافت مدل‌ها ناموفق بود: ' + esc(String((e && e.message) || e)) +
        '<br><button class="mini-btn" type="button" id="retryModels">تلاش دوباره</button></div>';
      const retry = $('#retryModels', els.modelList);
      if (retry) retry.addEventListener('click', () => loadModels(platformId, refresh));
      els.modelCount.textContent = '—';
    }
  }

  function renderModels(models, provider) {
    if (!els.modelList) return;
    const q = (els.modelSearch && els.modelSearch.value || '').trim().toLowerCase();
    let list = [...models];
    if (state.freeOnly) list = list.filter((m) => m.free === true);
    if (q) {
      list = list.filter((m) =>
        String(m.id || '').toLowerCase().includes(q) ||
        String(m.name || '').toLowerCase().includes(q) ||
        String(m.desc || '').toLowerCase().includes(q)
      );
    }
    const persona = personaById(state.persona);
    const rec = persona && persona.recommended ? persona.recommended[state.pickerPlatform] : '';

    if (els.modelCount) {
      els.modelCount.textContent = provider && provider.keyMask
        ? (list.length + ' مدل از ' + list.filter((m) => m.free).length + ' رایگان — کلید: ' + provider.keyMask)
        : (list.length + ' مدل از ' + list.filter((m) => m.free).length + ' رایگان');
    }
    if (els.modelNote) {
      if (provider && provider.keyMask) { els.modelNote.hidden = true; els.modelNote.textContent = ''; }
      else {
        els.modelNote.hidden = false;
        els.modelNote.textContent = 'کلید این پلتفرم تنظیم نشده است؛ برای همهٔ مدل‌ها باید مدیر از پنل کلید اضافه کند. مدل‌های WorkAI/پیش‌فرض بدون کلید کار می‌کنند.';
      }
    }
    if (!list.length) {
      els.modelList.innerHTML = '<div class="model-empty">' +
        (state.freeOnly || q ? 'مدلی با این فیلترها پیدا نشد. فیلتر «فقط رایگان» یا عبارت جستجو را تغییر بده.' : 'مدلی در فهرست نیست؛ ← را بزن.') + '</div>';
      return;
    }
    els.modelList.innerHTML = list.map((m) => {
      const isActive = state.platform === state.pickerPlatform && state.model === m.id;
      const isRec = m.id === rec;
      const badges = [
        m.free ? '<span class="badge free">رایگان</span>' : '',
        isRec ? '<span class="badge ok">پیشنهادی این عامل</span>' : '',
        m.ctx ? '<span class="badge">context ' + formatNum(m.ctx) + '</span>' : '',
        m.max ? '<span class="badge">max ' + formatNum(m.max) + '</span>' : ''
      ].join('');
      return '<button type="button" class="model-row' + (isActive ? ' active' : '') + '" role="listitem" data-model-id="' + esc(m.id) + '" data-model-name="' + esc(m.name || m.id) + '">' +
        '<span class="model-name">' + esc(m.name || m.id) + badges + '</span>' +
        '<span class="model-id">' + esc(m.id) + '</span>' +
        (m.desc ? '<span class="model-desc">' + esc(m.desc) + '</span>' : '') + '</button>';
    }).join('');
  }

  function formatNum(n) {
    try { return new Intl.NumberFormat('en-US').format(Math.round(Number(n) || 0)); }
    catch { return String(n); }
  }

  function selectModel(platformId, id, name) {
    state.platform = platformId;
    state.model = id;
    state.modelName = String(name || '').trim() || prettyModel(id);
    saveLocalPrefs();
    savePrefs({ platform: platformId, model: id });
    renderCurrent();
    closeAllModals();
    toast('مدل انتخاب شد: ' + (state.modelName || prettyModel(id)), 'ok');
  }

  /* ============================ persona picker ============================ */

  function openPersonaModal() {
    renderPersonaGrid();
    openModal('modalPersona');
  }

  function renderPersonaGrid() {
    if (!els.personaGrid) return;
    els.personaGrid.innerHTML = state.personas.map((p) => {
      const active = p.id === state.persona;
      const rec = p.recommended && p.recommended[state.platform];
      const exp = Array.isArray(p.expertise) && p.expertise.length
        ? '<span class="persona-exp">' + p.expertise.slice(0, 4).map((x) => '<span>' + esc(x) + '</span>').join('') + '</span>' : '';
      return '<button type="button" class="persona-card' + (active ? ' active' : '') + '" data-persona="' + esc(p.id) + '">' +
        '<span class="pc-top"><span class="persona-emoji">' + esc(p.emoji) + '</span>' +
        '<span class="persona-name">' + esc(p.name) + (active ? ' ✓' : '') + '</span></span>' +
        '<span class="persona-tag">' + esc(p.tagline || '') + '</span>' +
        exp +
        (rec ? '<span class="persona-rec">💡 پیشنهاد: <span class="mono">' + esc(rec) + '</span></span>' : '') +
        (rec ? '<span class="persona-use-rec" role="button" tabindex="0" data-use-rec="' + esc(p.id) + '">انتخاب مدل پیشنهادی</span>' : '') +
        '</button>';
    }).join('');
    if (els.personaCurrentLabel) {
      const current = personaById(state.persona);
      els.personaCurrentLabel.textContent = current ? current.name : '—';
    }
  }

  function selectPersona(id, useRec) {
    const p = personaById(id);
    if (!p) return;
    state.persona = id;
    if (useRec && p.recommended && p.recommended[state.platform]) {
      state.model = p.recommended[state.platform];
      state.modelName = '';
      savePrefs({ platform: state.platform, model: state.model, persona: id });
    } else {
      savePrefs({ persona: id });
    }
    saveLocalPrefs();
    renderCurrent();
    closeAllModals();
    toast('عامل «' + p.name + '» فعال شد.', 'ok');
  }

  /* ============================ prefs / reset ============================ */

  async function savePrefs(patch) {
    try {
      await api('/api/prefs', { method: 'POST', body: patch });
    } catch { /* silent */ }
  }

  async function newChat() {
    try {
      await api('/api/reset', { method: 'POST', body: { mode: 'chat' } });
      renderEmpty();
      state.lastUserText = '';
      state.lastAnswer = '';
      toast('گفتگوی تازه شروع شد. 🌱', 'ok');
      messageInputFocus();
    } catch (e) {
      toast(String((e && e.message) || 'خطا'), 'err');
    }
  }

  async function resetMemory(mode) {
    try {
      await api('/api/reset', { method: 'POST', body: { mode } });
      closeAllModals();
      if (mode !== 'memory') {
        renderEmpty();
        state.lastUserText = '';
        state.lastAnswer = '';
      }
      const labels = {
        chat: 'گفتگوی جاری پاک شد.',
        memory: 'دانسته‌ها و خلاصهٔ حافظه فراموش شد.',
        all: 'کل حافظهٔ این حساب پاک شد.'
      };
      toast(labels[mode] || 'انجام شد.', 'ok');
    } catch (e) {
      toast(String((e && e.message) || 'خطا'), 'err');
    }
  }

  /* ============================ support / feedback ============================ */

  function openSupport() {
    openModal('modalSupport');
  }

  async function submitFeedback(e) {
    e.preventDefault();
    if (!els.feedbackText) return;
    const text = String(els.feedbackText.value || '').trim();
    if (!text) return;
    const btn = $('button[type="submit"]', els.feedbackForm);
    if (btn) btn.disabled = true;
    try {
      await api('/api/feedback', { method: 'POST', body: { text } });
      els.feedbackText.value = '';
      if (els.feedbackMsg) {
        els.feedbackMsg.textContent = 'بازخوردت رسید؛ ممنون! 🙏';
        els.feedbackMsg.className = 'fb-msg';
      }
      setTimeout(() => { if (els.feedbackMsg) els.feedbackMsg.textContent = ''; }, 4000);
      toast('بازخورد ارسال شد. 🙏', 'ok');
    } catch (err) {
      if (els.feedbackMsg) {
        els.feedbackMsg.textContent = 'ارسال ناموفق بود: ' + String((err && err.message) || '');
        els.feedbackMsg.className = 'fb-msg err';
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ============================ modals / toast ============================ */

  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    closeAllModals();
    modal.hidden = false;
    document.body.classList.add('modal-open');
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.hidden = true;
    if (!$$('.modal:not([hidden])').length) document.body.classList.remove('modal-open');
  }

  function closeAllModals() {
    $$('.modal:not([hidden])').forEach((m) => { m.hidden = true; });
    document.body.classList.remove('modal-open');
  }

  function toast(message, type = '') {
    if (!els.toastWrap) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = message;
    els.toastWrap.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.2s';
      setTimeout(() => el.remove(), 220);
    }, type === 'err' ? 5200 : 3200);
  }

  function renderFatal(error) {
    if (!els.chatLog) return;
    const message = String((error && error.message) || error || 'خطای ناشناخته');
    const setup = !!(error && error.data && error.data.setup);
    els.chatLog.innerHTML =
      '<div class="empty-state">' +
        '<span class="hero-eyebrow">ARENA AI — ERROR</span>' +
        '<hr class="hero-rule" />' +
        '<h1 class="hero-title">اتصال برقرار نشد</h1>' +
        '<p class="hero-sub">' + (setup
          ? 'فضای ذخیره‌سازی KV هنوز تنظیم نشده است. مدیر باید طبق README یک namespace با نام DB بسازد و شناسهٔ آن را در wrangler.toml قرار دهد.'
          : 'دریافت تنظیمات از سرور ناموفق بود. اتصال اینترنت و تنظیمات Worker را بررسی کن.') + '</p>' +
        '<p class="mini-note" dir="ltr">' + esc(message) + '</p>' +
        '<a class="btn primary" style="align-self:flex-start" href="https://t.me/technamooz_support" target="_blank" rel="noopener">🆘 پشتیبانی @technamooz_support</a>' +
      '</div>';
    if (els.btnSend) els.btnSend.disabled = true;
    if (els.messageInput) els.messageInput.disabled = true;
  }

  /* ============================ events ============================ */

  function bindEvents() {
    if (els.chipPersona) els.chipPersona.addEventListener('click', openPersonaModal);
    if (els.chipModel) els.chipModel.addEventListener('click', openModelModal);
    if (els.btnSupportTop) els.btnSupportTop.addEventListener('click', openSupport);
    if (els.btnNewChat) els.btnNewChat.addEventListener('click', newChat);
    if (els.btnReset) els.btnReset.addEventListener('click', () => openModal('modalReset'));

    if (els.btnDeep) {
      els.btnDeep.addEventListener('click', () => {
        state.deep = !state.deep;
        renderCurrent();
        saveLocalPrefs();
        savePrefs({ deep: state.deep });
        toast(state.deep ? '⚡ حالت نهایت قدرت روشن شد.' : 'حالت نهایت قدرت خاموش شد.', 'ok');
      });
    }

    if (els.composerForm) {
      els.composerForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!state.streaming) sendMessage(els.messageInput ? els.messageInput.value : '');
      });
    }
    if (els.btnStop) els.btnStop.addEventListener('click', stopStreaming);
    if (els.btnAttach && els.attachmentInput) {
      els.btnAttach.addEventListener('click', () => els.attachmentInput.click());
      els.attachmentInput.addEventListener('change', handleAttachments);
    }
    if (els.btnVoice) els.btnVoice.addEventListener('click', startVoiceInput);
    if (els.btnImage) els.btnImage.addEventListener('click', () => openModal('modalImage'));
    if (els.btnSpeak) els.btnSpeak.addEventListener('click', speakLastAnswer);
    if (els.imageForm) els.imageForm.addEventListener('submit', createImage);
    if (els.messageInput) {
      els.messageInput.addEventListener('input', () => {
        resizeInput();
        updateCharCount();
      });
      els.messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (!state.streaming) sendMessage(els.messageInput.value);
        }
      });
    }

    if (els.chatLog) {
      els.chatLog.addEventListener('click', async (e) => {
        const quick = e.target.closest('[data-quick]');
        if (quick) {
          sendMessage(quick.dataset.quick);
          return;
        }
        const copyCode = e.target.closest('.copy-code');
        if (copyCode) {
          const block = copyCode.closest('.code-block');
          const code = block && block.querySelector('pre code');
          if (code) {
            await copyText(code.textContent || '');
            copyCode.textContent = 'کپی شد ✓';
            setTimeout(() => { copyCode.textContent = 'کپی'; }, 1600);
          }
          return;
        }
        const action = e.target.closest('[data-action]');
        if (action) {
          const msg = action.closest('.msg');
          if (action.dataset.action === 'copy') {
            const md = msg && msg.querySelector('.md');
            await copyText(md ? md.innerText : '');
            toast('متن کپی شد.', 'ok');
          } else if (action.dataset.action === 'regen') {
            if (msg !== lastBotMessage()) {
              toast('فقط آخرین پاسخ را می‌توان دوباره تولید کرد.', 'err');
              return;
            }
            sendMessage(lastUserMessageText(), { regenerate: true });
          }
        }
      });
    }

    if (els.platformTabs) {
      els.platformTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-platform]');
        if (!btn) return;
        state.pickerPlatform = btn.dataset.platform;
        renderPlatformTabs();
        loadModels(state.pickerPlatform, false);
      });
    }
    if (els.modelList) {
      els.modelList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-model-id]');
        if (!btn) return;
        selectModel(state.pickerPlatform, btn.dataset.modelId, btn.dataset.modelName);
      });
    }
    if (els.freeOnlyToggle) {
      els.freeOnlyToggle.addEventListener('change', () => {
        state.freeOnly = !!els.freeOnlyToggle.checked;
        const cached = state.modelCache.get(state.pickerPlatform);
        if (cached) renderModels(cached.models, cached.provider);
        saveLocalPrefs();
        savePrefs({ freeOnly: state.freeOnly });
      });
    }
    if (els.modelSearch) {
      let timer = null;
      els.modelSearch.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const cached = state.modelCache.get(state.pickerPlatform);
          if (cached) renderModels(cached.models, cached.provider);
        }, 120);
      });
    }
    if (els.btnRefreshModels) {
      els.btnRefreshModels.addEventListener('click', () => loadModels(state.pickerPlatform, true));
    }

    if (els.personaGrid) {
      els.personaGrid.addEventListener('click', (e) => {
        const recBtn = e.target.closest('[data-use-rec]');
        if (recBtn) {
          e.stopPropagation();
          selectPersona(recBtn.dataset.useRec, true);
          return;
        }
        const card = e.target.closest('[data-persona]');
        if (card) selectPersona(card.dataset.persona, false);
      });
    }

    if (els.feedbackForm) els.feedbackForm.addEventListener('submit', submitFeedback);

    $$('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.close));
    });
    $$('.modal').forEach((modal) => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal.id);
      });
    });
    if (els.modalReset) {
      els.modalReset.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-reset]');
        if (btn) resetMemory(btn.dataset.reset);
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllModals();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openModelModal();
      }
    });
  }

  function resizeInput() {
    if (!els.messageInput) return;
    els.messageInput.style.height = 'auto';
    els.messageInput.style.height = Math.min(180, Math.max(30, els.messageInput.scrollHeight)) + 'px';
  }

  function updateCharCount() {
    if (!els.charCount || !els.messageInput) return;
    els.charCount.textContent = els.messageInput.value.length + ' / ' + (els.messageInput.maxLength || 24000);
  }

  /* ============================ utilities ============================ */

  async function copyText(text) {
    const value = String(text || '');
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch { /* fallback */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ============================ markdown ============================ */

  function mdRender(input) {
    let text = String(input == null ? '' : input).replace(/\r\n/g, '\n');

    const codeBlocks = [];
    text = text.replace(/```([\w.+-]*)[ \t]*\n?([\s\S]*?)```/g, (_, lang, code) => {
      codeBlocks.push({ lang: lang || 'code', code: String(code).replace(/\n$/, '') });
      return '\u0000B' + (codeBlocks.length - 1) + '\u0000';
    });

    const inlineCodes = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      inlineCodes.push(code);
      return '\u0000I' + (inlineCodes.length - 1) + '\u0000';
    });

    text = esc(text);
    const lines = text.split('\n');
    let html = '';
    let i = 0;

    const inline = (s) => inlineMd(s, inlineCodes);
    const isBlock = (line, next) =>
      /^#{1,4}\s+/.test(line) ||
      /^>\s?/.test(line) ||
      /^\s*[-*+]\s+/.test(line) ||
      /^\s*\d+\.\s+/.test(line) ||
      /^\s*(---|\*\*\*|___)\s*$/.test(line) ||
      /^\u0000B\d+\u0000$/.test(line) ||
      (line.includes('|') && next && /^\s*\|?\s*:?-{3,}/.test(next));

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      const onlyBlock = line.match(/^\u0000B(\d+)\u0000$/);
      if (onlyBlock) {
        html += renderCodeBlock(codeBlocks[Number(onlyBlock[1])]);
        i++;
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        html += '<h' + level + '>' + inline(heading[2]) + '</h' + level + '>';
        i++;
        continue;
      }

      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        html += '<hr />';
        i++;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        html += '<blockquote>' + buf.map(inline).join('<br>') + '</blockquote>';
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line);
        const re = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/;
        const items = [];
        while (i < lines.length && re.test(lines[i])) {
          items.push(lines[i].replace(re, ''));
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        html += '<' + tag + '>' + items.map((x) => '<li>' + inline(x) + '</li>').join('') + '</' + tag + '>';
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
        const header = splitTableRow(line);
        const aligns = splitTableRow(lines[i + 1]).map((c) =>
          /:\s*$/.test(c) ? 'center' : /^:/.test(c) ? 'right' : 'right'
        );
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitTableRow(lines[i]));
          i++;
        }
        html += '<table><thead><tr>' +
          header.map((c, ci) => '<th' + (aligns[ci] ? ' style="text-align:' + aligns[ci] + '"' : '') + '>' + inline(c) + '</th>').join('') +
          '</tr></thead><tbody>' +
          rows.map((row) => '<tr>' + row.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
          '</tbody></table>';
        continue;
      }

      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlock(lines[i], lines[i + 1])) {
        buf.push(lines[i]);
        i++;
      }
      html += '<p>' + buf.map(inline).join('<br>') + '</p>';
    }

    html = html.replace(/\u0000I(\d+)\u0000/g, (_, idx) => '<code>' + esc(inlineCodes[Number(idx)] || '') + '</code>');
    html = html.replace(/\u0000B(\d+)\u0000/g, (_, idx) => renderCodeBlock(codeBlocks[Number(idx)]));
    return html || '<p class="md-note">…</p>';
  }

  function splitTableRow(line) {
    let s = String(line).trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((x) => x.trim());
  }

  function renderCodeBlock(block) {
    if (!block) return '';
    return '<div class="code-block"><div class="code-head"><span>' + esc(block.lang || 'code') +
      '</span><button class="copy-code" type="button">کپی</button></div>' +
      '<pre><code>' + esc(block.code || '') + '</code></pre></div>';
  }

  function inlineMd(input, inlineCodes) {
    let s = String(input == null ? '' : input);

    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, label, url) =>
      '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
    );
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/(^|[^\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/\u0000I(\d+)\u0000/g, (_, idx) => '<code>' + esc(inlineCodes[Number(idx)] || '') + '</code>');
    return s;
  }
})();
