// ============================================================
//  ArenaAi — ArenaAi-v1.0.0
//  Author: ArenaAi
//  src/auth.js — admin password hashing, sessions, CSRF, rate limits
// ============================================================

import { APP, LIMITS } from './config.js';
import { getCreds, setCreds, rateLimit, log } from './store.js';

const encoder = new TextEncoder();

/* ============================ hashing ============================ */

function iterationsFor(env) {
  const configured = env && env.ADMIN_PBKDF2_ITERATIONS ? parseInt(env.ADMIN_PBKDF2_ITERATIONS, 10) : 0;
  const iter = Number.isFinite(configured) && configured > 0 ? configured : LIMITS.pbkdf2Iterations;
  return Math.max(1000, Math.min(LIMITS.pbkdf2MaxIterations, iter));
}

async function pbkdf2(password, saltHex, iterations) {
  const salt = hexToBytes(saltHex);
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function hashPassword(password, env) {
  const salt = randomHex(16);
  const iter = iterationsFor(env);
  const hash = await pbkdf2(password, salt, iter);
  return { salt, iter, hash };
}

export async function verifyPassword(password, cred) {
  if (!cred || !cred.salt || !cred.hash) return false;
  // Older builds stored the PBKDF2 cost as `iterations`; keep those
  // credentials usable while the new field is `iter`.
  const iterations = Number(cred.iter || cred.iterations) || LIMITS.pbkdf2Iterations;
  const hash = await pbkdf2(password, cred.salt, iterations);
  return timingSafeEq(hash, cred.hash);
}

export async function ensureCreds(env) {
  let cred = await getCreds(env);
  if (!cred || !cred.hash) {
    const { salt, iter, hash } = await hashPassword(APP.defaultAdminPass, env);
    cred = {
      username: APP.defaultAdminUser,
      salt,
      iter,
      hash,
      epoch: 0,
      mustChange: true,
      createdAt: Date.now()
    };
    await setCreds(env, cred);
  } else if (typeof cred.epoch !== 'number') {
    // Normalize credentials created by older releases so that sessions
    // can be revoked reliably with the epoch mechanism.
    cred = { ...cred, epoch: 0 };
    await setCreds(env, cred);
  }
  return cred;
}

/* ============================ sessions ============================ */

export function randomToken(bytes = 32) {
  return randomHex(bytes);
}

export async function createSession(env, username, epoch = 0) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const record = {
    u: username,
    e: epoch,
    csrf,
    c: Date.now()
  };
  await env.DB.put('sess:' + token, JSON.stringify(record), {
    expirationTtl: LIMITS.sessionTtlSec
  });
  return { token, csrf };
}

export async function getSession(env, request) {
  const token = readCookie(request, 'tm_admin');
  if (!token) return null;

  let record = null;
  try {
    record = await env.DB.get('sess:' + token, 'json');
  } catch {
    return null;
  }
  if (!record) return null;

  // Changing credentials / "logout everywhere" bumps the epoch.
  const cred = await getCreds(env);
  if (cred && typeof cred.epoch === 'number' && record.e !== cred.epoch) {
    try { await env.DB.delete('sess:' + token); } catch { /* ignore */ }
    return null;
  }
  return { ...record, token };
}

export async function requireAdmin(request, env) {
  return getSession(env, request);
}

export async function requireCsrf(request, session) {
  if (!session || !session.csrf) return false;
  const header = request.headers.get('x-csrf-token') || '';
  return timingSafeEq(header, session.csrf);
}

export async function destroySession(env, request) {
  const token = readCookie(request, 'tm_admin');
  if (token) {
    try { await env.DB.delete('sess:' + token); } catch { /* ignore */ }
  }
}

export function isSecureRequest(request) {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return true;
  }
}

export function adminCookie(token, secure = true) {
  return 'tm_admin=' + token + '; Path=/; Max-Age=' + LIMITS.sessionTtlSec +
    '; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');
}

export function clearAdminCookie(secure = true) {
  return 'tm_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');
}

export function uidCookie(uid, secure = true) {
  return 'tm_uid=' + uid + '; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '');
}

/* ============================ login protection ============================ */

export async function loginGuard(env, request) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  return rateLimit(env, 'login:' + ip, LIMITS.loginTries, LIMITS.loginWindowSec);
}

export async function logSecurityEvent(env, msg) {
  await log(env, 'security', msg);
}

/**
 * Best-effort CSRF defense in depth. The primary defense is the
 * X-CSRF-Token header checked by requireCsrf().
 */
export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // non-browser clients (curl, tests)
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/* ============================ cookies ============================ */

export function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return part.slice(eq + 1).trim(); }
    }
  }
  return null;
}

/* ============================ utils ============================ */

function randomHex(byteLen) {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const clean = String(hex || '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function timingSafeEq(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
