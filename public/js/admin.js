// ============================================================
//  ArenaAi AI — technamooz-ai-version1.0.0
//  Author: Amir Parsa (امیر پارسا)
//  public/js/admin.js — secure admin panel (CSRF protected)
// ============================================================

(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const PLATFORMS = [
    { id: 'workersai', label: 'کلادفلر (Workers AI)', icon: '☁️' },
    { id: 'openrouter', label: 'OpenRouter', icon: '🌐' },
    { id: 'orcarouter', label: 'OrcaRouter', icon: '🐋' },
    { id: 'onerouter', label: 'OneRouter', icon: '🧭' }
  ];

  const VIEW_META = {
    overview: ['نمای کلی', 'وضعیت کلی آرنا ای‌آی در یک نگاه'],
    keys: ['کلیدها و اتصال‌ها', 'مدیریت کلیدهای چهار پلتفرم و Cloudflare'],
    models: ['مدل‌ها', 'لیست واقعی مدل‌های هر پلتفرم'],
    telegram: ['ربات تلگرام', 'توکن، وبهوک، ادمین‌ها و ارسال همگانی'],
    users: ['کاربران', 'کاربران وب و تلگرام و حافظهٔ آن‌ها'],
    logs: ['گزارش‌ها', 'رویدادهای امنیتی، خطاها و بازخوردها'],
    settings: ['تنظیمات', 'پیش‌فرض‌ها، حافظه، حالت نهایت قدرت و تعمیرات'],
    security: ['امنیت و اعتبارنامه', 'تغییر رمز، نام کاربری و ابطال نشست‌ها']
  };

  const state = {
    csrf: null,
    mustChange: false,
    user: '',
    view: 'overview',
    overview: null,
    keys: null,
    adminModels: [],
    modelsPlatform: 'workersai',
    modelSearch: '',
    userSource: 'web',
    userPage: 1,
    users: null,
    userDetail: null,
    userDetailSource: 'web',
    userDetailId: null,
    logs: [],
    settingsData: null,
    security: null,
    busy: false
  };

  const els = {};

  document.addEventListener('DOMContentLoaded', boot);

  async function boot() {
    cache();
    bind();

    try {
      const status = await rawApi('/admin/status');
      if (status.authed) {
        state.csrf = status.csrf;
        state.mustChange = !!status.mustChange;
        state.user = 'مدیر';
        showApp();
        showView('overview');
      } else {
        showLogin();
      }
    } catch (e) {
      showLogin();
      setLoginMessage((e && e.data && e.data.setup)
        ? 'KV تنظیم نشده است. ابتدا namespace با نام DB بسازید و در wrangler.toml قرار دهید.'
        : ('اتصال به سرور برقرار نشد: ' + (e.message || '')), true);
    }
  }

  function cache() {
    [
      'loginView', 'appView', 'loginForm', 'loginUser', 'loginPass', 'loginBtn',
      'loginMsg', 'adminSidebar', 'btnMenu', 'viewTitle', 'viewSub', 'adminUser',
      'btnRefreshTop', 'btnLogoutTop', 'btnLogoutSide', 'mustChangeBanner',
      'maintenanceBanner', 'overviewContent', 'keysContent', 'panelKeys',
      'btnKeysRefresh', 'adminPlatformTabs', 'adminModelSearch', 'adminModelCount',
      'btnAdminModelsRefresh', 'adminModelsContent', 'telegramContent',
      'btnTelegramRefresh', 'usersContent', 'userSourceTabs', 'usersPager',
      'btnUsersRefresh', 'logsContent', 'logType', 'btnLogsRefresh',
      'btnLogsClear', 'settingsForm', 'settingsContent', 'settingsMsg',
      'btnSettingsSave', 'btnSettingsRefresh', 'securityContent',
      'modalUser', 'userModalTitle', 'userModalBody', 'toastWrap'
    ].forEach((id) => { els[id] = document.getElementById(id); });
  }

  /* ============================ HTTP ============================ */

  async function rawApi(path, options = {}) {
    const opts = {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: { ...(options.headers || {}) }
    };
    if (options.body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(options.body);
    }
    const res = await fetch(path, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: false, error: text.slice(0, 300) }; }
    if (!res.ok || data.ok === false) {
      const err = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function adminApi(path, options = {}) {
    const opts = {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: { ...(options.headers || {}) }
    };
    if (opts.method !== 'GET' && state.csrf) opts.headers['X-CSRF-Token'] = state.csrf;
    if (options.body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(options.body);
    }

    const res = await fetch(path, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: false, error: text.slice(0, 300) }; }

    if (res.status === 401) {
      state.csrf = null;
      showLogin();
      const err = new Error('نشست شما منقضی شده است؛ دوباره وارد شوید.');
      err.status = 401;
      err.handled = true;
      throw err;
    }
    if (!res.ok || data.ok === false) {
      const err = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ============================ auth UI ============================ */

  async function doLogin(e) {
    e.preventDefault();
    const username = String(els.loginUser.value || '').trim();
    const password = String(els.loginPass.value || '');
    if (!username || !password) {
      setLoginMessage('نام کاربری و رمز عبور را وارد کنید.', true);
      return;
    }
    els.loginBtn.disabled = true;
    els.loginBtn.textContent = 'در حال ورود…';
    try {
      const data = await rawApi('/admin/login', { method: 'POST', body: { username, password } });
      state.csrf = data.csrf;
      state.mustChange = !!data.mustChange;
      state.user = username;
      els.loginPass.value = '';
      showApp();
      showView('overview');
      toast('خوش آمدید 👋', 'ok');
    } catch (err) {
      setLoginMessage(err.message || 'ورود ناموفق بود.', true);
    } finally {
      els.loginBtn.disabled = false;
      els.loginBtn.textContent = 'ورود به پنل';
    }
  }

  async function doLogout() {
    try {
      await adminApi('/admin/logout', { method: 'POST' });
    } catch (e) {
      if (!e.handled) toast(e.message || 'خروج ناموفق بود.', 'err');
    }
    state.csrf = null;
    showLogin();
  }

  function showLogin() {
    if (els.appView) els.appView.hidden = true;
    if (els.loginView) els.loginView.hidden = false;
    if (els.loginPass) els.loginPass.value = '';
    setLoginMessage('', false);
    closeSidebar();
    setTimeout(() => { if (els.loginUser) els.loginUser.focus(); }, 80);
  }

  function showApp() {
    if (els.loginView) els.loginView.hidden = true;
    if (els.appView) els.appView.hidden = false;
    if (els.adminUser) els.adminUser.textContent = state.user || 'مدیر';
    updateBanners();
  }

  function setLoginMessage(text, isError) {
    if (!els.loginMsg) return;
    els.loginMsg.hidden = !text;
    els.loginMsg.textContent = text || '';
    els.loginMsg.style.color = isError ? 'var(--err)' : 'var(--ok)';
  }

  function updateBanners() {
    if (els.mustChangeBanner) els.mustChangeBanner.hidden = !state.mustChange;
    const settings = (state.overview && state.overview.settings) || (state.settingsData && state.settingsData.settings);
    if (els.maintenanceBanner) els.maintenanceBanner.hidden = !(settings && settings.maintenance);
  }

  /* ============================ navigation ============================ */

  function showView(name) {
    if (!VIEW_META[name]) name = 'overview';
    state.view = name;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $$('.admin-panel').forEach((p) => {
      const active = p.dataset.panel === name;
      p.hidden = !active;
      p.classList.toggle('active', active);
    });
    const meta = VIEW_META[name];
    if (els.viewTitle) els.viewTitle.textContent = meta[0];
    if (els.viewSub) els.viewSub.textContent = meta[1];
    closeSidebar();

    if (name === 'overview') loadOverview();
    else if (name === 'keys') loadKeys();
    else if (name === 'models') loadAdminModels();
    else if (name === 'telegram') loadTelegram();
    else if (name === 'users') loadUsers();
    else if (name === 'logs') loadLogs();
    else if (name === 'settings') loadSettings();
    else if (name === 'security') loadSecurity();
  }

  function refreshCurrent() {
    showView(state.view);
  }

  function openSidebar() {
    if (els.adminSidebar) els.adminSidebar.classList.add('open');
  }

  function closeSidebar() {
    if (els.adminSidebar) els.adminSidebar.classList.remove('open');
  }

  /* ============================ overview ============================ */

  async function loadOverview() {
    if (!els.overviewContent) return;
    els.overviewContent.innerHTML = loading('در حال دریافت وضعیت…');
    try {
      const data = await adminApi('/admin/api/overview');
      state.overview = data;
      state.user = (data.session && data.session.user) || state.user;
      if (els.adminUser) els.adminUser.textContent = state.user || 'مدیر';
      renderOverview(data);
      updateBanners();
    } catch (e) {
      if (!e.handled) els.overviewContent.innerHTML = errorBox(e.message || 'دریافت وضعیت ناموفق بود.');
    }
  }

  function renderOverview(data) {
    const counts = data.counts || {};
    const totals = data.totals || {};
    const providers = data.providers || {};
    const ready = Object.values(providers).filter((p) => p && p.ready).length;
    const tg = data.telegram || {};
    const settings = data.settings || {};
    const stats = Array.isArray(data.stats) ? data.stats : [];
    const recent = Array.isArray(data.recent) ? data.recent : [];
    const maxStat = Math.max(1, ...stats.map((s) => (Number(s.web_msgs) || 0) + (Number(s.tg_msgs) || 0)));

    const cards = [
      statCard('👥', 'کل کاربران', fmtNum(counts.total), 'وب ' + fmtNum(counts.web) + ' · تلگرام ' + fmtNum(counts.tg)),
      statCard('💬', 'پیام‌های وب', fmtNum(totals.web_msgs), 'در ۷ روز اخیر'),
      statCard('✈️', 'پیام‌های تلگرام', fmtNum(totals.tg_msgs), 'در ۷ روز اخیر'),
      statCard('📝', 'بازخوردها', fmtNum(totals.feedbacks), 'در ۷ روز اخیر'),
      statCard('🎨', 'تصاویر ساخته‌شده', fmtNum(totals.image_generations), 'در ۷ روز اخیر'),
      statCard('🧩', 'سرویس‌های آماده', ready + ' از ' + Object.keys(providers).length, 'اتصال‌های هوش مصنوعی'),
      statCard('🤖', 'شخصیت‌ها', fmtNum(data.personas), 'شخصیت تخصصی')
    ].join('');

    const providerUsage = data.providerUsage || {};
    const usageRows = Object.entries(providerUsage).map(([id, count]) =>
      '<div class="provider-row"><span class="provider-name">' + esc(id) + '</span><strong>' + fmtNum(count) + ' درخواست</strong></div>'
    ).join('');

    const providerRows = Object.entries(providers).map(([id, p]) => {
      return '<div class="provider-row">' +
        '<span class="provider-name">' + esc(p.label || id) + '</span>' +
        statusBadge(!!p.ready, p.ready ? (p.mode === 'binding' ? 'binding' : 'آماده') : 'نیاز به کلید') +
        '<span class="provider-meta">' + (p.ready ? esc(p.keyMask || (p.mode === 'binding' ? 'Workers AI Binding' : 'تنظیم شده')) : '—') + '</span>' +
        '<button class="mini-btn" type="button" data-goto="keys">مدیریت</button>' +
      '</div>';
    }).join('');

    const bars = stats.map((s) => {
      const value = (Number(s.web_msgs) || 0) + (Number(s.tg_msgs) || 0);
      const h = Math.max(4, Math.round(value / maxStat * 100));
      return '<div class="bar-col" title="' + esc(s.date) + ' — ' + value + ' پیام">' +
        '<div class="bar" style="height:' + h + '%"></div>' +
        '<span>' + esc(String(s.date || '').slice(5)) + '</span>' +
      '</div>';
    }).join('');

    els.overviewContent.innerHTML =
      '<div class="stat-grid">' + cards + '</div>' +
      '<div class="dash-grid">' +
        '<section class="admin-card">' +
          '<div class="card-head"><h3>اتصال پلتفرم‌ها</h3><button class="mini-btn" type="button" data-goto="keys">تنظیم کلیدها</button></div>' +
          '<div class="provider-list">' + (providerRows || '<p class="muted">پلتفرمی ثبت نشده.</p>') + '</div>' +
          '<div class="tg-strip">✈️ تلگرام: ' + (tg.configured ? ('متصل @' + esc(tg.username || '')) : 'تنظیم نشده') +
          ' · ادمین‌ها: ' + fmtNum(tg.admins) + ' · وبهوک: ' + (tg.webhookConfigured ? 'فعال' : 'غیرفعال') + '</div>' +
        '</section>' +
        '<section class="admin-card">' +
          '<div class="card-head"><h3>پیام‌ها در ۷ روز</h3><span class="muted">وب + تلگرام</span></div>' +
          '<div class="bar-chart">' + (bars || '<p class="muted">داده‌ای نیست.</p>') + '</div>' +
        '</section>' +
        '<section class="admin-card">' +
          '<div class="card-head"><h3>مصرف سرویس‌دهنده‌ها</h3><span class="muted">در ۷ روز اخیر</span></div>' +
          '<div class="provider-list">' + (usageRows || '<p class="muted">هنوز داده‌ای ثبت نشده.</p>') + '</div>' +
        '</section>' +
        '<section class="admin-card wide">' +
          '<div class="card-head"><h3>آخرین گزارش‌ها</h3><button class="mini-btn" type="button" data-goto="logs">همهٔ گزارش‌ها</button></div>' +
          renderLogsTable(recent) +
        '</section>' +
        '<section class="admin-card">' +
          '<div class="card-head"><h3>دسترسی سریع</h3></div>' +
          '<div class="quick-actions">' +
            '<button class="quick-action" type="button" data-goto="telegram">✈️ مدیریت ربات تلگرام</button>' +
            '<button class="quick-action" type="button" data-goto="users">👥 مشاهدهٔ کاربران</button>' +
            '<button class="quick-action" type="button" data-goto="settings">⚙️ تنظیمات عمومی</button>' +
            '<button class="quick-action" type="button" data-goto="security">🛡️ امنیت پنل</button>' +
          '</div>' +
          '<p class="muted tiny" style="margin-top:12px">نسخه: ' + esc((data.app && data.app.package) || 'arenaai-1.0.0') +
          ' · ساختهٔ ' + esc((data.app && data.app.author) || 'امیر پارسا') + '</p>' +
        '</section>' +
      '</div>';
  }

  function statCard(icon, title, value, sub) {
    return '<div class="stat-card"><div class="stat-icon">' + icon + '</div>' +
      '<div class="stat-title">' + esc(title) + '</div>' +
      '<div class="stat-value">' + esc(value) + '</div>' +
      '<div class="stat-sub">' + esc(sub) + '</div></div>';
  }

  /* ============================ keys ============================ */

  async function loadKeys() {
    if (!els.keysContent) return;
    els.keysContent.innerHTML = loading('در حال دریافت کلیدها…');
    try {
      const data = await adminApi('/admin/api/keys');
      state.keys = data;
      renderKeys(data);
    } catch (e) {
      if (!e.handled) els.keysContent.innerHTML = errorBox(e.message || 'دریافت کلیدها ناموفق بود.');
    }
  }

  function renderKeys(data) {
    const providers = data.providers || {};
    const cf = data.cloudflare || {};
    const docs = Array.isArray(data.docs) ? data.docs : [];
    const cfProvider = providers.workersai || {};
    let html = '<div class="cards-grid">';

    html += '<section class="admin-card provider-card">' +
      '<div class="card-head"><h3>☁️ Cloudflare Workers AI</h3>' + statusBadge(!!cfProvider.ready, cfProvider.ready ? 'آماده' : 'نیاز به تنظیم') + '</div>' +
      '<p class="muted small">اگر binding داخلی <code>AI</code> فعال باشد، بدون کلید هم کار می‌کند. برای REST یا حساب دیگر، Account ID و API Token را ذخیره کن.</p>' +
      '<div class="field-row">' +
        '<label class="field"><span>Account ID</span><input id="cfAccount" type="text" dir="ltr" value="' + esc(cf.accountId || '') + '" placeholder="32 hex characters" /></label>' +
        '<label class="field"><span>API Token</span><input id="cfToken" type="password" dir="ltr" placeholder="' + esc(cf.tokenMasked || 'Cloudflare API Token') + '" autocomplete="off" /></label>' +
      '</div>' +
      '<div class="inline-note">Binding داخلی: ' + (cf.aiBinding ? '✅ فعال' : '❌ غیرفعال') + ' · وضعیت: ' + (cfProvider.ready ? 'آماده' : 'کلید ندارد') + '</div>' +
      '<div class="card-actions">' +
        '<button class="btn primary tiny" type="button" data-key-save="workersai">💾 ذخیره و تست</button>' +
        '<button class="btn ghost tiny" type="button" data-key-test="workersai">🧪 تست اتصال</button>' +
        '<button class="btn danger tiny" type="button" data-key-delete="workersai">حذف کلید</button>' +
        '<span class="test-result" id="key-test-workersai"></span>' +
      '</div>' +
    '</section>';

    for (const d of docs) {
      if (d.id === 'workersai') continue;
      const p = providers[d.id] || {};
      html += '<section class="admin-card provider-card">' +
        '<div class="card-head"><h3>' + esc((PLATFORMS.find((x) => x.id === d.id) || {}).icon || '🔑') + ' ' + esc(d.label) + '</h3>' +
          statusBadge(!!p.ready, p.ready ? 'آماده' : 'نیاز به کلید') + '</div>' +
        '<p class="muted small">' + esc(d.docs ? 'کلید API را از سایت رسمی بگیر و اینجا ذخیره کن.' : '') + '</p>' +
        '<label class="field"><span>API Key</span><input id="key-' + esc(d.id) + '" type="password" dir="ltr" placeholder="' + esc(p.keyMask || 'کلید API') + '" autocomplete="off" /></label>' +
        (d.allowBaseUrl
          ? '<label class="field"><span>Base URL (قابل تغییر)</span><input id="base-' + esc(d.id) + '" type="url" dir="ltr" value="' + esc(p.baseUrl || d.baseUrl || '') + '" placeholder="https://llm.onerouter.pro/v1" /></label>'
          : '') +
        '<div class="inline-note">Base: <span dir="ltr">' + esc(p.baseUrl || d.baseUrl || '—') + '</span>' +
          (d.keysUrl ? ' · <a href="' + esc(d.keysUrl) + '" target="_blank" rel="noopener">دریافت کلید</a>' : '') +
          (d.docs ? ' · <a href="' + esc(d.docs) + '" target="_blank" rel="noopener">مستندات</a>' : '') +
        '</div>' +
        '<div class="card-actions">' +
          '<button class="btn primary tiny" type="button" data-key-save="' + esc(d.id) + '">💾 ذخیره و تست</button>' +
          '<button class="btn ghost tiny" type="button" data-key-test="' + esc(d.id) + '">🧪 تست اتصال</button>' +
          '<button class="btn danger tiny" type="button" data-key-delete="' + esc(d.id) + '">حذف کلید</button>' +
          '<span class="test-result" id="key-test-' + esc(d.id) + '"></span>' +
        '</div>' +
      '</section>';
    }
    html += '</div>';
    els.keysContent.innerHTML = html;
  }

  async function saveKey(platform) {
    const btn = document.querySelector('[data-key-save="' + platform + '"]');
    if (btn) btn.disabled = true;
    try {
      let body = {};
      if (platform === 'workersai') {
        body = {
          accountId: String(($('#cfAccount') || {}).value || '').trim(),
          token: String(($('#cfToken') || {}).value || '').trim()
        };
      } else {
        body.key = String(($('#key-' + platform) || {}).value || '').trim();
        const base = $('#base-' + platform);
        if (base) body.baseUrl = String(base.value || '').trim();
      }
      const data = await adminApi('/admin/api/keys/' + encodeURIComponent(platform), { method: 'POST', body });
      toast('کلید ذخیره شد.', 'ok');
      const test = data.test;
      await loadKeys();
      if (test) setTestResult(platform, test);
    } catch (e) {
      if (!e.handled) toast(e.message || 'ذخیرهٔ کلید ناموفق بود.', 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function testKey(platform) {
    const btn = document.querySelector('[data-key-test="' + platform + '"]');
    if (btn) btn.disabled = true;
    setTestResult(platform, { ok: true, message: 'در حال تست…' });
    try {
      let body = {};
      if (platform === 'workersai') {
        body = {
          accountId: String(($('#cfAccount') || {}).value || '').trim(),
          token: String(($('#cfToken') || {}).value || '').trim()
        };
      } else {
        body.key = String(($('#key-' + platform) || {}).value || '').trim();
        const base = $('#base-' + platform);
        if (base) body.baseUrl = String(base.value || '').trim();
      }
      const data = await adminApi('/admin/api/keys/' + encodeURIComponent(platform) + '/test', { method: 'POST', body });
      setTestResult(platform, data.test || { ok: false, message: 'نتیجه‌ای برنگشت.' });
    } catch (e) {
      if (!e.handled) setTestResult(platform, { ok: false, message: e.message || 'تست ناموفق بود.' });
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function setTestResult(platform, result) {
    setInlineResult('key-test-' + platform, result);
  }

  function setInlineResult(id, result) {
    const el = document.getElementById(id);
    if (!el) return;
    const good = !!(result && (result.ok !== undefined ? result.ok : result.valid));
    el.className = 'test-result ' + (good ? 'ok' : 'err');
    el.textContent = (result && (result.message || result.error)) || (good ? 'اتصال برقرار است ✓' : 'اتصال ناموفق');
  }

  async function deleteKey(platform) {
    if (!confirm('کلید ' + platform + ' حذف شود؟')) return;
    try {
      await adminApi('/admin/api/keys/' + encodeURIComponent(platform) + '/delete', { method: 'POST', body: {} });
      toast('کلید حذف شد.', 'ok');
      await loadKeys();
    } catch (e) {
      if (!e.handled) toast(e.message || 'حذف کلید ناموفق بود.', 'err');
    }
  }

  /* ============================ models ============================ */

  async function loadAdminModels() {
    if (!els.adminModelsContent) return;
    els.adminModelsContent.innerHTML = loading('در حال دریافت مدل‌ها…');
    renderPlatformTabs();
    try {
      const data = await adminApi('/admin/api/models?platform=' + encodeURIComponent(state.modelsPlatform) + '&refresh=1');
      state.adminModels = Array.isArray(data.models) ? data.models : [];
      renderAdminModels();
    } catch (e) {
      if (!e.handled) els.adminModelsContent.innerHTML = errorBox(e.message || 'دریافت مدل‌ها ناموفق بود.');
    }
  }

  function renderPlatformTabs() {
    if (!els.adminPlatformTabs) return;
    els.adminPlatformTabs.innerHTML = PLATFORMS.map((p) =>
      '<button class="admin-tab' + (p.id === state.modelsPlatform ? ' active' : '') + '" type="button" data-admin-platform="' + p.id + '">' +
      p.icon + ' ' + esc(p.label) + '</button>'
    ).join('');
  }

  function renderAdminModels() {
    const q = state.modelSearch.toLowerCase();
    let list = state.adminModels.filter((m) => !q ||
      String(m.id || '').toLowerCase().includes(q) ||
      String(m.name || '').toLowerCase().includes(q) ||
      String(m.desc || '').toLowerCase().includes(q)
    );
    if (els.adminModelCount) els.adminModelCount.textContent = fmtNum(list.length) + ' مدل از ' + fmtNum(state.adminModels.length);
    if (!list.length) {
      els.adminModelsContent.innerHTML = '<div class="empty-block">مدلی پیدا نشد.</div>';
      return;
    }
    els.adminModelsContent.innerHTML = '<div class="table-wrap"><table class="admin-table"><thead><tr>' +
      '<th>مدل</th><th>شناسه</th><th>وضعیت</th><th>Context</th><th>Max</th><th>توضیح</th>' +
      '</tr></thead><tbody>' +
      list.map((m) =>
        '<tr><td><strong>' + esc(m.name || m.id) + '</strong></td>' +
        '<td><code dir="ltr">' + esc(m.id) + '</code></td>' +
        '<td>' + (m.free ? '<span class="badge free">🎁 رایگان</span>' : '<span class="badge">پولی</span>') + '</td>' +
        '<td>' + esc(fmtToken(m.ctx)) + '</td>' +
        '<td>' + esc(fmtToken(m.max)) + '</td>' +
        '<td class="muted small">' + esc(String(m.desc || '').slice(0, 180)) + '</td></tr>'
      ).join('') +
      '</tbody></table></div>';
  }

  /* ============================ telegram ============================ */

  async function loadTelegram() {
    if (!els.telegramContent) return;
    els.telegramContent.innerHTML = loading('در حال دریافت وضعیت ربات…');
    try {
      const data = await adminApi('/admin/api/telegram');
      renderTelegram(data);
    } catch (e) {
      if (!e.handled) els.telegramContent.innerHTML = errorBox(e.message || 'دریافت وضعیت ربات ناموفق بود.');
    }
  }

  function renderTelegram(data) {
    const bot = data.bot || {};
    const admins = Array.isArray(data.admins) ? data.admins : [];
    const info = data.webhookInfo || {};
    const webhookUrl = bot.webhookUrl || '—';

    els.telegramContent.innerHTML =
      '<div class="cards-grid">' +
        '<section class="admin-card">' +
          '<div class="card-head"><h3>✈️ اتصال ربات</h3>' + statusBadge(!!bot.configured, bot.configured ? 'متصل' : 'تنظیم نشده') + '</div>' +
          '<p class="muted small">توکن را از <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> بگیر. توکن فقط به‌صورت ماسک نمایش داده می‌شود.</p>' +
          '<label class="field"><span>Bot Token</span><input id="tgToken" type="password" dir="ltr" placeholder="' + esc(bot.tokenMasked || '123456789:AA…') + '" autocomplete="off" /></label>' +
          '<div class="inline-note">یوزرنیم: ' + (bot.username ? '@' + esc(bot.username) : '—') + ' · دستورها: ' + (bot.commandsSet ? 'ثبت شده ✓' : 'ثبت نشده') + '</div>' +
          '<div class="card-actions"><button class="btn primary tiny" type="button" data-tg-token-save>💾 ذخیرهٔ توکن</button><span class="test-result" id="tg-token-result"></span></div>' +
        '</section>' +
        '<section class="admin-card">' +
          '<div class="card-head"><h3>🔗 وبهوک</h3>' + statusBadge(!!bot.webhookConfigured, bot.webhookConfigured ? 'فعال' : 'غیرفعال') + '</div>' +
          '<div class="kv-list">' +
            '<div><span>آدرس</span><code dir="ltr">' + esc(webhookUrl) + '</code></div>' +
            '<div><span>Secret</span><code dir="ltr">' + esc(bot.secret || '—') + '</code></div>' +
            '<div><span>آخرین خطا</span><span>' + esc(info.last_error_message || '—') + '</span></div>' +
            '<div><span>آپدیت‌های در انتظار</span><span>' + esc(String(info.pending_update_count == null ? '—' : info.pending_update_count)) + '</span></div>' +
          '</div>' +
          '<div class="card-actions">' +
            '<button class="btn primary tiny" type="button" data-tg-webhook="set">🔗 ثبت وبهوک</button>' +
            '<button class="btn ghost tiny" type="button" data-tg-webhook="info">ℹ️ وضعیت</button>' +
            '<button class="btn danger tiny" type="button" data-tg-webhook="delete">حذف وبهوک</button>' +
          '</div>' +
        '</section>' +
        '<section class="admin-card">' +
          '<div class="card-head"><h3>👤 ادمین‌های تلگرام</h3><span class="muted">شناسهٔ عددی</span></div>' +
          '<p class="muted small">برای دریافت chat id از <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a> استفاده کن. با کاما جدا کن.</p>' +
          '<label class="field"><span>Chat IDs</span><input id="tgAdmins" type="text" dir="ltr" value="' + esc(admins.join(', ')) + '" placeholder="123456789, 987654321" /></label>' +
          '<div class="card-actions"><button class="btn primary tiny" type="button" data-tg-admins-save>💾 ذخیرهٔ ادمین‌ها</button></div>' +
        '</section>' +
        '<section class="admin-card">' +
          '<div class="card-head"><h3>🧪 تست ربات</h3></div>' +
          '<p class="muted small">یک پیام آزمایشی به ادمین‌های ثبت‌شده می‌فرستد.</p>' +
          '<label class="field"><span>متن پیام</span><input id="tgTestText" type="text" value="✅ پیام آزمایشی آرنا ای‌آی — اتصال ربات برقرار است." /></label>' +
          '<div class="card-actions"><button class="btn primary tiny" type="button" data-tg-test>🧪 ارسال تست</button><span class="test-result" id="tg-test-result"></span></div>' +
        '</section>' +
        '<section class="admin-card wide">' +
          '<div class="card-head"><h3>📢 ارسال همگانی</h3><span class="muted">به کاربران تلگرام</span></div>' +
          '<p class="muted small">پیام به‌صورت دسته‌ای ارسال می‌شود تا محدودیت Cloudflare رعایت شود. کاربران مسدود نادیده گرفته می‌شوند.</p>' +
          '<label class="field"><span>متن پیام</span><textarea id="broadcastText" rows="3" maxlength="3000" placeholder="متن اطلاعیه…"></textarea></label>' +
          '<div class="card-actions"><button class="btn primary tiny" type="button" data-tg-broadcast>📢 شروع ارسال</button><span class="muted" id="broadcastProgress"></span></div>' +
        '</section>' +
      '</div>';
  }

  async function saveTelegramToken() {
    const token = String(($('#tgToken') || {}).value || '').trim();
    if (!token) return toast('توکن را وارد کنید.', 'err');
    try {
      const data = await adminApi('/admin/api/telegram/token', { method: 'POST', body: { token } });
      setInlineResult('tg-token-result', { ok: true, message: 'توکن ذخیره شد @' + (data.bot && data.bot.username || '') });
      toast('توکن ربات ذخیره شد.', 'ok');
      await loadTelegram();
    } catch (e) {
      if (!e.handled) setInlineResult('tg-token-result', { ok: false, message: e.message || 'ذخیرهٔ توکن ناموفق بود.' });
    }
  }

  async function telegramWebhook(action) {
    try {
      const data = await adminApi('/admin/api/telegram/webhook', { method: 'POST', body: { action } });
      toast(action === 'delete' ? 'وبهوک حذف شد.' : action === 'info' ? 'وضعیت وبهوک دریافت شد.' : 'وبهوک ثبت شد.', 'ok');
      if (action === 'set' && data.webhookUrl) toast(data.webhookUrl, 'ok');
      await loadTelegram();
    } catch (e) {
      if (!e.handled) toast(e.message || 'عملیات وبهوک ناموفق بود.', 'err');
    }
  }

  async function saveTelegramAdmins() {
    const ids = String(($('#tgAdmins') || {}).value || '').trim();
    try {
      const data = await adminApi('/admin/api/telegram/admins', { method: 'POST', body: { ids } });
      toast('ادمین‌های تلگرام ذخیره شدند (' + data.admins.length + ').', 'ok');
      await loadTelegram();
    } catch (e) {
      if (!e.handled) toast(e.message || 'ذخیرهٔ ادمین‌ها ناموفق بود.', 'err');
    }
  }

  async function telegramTest() {
    const text = String(($('#tgTestText') || {}).value || '').trim();
    try {
      const data = await adminApi('/admin/api/telegram/test', { method: 'POST', body: { text } });
      setInlineResult('tg-test-result', { ok: data.ok, message: data.ok ? 'پیام تست ارسال شد ✓' : 'بعضی ارسال‌ها ناموفق بود.' });
      toast(data.ok ? 'پیام تست ارسال شد.' : 'ارسال تست با خطا مواجه شد.', data.ok ? 'ok' : 'err');
    } catch (e) {
      if (!e.handled) setInlineResult('tg-test-result', { ok: false, message: e.message || 'ارسال تست ناموفق بود.' });
    }
  }

  async function runBroadcast() {
    const text = String(($('#broadcastText') || {}).value || '').trim();
    if (!text) return toast('متن پیام خالی است.', 'err');
    if (!confirm('پیام همگانی به همهٔ کاربران تلگرام ارسال شود؟')) return;
    const btn = document.querySelector('[data-tg-broadcast]');
    const progress = $('#broadcastProgress');
    if (btn) btn.disabled = true;
    let cursor = 1;
    let sent = 0;
    let failed = 0;
    let guard = 0;
    try {
      while (cursor && guard < 100) {
        guard++;
        const data = await adminApi('/admin/api/telegram/broadcast', { method: 'POST', body: { text, cursor } });
        sent += Number(data.sent) || 0;
        failed += Number(data.failed) || 0;
        if (progress) progress.textContent = 'ارسال‌شده: ' + fmtNum(sent) + ' · ناموفق: ' + fmtNum(failed) + ' · کل: ' + fmtNum(data.total || 0);
        cursor = data.next;
        if (cursor) await sleep(320);
      }
      toast('ارسال همگانی تمام شد. موفق: ' + fmtNum(sent) + ' · ناموفق: ' + fmtNum(failed), failed ? 'err' : 'ok');
    } catch (e) {
      if (!e.handled) toast(e.message || 'ارسال همگانی ناموفق بود.', 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ============================ users ============================ */

  async function loadUsers() {
    if (!els.usersContent) return;
    els.usersContent.innerHTML = loading('در حال دریافت کاربران…');
    try {
      const data = await adminApi('/admin/api/users?source=' + encodeURIComponent(state.userSource) + '&page=' + state.userPage);
      state.users = data;
      renderUsers(data);
    } catch (e) {
      if (!e.handled) els.usersContent.innerHTML = errorBox(e.message || 'دریافت کاربران ناموفق بود.');
    }
  }

  function renderUsers(data) {
    const users = Array.isArray(data.users) ? data.users : [];
    if (els.userSourceTabs) {
      $$('[data-user-source]', els.userSourceTabs).forEach((b) => b.classList.toggle('active', b.dataset.userSource === state.userSource));
    }
    if (!users.length) {
      els.usersContent.innerHTML = '<div class="empty-block">کاربری در این صفحه نیست.</div>';
    } else {
      els.usersContent.innerHTML = '<div class="table-wrap"><table class="admin-table"><thead><tr>' +
        '<th>کاربر</th><th>شناسه</th><th>پیام‌ها</th><th>مدل</th><th>آخرین فعالیت</th><th>وضعیت</th>' +
        '</tr></thead><tbody>' +
        users.map((u) =>
          '<tr class="clickable" data-user-source="' + esc(data.source) + '" data-user-id="' + esc(u.id) + '">' +
            '<td><strong>' + esc(u.name || 'بدون نام') + '</strong>' + (u.username ? '<br><span class="muted small">@' + esc(u.username) + '</span>' : '') + '</td>' +
            '<td><code dir="ltr">' + esc(String(u.id)) + '</code></td>' +
            '<td>' + fmtNum(u.msgs) + '</td>' +
            '<td><span class="muted small" dir="ltr">' + esc(String(u.model || '—').split('/').pop()) + '</span></td>' +
            '<td class="muted small">' + esc(timeAgo(u.lastSeen)) + '</td>' +
            '<td>' + (u.banned ? '<span class="badge danger">مسدود</span>' : '<span class="badge ok">فعال</span>') + '</td>' +
          '</tr>'
        ).join('') +
        '</tbody></table></div>';
    }
    if (els.usersPager) {
      const pages = Number(data.pages) || 1;
      const page = Number(data.page) || 1;
      els.usersPager.innerHTML =
        '<button class="btn ghost tiny" type="button" data-user-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>‹ قبلی</button>' +
        '<span class="muted">صفحهٔ ' + fmtNum(page) + ' از ' + fmtNum(pages) + ' · ' + fmtNum(data.total) + ' کاربر</span>' +
        '<button class="btn ghost tiny" type="button" data-user-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>بعدی ›</button>';
    }
  }

  async function openUserDetail(source, id) {
    try {
      const data = await adminApi('/admin/api/users/' + encodeURIComponent(source) + '/' + encodeURIComponent(id));
      state.userDetail = data;
      state.userDetailSource = source;
      state.userDetailId = id;
      renderUserDetail(data);
      if (els.modalUser) {
        els.modalUser.hidden = false;
        document.body.classList.add('admin-modal-open');
      }
    } catch (e) {
      if (!e.handled) toast(e.message || 'دریافت جزئیات کاربر ناموفق بود.', 'err');
    }
  }

  function renderUserDetail(data) {
    const p = data.profile || {};
    const m = data.memory || {};
    const facts = Array.isArray(m.facts) ? m.facts : [];
    const recent = Array.isArray(m.recent) ? m.recent : [];
    if (els.userModalTitle) els.userModalTitle.textContent = 'جزئیات کاربر ' + (p.name || p.id || '');
    if (!els.userModalBody) return;
    els.userModalBody.innerHTML =
      '<div class="kv-list">' +
        '<div><span>شناسه</span><code dir="ltr">' + esc(String(p.id || state.userDetailId)) + '</code></div>' +
        '<div><span>نام</span><span>' + esc(p.name || '—') + '</span></div>' +
        '<div><span>یوزرنیم</span><span dir="ltr">' + esc(p.username ? '@' + p.username : '—') + '</span></div>' +
        '<div><span>پلتفرم / مدل</span><span dir="ltr">' + esc((p.platform || '—') + ' / ' + (p.model || '—')) + '</span></div>' +
        '<div><span>شخصیت</span><span>' + esc(p.persona || '—') + '</span></div>' +
        '<div><span>پیام‌ها</span><span>' + fmtNum(p.msgs) + '</span></div>' +
        '<div><span>ایجاد</span><span>' + esc(fmtDate(p.createdAt)) + '</span></div>' +
        '<div><span>آخرین فعالیت</span><span>' + esc(fmtDate(p.lastSeen)) + '</span></div>' +
        '<div><span>وضعیت</span><span>' + (p.banned ? '<span class="badge danger">مسدود</span>' : '<span class="badge ok">فعال</span>') + '</span></div>' +
      '</div>' +
      '<h4 class="subhead">حافظه</h4>' +
      '<div class="memory-box"><div><strong>پیام‌های ذخیره‌شده:</strong> ' + fmtNum(m.rounds) + '</div>' +
        (m.summary ? '<div class="memory-summary">' + esc(m.summary) + '</div>' : '<div class="muted small">خلاصه‌ای ساخته نشده.</div>') +
        (facts.length ? '<div class="facts"><strong>دانسته‌ها:</strong><ul>' + facts.map((f) => '<li>' + esc(f) + '</li>').join('') + '</ul></div>' : '') +
      '</div>' +
      (recent.length
        ? '<h4 class="subhead">آخرین پیام‌ها</h4><div class="recent-rounds">' + recent.map((r) =>
            '<details><summary>کاربر: ' + esc(String(r.q || '').slice(0, 90)) + '</summary>' +
            '<div><strong>کاربر:</strong> ' + esc(r.q || '') + '</div>' +
            '<div><strong>دستیار:</strong> ' + esc(String(r.a || '').slice(0, 1200)) + '</div></details>'
          ).join('') + '</div>'
        : '') +
      '<div class="card-actions user-actions">' +
        '<button class="btn ' + (p.banned ? 'primary' : 'danger') + ' tiny" type="button" data-user-action="block">' + (p.banned ? 'رفع مسدودی' : 'مسدود کردن') + '</button>' +
        '<button class="btn ghost tiny" type="button" data-user-action="wipe-chat">🧹 پاک کردن گفتگو</button>' +
        '<button class="btn ghost tiny" type="button" data-user-action="wipe-memory">🧠 پاک کردن حافظه</button>' +
        '<button class="btn ghost tiny" type="button" data-user-action="wipe-all">🗑 پاک کردن همه</button>' +
        '<button class="btn danger tiny" type="button" data-user-action="delete">حذف کاربر</button>' +
      '</div>';
  }

  async function userAction(action) {
    if (!state.userDetail || !state.userDetail.profile) return;
    const source = state.userDetailSource;
    const id = state.userDetailId;
    const p = state.userDetail.profile;
    try {
      if (action === 'block') {
        await adminApi('/admin/api/users/' + encodeURIComponent(source) + '/' + encodeURIComponent(id) + '/block', {
          method: 'POST', body: { banned: !p.banned }
        });
        toast(p.banned ? 'مسدودی کاربر برداشته شد.' : 'کاربر مسدود شد.', 'ok');
      } else if (action === 'wipe-chat' || action === 'wipe-memory' || action === 'wipe-all') {
        const mode = action === 'wipe-chat' ? 'chat' : action === 'wipe-memory' ? 'memory' : 'all';
        if (!confirm('حافظهٔ کاربر پاک شود؟')) return;
        await adminApi('/admin/api/users/' + encodeURIComponent(source) + '/' + encodeURIComponent(id) + '/wipe', {
          method: 'POST', body: { mode }
        });
        toast('حافظهٔ کاربر پاک شد.', 'ok');
      } else if (action === 'delete') {
        if (!confirm('کاربر برای همیشه حذف شود؟ این کار قابل بازگشت نیست.')) return;
        await adminApi('/admin/api/users/' + encodeURIComponent(source) + '/' + encodeURIComponent(id) + '/delete', { method: 'POST', body: {} });
        toast('کاربر حذف شد.', 'ok');
        closeUserModal();
        await loadUsers();
        return;
      }
      await openUserDetail(source, id);
      await loadUsers();
    } catch (e) {
      if (!e.handled) toast(e.message || 'عملیات کاربر ناموفق بود.', 'err');
    }
  }

  function closeUserModal() {
    if (els.modalUser) els.modalUser.hidden = true;
    document.body.classList.remove('admin-modal-open');
    state.userDetail = null;
  }

  /* ============================ logs ============================ */

  async function loadLogs() {
    if (!els.logsContent) return;
    els.logsContent.innerHTML = loading('در حال دریافت گزارش‌ها…');
    try {
      const type = els.logType ? els.logType.value : '';
      const data = await adminApi('/admin/api/logs?limit=200' + (type ? '&type=' + encodeURIComponent(type) : ''));
      state.logs = Array.isArray(data.logs) ? data.logs : [];
      renderLogs();
    } catch (e) {
      if (!e.handled) els.logsContent.innerHTML = errorBox(e.message || 'دریافت گزارش‌ها ناموفق بود.');
    }
  }

  function renderLogs() {
    if (!els.logsContent) return;
    if (!state.logs.length) {
      els.logsContent.innerHTML = '<div class="empty-block">گزارشی نیست.</div>';
      return;
    }
    els.logsContent.innerHTML = renderLogsTable(state.logs, true);
  }

  function renderLogsTable(rows, full) {
    if (!rows || !rows.length) return '<p class="muted small">گزارشی نیست.</p>';
    return '<div class="table-wrap"><table class="admin-table logs-table"><thead><tr>' +
      '<th>زمان</th><th>نوع</th><th>پیام</th>' +
      '</tr></thead><tbody>' +
      rows.map((r) =>
        '<tr><td class="muted small" title="' + esc(fmtDate(r.t)) + '">' + esc(timeAgo(r.t)) + '</td>' +
        '<td>' + logBadge(r.type) + '</td>' +
        '<td class="log-msg">' + esc(String(r.msg || '').slice(0, full ? 600 : 220)) + '</td></tr>'
      ).join('') +
      '</tbody></table></div>';
  }

  function logBadge(type) {
    const map = { security: 'امنیت', error: 'خطا', warn: 'هشدار', admin: 'مدیر', feedback: 'بازخورد', user: 'کاربر', info: 'اطلاع' };
    const cls = ['error', 'security', 'warn', 'feedback'].includes(type) ? type : 'info';
    return '<span class="badge log-' + cls + '">' + esc(map[type] || type || '—') + '</span>';
  }

  /* ============================ settings ============================ */

  async function loadSettings() {
    if (!els.settingsContent) return;
    els.settingsContent.innerHTML = loading('در حال دریافت تنظیمات…');
    try {
      const data = await adminApi('/admin/api/settings');
      state.settingsData = data;
      renderSettings(data);
    } catch (e) {
      if (!e.handled) els.settingsContent.innerHTML = errorBox(e.message || 'دریافت تنظیمات ناموفق بود.');
    }
  }

  function renderSettings(data) {
    const s = data.settings || {};
    const platforms = Array.isArray(data.platforms) ? data.platforms : PLATFORMS;
    const personas = Array.isArray(data.personas) ? data.personas : [];
    const dm = s.defaultModel || {};

    els.settingsContent.innerHTML =
      '<div class="settings-grid">' +
        '<section class="admin-card">' +
          '<h3>عمومی</h3>' +
          '<label class="field"><span>عنوان سایت</span><input id="setSiteTitle" type="text" maxlength="80" value="' + esc(s.siteTitle || '') + '" /></label>' +
          '<label class="field"><span>اعلان بالای چت</span><textarea id="setAnnouncement" rows="2" maxlength="600">' + esc(s.announcement || '') + '</textarea></label>' +
          '<label class="field"><span>متن پیام بازخورد</span><input id="setFeedbackPrompt" type="text" maxlength="200" value="' + esc(s.feedbackPrompt || '') + '" /></label>' +
        '</section>' +
        '<section class="admin-card">' +
          '<h3>پیش‌فرض‌ها</h3>' +
          '<label class="field"><span>پلتفرم پیش‌فرض</span><select id="setDefaultPlatform">' +
            platforms.map((p) => '<option value="' + esc(p.id) + '"' + (s.defaultPlatform === p.id ? ' selected' : '') + '>' + esc(p.label || p.faLabel || p.id) + '</option>').join('') +
          '</select></label>' +
          '<label class="field"><span>شخصیت پیش‌فرض</span><select id="setDefaultPersona">' +
            personas.map((p) => '<option value="' + esc(p.id) + '"' + (s.defaultPersona === p.id ? ' selected' : '') + '>' + esc(p.name || p.id) + '</option>').join('') +
          '</select></label>' +
          '<div class="field"><span>مدل پیش‌فرض هر پلتفرم</span>' +
            platforms.map((p) => '<label class="mini-field"><span>' + esc(p.label || p.faLabel || p.id) + '</span>' +
              '<input id="setModel-' + esc(p.id) + '" type="text" dir="ltr" value="' + esc(dm[p.id] || p.defaultModel || '') + '" /></label>').join('') +
          '</div>' +
        '</section>' +
        '<section class="admin-card">' +
          '<h3>پاسخ و حافظه</h3>' +
          '<div class="field-row">' +
            '<label class="field"><span>Max Tokens عادی</span><input id="setMaxNormal" type="number" min="512" max="8192" value="' + esc(s.maxTokensNormal || 4096) + '" /></label>' +
            '<label class="field"><span>Max Tokens نهایت قدرت</span><input id="setMaxDeep" type="number" min="1024" max="32768" value="' + esc(s.maxTokensDeep || 12288) + '" /></label>' +
          '</div>' +
          '<label class="field"><span>تعداد دورهای حافظهٔ کوتاه‌مدت</span><input id="setRoundsCap" type="number" min="6" max="80" value="' + esc(s.roundsCap || 24) + '" /></label>' +
          '<label class="check-line"><input id="setMemory" type="checkbox"' + (s.memoryEnabled ? ' checked' : '') + ' /> حافظه فعال باشد</label>' +
          '<label class="check-line"><input id="setFacts" type="checkbox"' + (s.factsEnabled ? ' checked' : '') + ' /> استخراج دانسته‌های ماندگار</label>' +
          '<label class="check-line"><input id="setFallback" type="checkbox"' + (s.fallbackEnabled ? ' checked' : '') + ' /> جایگزینی خودکار در صورت خطای پلتفرم</label>' +
        '</section>' +
        '<section class="admin-card">' +
          '<h3>حالت تعمیرات</h3>' +
          '<label class="check-line"><input id="setMaintenance" type="checkbox"' + (s.maintenance ? ' checked' : '') + ' /> حالت تعمیرات فعال باشد</label>' +
          '<p class="muted small">در حالت تعمیرات، وب‌چت و ربات برای کاربران عادی پیام خطا می‌دهند.</p>' +
          '<label class="field"><span>دستور اضافی به همهٔ شخصیت‌ها</span><textarea id="setExtra" rows="4" maxlength="2500" placeholder="مثلاً: پاسخ‌ها را کوتاه‌تر بده…">' + esc(s.extraInstructions || '') + '</textarea></label>' +
        '</section>' +
      '</div>';
  }

  async function saveSettings(e) {
    e.preventDefault();
    const msg = els.settingsMsg;
    if (msg) { msg.hidden = true; msg.textContent = ''; }
    const platforms = (state.settingsData && state.settingsData.platforms) || PLATFORMS;
    const body = {
      siteTitle: ($('#setSiteTitle') || {}).value || '',
      announcement: ($('#setAnnouncement') || {}).value || '',
      feedbackPrompt: ($('#setFeedbackPrompt') || {}).value || '',
      defaultPlatform: ($('#setDefaultPlatform') || {}).value || 'workersai',
      defaultPersona: ($('#setDefaultPersona') || {}).value || 'general',
      defaultModel: {},
      maxTokensNormal: Number(($('#setMaxNormal') || {}).value || 4096),
      maxTokensDeep: Number(($('#setMaxDeep') || {}).value || 12288),
      roundsCap: Number(($('#setRoundsCap') || {}).value || 24),
      memoryEnabled: !!($('#setMemory') || {}).checked,
      factsEnabled: !!($('#setFacts') || {}).checked,
      fallbackEnabled: !!($('#setFallback') || {}).checked,
      maintenance: !!($('#setMaintenance') || {}).checked,
      extraInstructions: ($('#setExtra') || {}).value || ''
    };
    for (const p of platforms) {
      const input = $('#setModel-' + p.id);
      if (input) body.defaultModel[p.id] = input.value;
    }
    if (els.btnSettingsSave) els.btnSettingsSave.disabled = true;
    try {
      const data = await adminApi('/admin/api/settings', { method: 'POST', body });
      if (state.settingsData) state.settingsData.settings = data.settings;
      if (state.overview) state.overview.settings = data.settings;
      updateBanners();
      if (msg) { msg.hidden = false; msg.textContent = 'تنظیمات ذخیره شد ✓'; msg.style.color = 'var(--ok)'; }
      toast('تنظیمات ذخیره شد.', 'ok');
    } catch (err) {
      if (!err.handled && msg) { msg.hidden = false; msg.textContent = err.message || 'ذخیره ناموفق بود.'; msg.style.color = 'var(--err)'; }
    } finally {
      if (els.btnSettingsSave) els.btnSettingsSave.disabled = false;
    }
  }

  /* ============================ security ============================ */

  async function loadSecurity() {
    if (!els.securityContent) return;
    els.securityContent.innerHTML = loading('در حال دریافت وضعیت امنیتی…');
    try {
      const data = await adminApi('/admin/api/security');
      state.security = data;
      state.mustChange = !!data.mustChange;
      updateBanners();
      renderSecurity(data);
    } catch (e) {
      if (!e.handled) els.securityContent.innerHTML = errorBox(e.message || 'دریافت وضعیت امنیتی ناموفق بود.');
    }
  }

  function renderSecurity(data) {
    els.securityContent.innerHTML =
      '<div class="cards-grid">' +
        '<section class="admin-card">' +
          '<h3>وضعیت نشست</h3>' +
          '<div class="kv-list">' +
            '<div><span>نام کاربری</span><strong>' + esc(data.username || '—') + '</strong></div>' +
            '<div><span>وضعیت رمز</span>' + (data.mustChange ? '<span class="badge danger">پیش‌فرض — تغییر لازم</span>' : '<span class="badge ok">تغییر کرده</span>') + '</div>' +
            '<div><span>شروع نشست</span><span>' + esc(fmtDate(data.sessionStarted)) + '</span></div>' +
            '<div><span>اعتبار نشست</span><span>' + esc(Math.round((Number(data.sessionTtl) || 0) / 3600)) + ' ساعت</span></div>' +
            '<div><span>تکرار PBKDF2</span><code dir="ltr">' + esc(String(data.iterations || '—')) + '</code></div>' +
          '</div>' +
          '<div class="inline-note">برای امنیت بیشتر، رمز پیش‌فرض را تغییر بده و از رمز یکتا استفاده کن.</div>' +
        '</section>' +
        '<section class="admin-card">' +
          '<h3>تغییر نام کاربری و رمز</h3>' +
          '<label class="field"><span>نام کاربری جدید</span><input id="secUsername" type="text" dir="ltr" maxlength="32" value="' + esc(data.username || '') + '" /></label>' +
          '<label class="field"><span>رمز عبور فعلی</span><input id="secCurrent" type="password" autocomplete="current-password" /></label>' +
          '<div class="field-row">' +
            '<label class="field"><span>رمز جدید (حداقل ۱۲ نویسه)</span><input id="secNew" type="password" autocomplete="new-password" minlength="12" maxlength="72" /></label>' +
            '<label class="field"><span>تکرار رمز جدید</span><input id="secConfirm" type="password" autocomplete="new-password" minlength="12" maxlength="72" /></label>' +
          '</div>' +
          '<div class="card-actions"><button class="btn primary tiny" type="button" data-security-save>🔐 ذخیرهٔ اعتبارنامه</button><span class="form-msg" id="securityMsg" hidden></span></div>' +
        '</section>' +
        '<section class="admin-card">' +
          '<h3>ابطال همهٔ نشست‌ها</h3>' +
          '<p class="muted small">با این کار همهٔ نشست‌های فعال پنل (از جمله همین نشست) باطل می‌شوند و باید دوباره وارد شوی.</p>' +
          '<div class="card-actions"><button class="btn danger tiny" type="button" data-logout-all>🚪 ابطال همه و خروج</button></div>' +
        '</section>' +
      '</div>';
  }

  async function saveSecurity() {
    const username = String(($('#secUsername') || {}).value || '').trim();
    const current = String(($('#secCurrent') || {}).value || '');
    const next = String(($('#secNew') || {}).value || '');
    const confirmPass = String(($('#secConfirm') || {}).value || '');
    const msg = $('#securityMsg');
    if (next.length < 12) {
      if (msg) { msg.hidden = false; msg.textContent = 'رمز جدید باید حداقل ۱۲ نویسه باشد.'; msg.style.color = 'var(--err)'; }
      return;
    }
    if (next !== confirmPass) {
      if (msg) { msg.hidden = false; msg.textContent = 'تکرار رمز جدید یکسان نیست.'; msg.style.color = 'var(--err)'; }
      return;
    }
    try {
      const data = await adminApi('/admin/api/security/password', {
        method: 'POST',
        body: { username, currentPassword: current, newPassword: next }
      });
      if (data.csrf) state.csrf = data.csrf;
      state.mustChange = false;
      state.user = data.username || username;
      if (els.adminUser) els.adminUser.textContent = state.user;
      updateBanners();
      if (msg) { msg.hidden = false; msg.textContent = 'اعتبارنامه تغییر کرد ✓'; msg.style.color = 'var(--ok)'; }
      toast('نام کاربری و رمز عبور تغییر کرد.', 'ok');
      await loadSecurity();
    } catch (e) {
      if (!e.handled && msg) { msg.hidden = false; msg.textContent = e.message || 'تغییر اعتبارنامه ناموفق بود.'; msg.style.color = 'var(--err)'; }
    }
  }

  async function logoutAll() {
    if (!confirm('همهٔ نشست‌های پنل باطل شوند؟')) return;
    try {
      await adminApi('/admin/api/security/logout-all', { method: 'POST', body: {} });
      state.csrf = null;
      showLogin();
      toast('همهٔ نشست‌ها باطل شدند. دوباره وارد شو.', 'ok');
    } catch (e) {
      if (!e.handled) toast(e.message || 'ابطال نشست‌ها ناموفق بود.', 'err');
    }
  }

  /* ============================ events ============================ */

  function bind() {
    if (els.loginForm) els.loginForm.addEventListener('submit', doLogin);
    if (els.btnLogoutTop) els.btnLogoutTop.addEventListener('click', doLogout);
    if (els.btnLogoutSide) els.btnLogoutSide.addEventListener('click', doLogout);
    if (els.btnRefreshTop) els.btnRefreshTop.addEventListener('click', refreshCurrent);
    if (els.btnMenu) els.btnMenu.addEventListener('click', openSidebar);
    const scrim = document.querySelector('.sidebar-scrim');
    if (scrim) scrim.addEventListener('click', closeSidebar);

    $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.view)));
    document.addEventListener('click', (e) => {
      const goto = e.target.closest('[data-goto]');
      if (goto) {
        e.preventDefault();
        showView(goto.dataset.goto);
      }
    });

    if (els.btnKeysRefresh) els.btnKeysRefresh.addEventListener('click', loadKeys);
    if (els.panelKeys) {
      els.panelKeys.addEventListener('click', (e) => {
        const save = e.target.closest('[data-key-save]');
        if (save) return saveKey(save.dataset.keySave);
        const test = e.target.closest('[data-key-test]');
        if (test) return testKey(test.dataset.keyTest);
        const del = e.target.closest('[data-key-delete]');
        if (del) return deleteKey(del.dataset.keyDelete);
      });
    }

    if (els.btnAdminModelsRefresh) els.btnAdminModelsRefresh.addEventListener('click', loadAdminModels);
    if (els.adminPlatformTabs) {
      els.adminPlatformTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-admin-platform]');
        if (!btn) return;
        state.modelsPlatform = btn.dataset.adminPlatform;
        loadAdminModels();
      });
    }
    if (els.adminModelSearch) {
      els.adminModelSearch.addEventListener('input', () => {
        state.modelSearch = els.adminModelSearch.value.trim();
        renderAdminModels();
      });
    }

    if (els.btnTelegramRefresh) els.btnTelegramRefresh.addEventListener('click', loadTelegram);
    if (els.telegramContent) {
      els.telegramContent.addEventListener('click', (e) => {
        if (e.target.closest('[data-tg-token-save]')) return saveTelegramToken();
        const hook = e.target.closest('[data-tg-webhook]');
        if (hook) return telegramWebhook(hook.dataset.tgWebhook);
        if (e.target.closest('[data-tg-admins-save]')) return saveTelegramAdmins();
        if (e.target.closest('[data-tg-test]')) return telegramTest();
        if (e.target.closest('[data-tg-broadcast]')) return runBroadcast();
      });
    }

    if (els.btnUsersRefresh) els.btnUsersRefresh.addEventListener('click', loadUsers);
    if (els.userSourceTabs) {
      els.userSourceTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-user-source]');
        if (!btn) return;
        state.userSource = btn.dataset.userSource;
        state.userPage = 1;
        loadUsers();
      });
    }
    if (els.usersPager) {
      els.usersPager.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-user-page]');
        if (!btn || btn.disabled) return;
        state.userPage = Math.max(1, Number(btn.dataset.userPage) || 1);
        loadUsers();
      });
    }
    if (els.usersContent) {
      els.usersContent.addEventListener('click', (e) => {
        const row = e.target.closest('[data-user-id]');
        if (row) openUserDetail(row.dataset.userSource, row.dataset.userId);
      });
    }

    if (els.btnLogsRefresh) els.btnLogsRefresh.addEventListener('click', loadLogs);
    if (els.logType) els.logType.addEventListener('change', loadLogs);
    if (els.btnLogsClear) {
      els.btnLogsClear.addEventListener('click', async () => {
        if (!confirm('همهٔ گزارش‌ها پاک شوند؟')) return;
        try {
          await adminApi('/admin/api/logs/clear', { method: 'POST', body: {} });
          toast('گزارش‌ها پاک شدند.', 'ok');
          await loadLogs();
        } catch (e) {
          if (!e.handled) toast(e.message || 'پاک کردن گزارش‌ها ناموفق بود.', 'err');
        }
      });
    }

    if (els.btnSettingsRefresh) els.btnSettingsRefresh.addEventListener('click', loadSettings);
    if (els.settingsForm) els.settingsForm.addEventListener('submit', saveSettings);

    if (els.securityContent) {
      els.securityContent.addEventListener('click', (e) => {
        if (e.target.closest('[data-security-save]')) return saveSecurity();
        if (e.target.closest('[data-logout-all]')) return logoutAll();
      });
    }
    if (els.userModalBody) {
      els.userModalBody.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-user-action]');
        if (btn) userAction(btn.dataset.userAction);
      });
    }

    $$('[data-close]').forEach((btn) => btn.addEventListener('click', () => {
      if (btn.dataset.close === 'modalUser') closeUserModal();
    }));
    if (els.modalUser) {
      els.modalUser.addEventListener('click', (e) => {
        if (e.target === els.modalUser) closeUserModal();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeUserModal();
        closeSidebar();
      }
    });
  }

  /* ============================ utilities ============================ */

  function loading(text) {
    return '<div class="loading-block"><div class="spinner"></div>' + esc(text) + '</div>';
  }

  function errorBox(message) {
    return '<div class="error-block">⚠️ ' + esc(message || 'خطای ناشناخته') + '</div>';
  }

  function statusBadge(ok, label) {
    return '<span class="badge ' + (ok ? 'ok' : 'danger') + '">' + esc(label) + '</span>';
  }

  function fmtNum(n) {
    const v = Number(n) || 0;
    try { return v.toLocaleString('fa-IR'); } catch { return String(v); }
  }

  function fmtToken(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return '—';
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace('.0', '') + 'M';
    if (v >= 1000) return Math.round(v / 1000) + 'K';
    return String(v);
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString('fa-IR'); } catch { return '—'; }
  }

  function timeAgo(ts) {
    if (!ts) return '—';
    const diff = Date.now() - Number(ts);
    if (!Number.isFinite(diff)) return '—';
    if (diff < 60000) return 'همین حالا';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' دقیقه پیش';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' ساعت پیش';
    if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' روز پیش';
    return fmtDate(ts);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function toast(message, type = '') {
    if (!els.toastWrap) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = message;
    els.toastWrap.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      el.style.transition = '0.2s';
      setTimeout(() => el.remove(), 220);
    }, type === 'err' ? 5200 : 3400);
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

})();
