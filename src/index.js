// ============================================================
//  ArenaAi — ArenaAi-v1.0.0
//  Author: ArenaAi
//  src/index.js — Cloudflare Worker entry point
//  Routes:
//    /api/* + /health              → public chat API
//    /admin, /admin/*              → separate secure admin panel
//    /telegram/webhook/<secret>    → Telegram bot webhook
//    everything else               → static assets (public/)
// ============================================================

import { APP } from './config.js';
import { hasDB, jsonResp, htmlResp, escapeHtml, log } from './store.js';
import { handleUserApi } from './routes/user.js';
import { handleAdminApi } from './routes/admin.js';
import { handleTelegram } from './telegram.js';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-XSS-Protection': '0'
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx || {});
    } catch (e) {
      await log(env, 'error', 'worker: ' + String((e && e.message) || e).slice(0, 240));
      return withSecurity(jsonResp({
        ok: false,
        error: 'خطای داخلی Worker. لطفاً دوباره تلاش کنید.',
        detail: String((e && e.message) || e).slice(0, 200)
      }, 500), false);
    }
  }
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') {
    return withSecurity(new Response(null, {
      status: 204,
      headers: {
        'Allow': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token',
        'Access-Control-Max-Age': '86400'
      }
    }), false);
  }

  /* -------------------- public API -------------------- */
  if (path === '/health' || path.startsWith('/api/')) {
    return withSecurity(await handleUserApi(request, env, ctx), false);
  }

  /* -------------------- admin panel + API -------------------- */
  if (path === '/admin' || path === '/admin/') {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed();
    return serveAdminPage(request, env);
  }
  if (path === '/admin.html') {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed();
    return serveAdminPage(request, env);
  }
  if (path === '/admin/login' || path === '/admin/logout' || path === '/admin/status' ||
      path.startsWith('/admin/api/')) {
    return withSecurity(await handleAdminApi(request, env, ctx), false);
  }

  /* -------------------- telegram webhook -------------------- */
  if (path.startsWith('/telegram/webhook/')) {
    if (method !== 'POST') return methodNotAllowed();
    return withSecurity(await handleTelegram(request, env, ctx, url), false);
  }

  /* -------------------- misc -------------------- */
  if (path === '/robots.txt') {
    return withSecurity(headSafe(new Response(
      'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /admin/\nDisallow: /api/\nDisallow: /telegram/\n',
      { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } }
    ), method), false);
  }

  if (path === '/favicon.ico') {
    const icon = await fetchAsset(request, env, '/assets/favicon-32.png');
    if (icon) return withSecurity(headSafe(icon, method), false);
  }

  /* -------------------- static assets -------------------- */
  if (method === 'GET' || method === 'HEAD') {
    const asset = await fetchAsset(request, env, path === '/' ? '/index.html' : path);
    if (asset && asset.status !== 404) {
      return withSecurity(headSafe(asset, method), isHtmlPath(path));
    }
    return withSecurity(headSafe(notFoundPage(path), method), true);
  }

  return methodNotAllowed();
}

/* ============================ assets ============================ */

async function fetchAsset(request, env, path) {
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== 'function') return null;
  try {
    const url = new URL(path, request.url);
    const res = await env.ASSETS.fetch(new Request(url.toString(), {
      method: 'GET',
      headers: { Accept: request.headers.get('accept') || '*/*' }
    }));
    return res || null;
  } catch {
    return null;
  }
}

async function serveAdminPage(request, env) {
  const asset = await fetchAsset(request, env, '/admin.html');
  if (asset && asset.status !== 404) {
    const headers = new Headers(asset.headers);
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return withSecurity(new Response(request.method === 'HEAD' ? null : asset.body, {
      status: 200,
      headers
    }), true);
  }
  return withSecurity(headSafe(adminFallbackPage(), request.method), true);
}

