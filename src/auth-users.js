// ArenaAi account authentication backed by Cloudflare D1 (SQLite).
import { isSecureRequest, readCookie, sameOrigin } from './auth.js';

const COOKIE = 'arenaai_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function randomHex(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
async function digest(value) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
async function passwordHash(password, salt, iterations = 210000) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(salt), iterations }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}
function equal(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function cookie(token, secure) {
  return COOKIE + '=' + token + '; Path=/; Max-Age=' + SESSION_SECONDS + '; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '');
}
function clearCookie(secure) {
  return COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '');
}
function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}
function db(env) {
  return env && env.AUTH_DB && typeof env.AUTH_DB.prepare === 'function' ? env.AUTH_DB : null;
}
export function authDatabaseReady(env) { return !!db(env); }

async function rate(env, request, action, max = 8) {
  if (!env.DB || typeof env.DB.put !== 'function') return true;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const key = 'auth-rate:' + action + ':' + ip;
  const now = Date.now();
  let row = null;
  try { row = await env.DB.get(key, 'json'); } catch {}
  if (row && row.until > now && row.count >= max) return false;
  const next = row && row.until > now ? row.count + 1 : 1;
  await env.DB.put(key, JSON.stringify({ count: next, until: now + 900000 }), { expirationTtl: 900 });
  return true;
}

export async function currentAccount(request, env) {
  const database = db(env);
  if (!database) return null;
  const token = readCookie(request, COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = await digest(token);
  const row = await database.prepare(
    'SELECT u.id, u.email, u.uid, u.created_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?1 AND s.expires_at>?2 LIMIT 1'
  ).bind(tokenHash, Date.now()).first();
  return row || null;
}

export async function handleAccountAuth(request, env, path) {
  const database = db(env);
  if (!database) return json({ ok: false, setup: true, error: 'پایگاه‌دادهٔ حساب‌ها هنوز راه‌اندازی نشده است.' }, 503);
  if (path === '/api/auth/session' && request.method === 'GET') {
    const user = await currentAccount(request, env);
    return json({ ok: true, authenticated: !!user, user: user ? { id: user.id, email: user.email, createdAt: user.created_at } : null });
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'متد پشتیبانی نمی‌شود.' }, 405);
  if (!sameOrigin(request)) return json({ ok: false, error: 'درخواست از مبدأ نامعتبر رد شد.' }, 403);
  if (path === '/api/auth/logout') {
    const token = readCookie(request, COOKIE);
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      await database.prepare('DELETE FROM sessions WHERE token_hash=?1').bind(await digest(token)).run();
    }
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(isSecureRequest(request)) });
  }
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'اطلاعات ارسالی معتبر نیست.' }, 400); }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!validEmail(email)) return json({ ok: false, error: 'ایمیل معتبر وارد کنید.' }, 400);
  if (password.length < 10 || password.length > 128) return json({ ok: false, error: 'رمز عبور باید حداقل ۱۰ نویسه داشته باشد.' }, 400);
  const action = path.endsWith('/register') ? 'register' : 'login';
  if (!(await rate(env, request, action, action === 'login' ? 10 : 5))) {
    return json({ ok: false, error: 'تعداد تلاش‌ها زیاد است؛ ۱۵ دقیقه دیگر دوباره امتحان کنید.' }, 429);
  }

  let user;
  if (action === 'register') {
    const id = randomHex(16);
    const uid = randomHex(16);
    const salt = randomHex(16);
    const hash = await passwordHash(password, salt);
    try {
      await database.prepare('INSERT INTO users (id,email,password_salt,password_hash,uid,created_at) VALUES (?1,?2,?3,?4,?5,?6)')
        .bind(id, email, salt, hash, uid, Date.now()).run();
      user = { id, email, uid };
    } catch (error) {
      if (String(error && error.message || error).toLowerCase().includes('unique')) {
        return json({ ok: false, error: 'این ایمیل قبلاً ثبت‌نام کرده است؛ وارد حساب شوید.' }, 409);
      }
      throw error;
    }
  } else if (action === 'login') {
    user = await database.prepare('SELECT id,email,password_salt,password_hash,uid FROM users WHERE email=?1 LIMIT 1').bind(email).first();
    const salt = user && user.password_salt || '00000000000000000000000000000000';
    const candidate = await passwordHash(password, salt);
    if (!user || !equal(candidate, user.password_hash)) {
      return json({ ok: false, error: 'ایمیل یا رمز عبور اشتباه است.' }, 401);
    }
  } else {
    return json({ ok: false, error: 'مسیر ورود نامعتبر است.' }, 404);
  }

  const token = randomHex(32);
  const expires = Date.now() + SESSION_SECONDS * 1000;
  await database.prepare('INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?1,?2,?3,?4)')
    .bind(await digest(token), user.id, Date.now(), expires).run();
  await database.prepare('DELETE FROM sessions WHERE expires_at<=?1').bind(Date.now()).run();
  return json({ ok: true, user: { id: user.id, email: user.email } }, 200, {
    'Set-Cookie': cookie(token, isSecureRequest(request))
  });
}

export async function requireAccount(request, env) {
  if (!db(env)) return { error: json({ ok: false, setup: true, error: 'پایگاه‌دادهٔ حساب‌ها هنوز راه‌اندازی نشده است.' }, 503) };
  const user = await currentAccount(request, env);
  return user ? { user } : { error: json({ ok: false, auth: true, error: 'برای استفاده از هوش مصنوعی ابتدا وارد حساب شوید.' }, 401) };
}

export function authCookieName() { return COOKIE; }