function headSafe(response, method) {
  if (!response || method !== 'HEAD') return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

function isHtmlPath(path) {
  return path === '/' || path.endsWith('.html') || path.endsWith('/');
}

/* ============================ responses ============================ */

function withSecurity(response, html = false) {
  if (!response) {
    return jsonResp({ ok: false, error: 'empty response' }, 500);
  }
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  if (html) {
    headers.set('Content-Security-Policy', CSP);
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-cache');
  }
  if (!headers.has('X-Robots-Tag')) headers.set('X-Robots-Tag', 'noindex, nofollow');
  // Do not let intermediaries rewrite streaming responses.
  if ((headers.get('Content-Type') || '').includes('text/event-stream')) {
    headers.set('Cache-Control', 'no-cache, no-transform');
    headers.set('X-Accel-Buffering', 'no');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function methodNotAllowed() {
  return withSecurity(jsonResp({ ok: false, error: 'method not allowed' }, 405, {
    Allow: 'GET, HEAD, POST, OPTIONS'
  }), false);
}

function notFoundPage(path) {
  const safe = escapeHtml(path);
  return htmlResp(`<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>۴۰۴ — ${escapeHtml(APP.faName)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0e12;color:#e9e7e1;font-family:system-ui,Tahoma,sans-serif}.card{max-width:480px;width:calc(100% - 40px);padding:40px 32px;border:1px solid #262b34;border-radius:16px;text-align:center}h1{font-size:30px;margin:10px 0 16px;font-family:ui-monospace,monospace;color:#d9b778}.ov{font-size:10px;letter-spacing:.25em;color:#85817a;font-family:ui-monospace,monospace}p{color:#85817a;font-size:13px;line-height:1.9;margin:0 0 6px}.path{direction:ltr;display:inline-block;font-family:ui-monospace,monospace;font-size:12px;background:#12151c;border:1px solid #262b34;border-radius:8px;padding:2px 9px;color:#d9b778;max-width:100%;overflow:hidden;text-overflow:ellipsis}a{display:inline-block;margin-top:14px;padding:10px 24px;border-radius:10px;background:#d9b778;color:#16130b;text-decoration:none;font-weight:700;font-size:13px}hr{width:36px;border:0;border-top:2px solid #262b34;margin:0 auto 14px}</style>
</head>
<body><main class="card">
  <span class="ov">404 — NOT FOUND</span>
  <hr />
  <h1>پیدا نشد</h1>
  <p>این مسیر روی سرور وجود ندارد: <span class="path">${safe}</span></p>
  <p>شاید آدرس را اشتباه وارد کرده‌اید. به صفحهٔ اصلی برگردید.</p>
  <a href="/">بازگشت به ${escapeHtml(APP.faName)}</a>
</main></body></html>`, 404, { 'Cache-Control': 'no-store' });
}

function adminFallbackPage() {
  return htmlResp(`<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>پنل مدیریت ${escapeHtml(APP.faName)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0e12;color:#e9e7e1;font-family:system-ui,Tahoma,sans-serif}.card{max-width:520px;width:calc(100% - 40px);padding:34px 30px;background:#12151c;border:1px solid #262b34;border-radius:16px;line-height:1.9}.ov{font-size:10px;letter-spacing:.25em;color:#85817a;font-family:ui-monospace,monospace}h1{font-size:17px;margin:10px 0 14px}p{font-size:13px;color:#b9b5ac;margin:0 0 8px}.muted{color:#85817a;font-size:11.5px}code{background:#0f1218;border:1px solid #262b34;padding:2px 8px;border-radius:6px;direction:ltr;display:inline-block;font-family:ui-monospace,monospace;font-size:11px}a{color:#d9b778}hr{width:36px;border:0;border-top:2px solid #262b34;margin:0 0 14px}</style></head>
<body><main class="card"><span class="ov">ADMIN — FALLBACK</span><hr />
<h1>پنل مدیریت ${escapeHtml(APP.faName)}</h1>
<p>فایل <code>public/admin.html</code> پیدا نشد. مطمئن شوید پوشهٔ <code>public</code> کامل deploy شده است.</p>
<p>راهنمای نصب در <code>README.md</code> موجود است.</p>
<p class="muted">${escapeHtml(APP.package)} — ArenaAi</p>
</main></body></html>`, 200, { 'Cache-Control': 'no-store' });
}

export function setupHint(env) {
  return hasDB(env) ? null : 'KV namespace DB is missing';
}
