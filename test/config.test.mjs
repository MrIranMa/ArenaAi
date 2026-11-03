// ============================================================
//  Technamooz AI — release/config contract tests
//  Author: Amir Parsa (امیر پارسا)
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP, PLATFORM_ORDER, PLATFORMS } from '../src/config.js';
import { ROOT, PUBLIC } from './helpers.mjs';

test('release metadata is technamooz-ai-version1.0.0 with Amir Parsa credit', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'arenaai');
  assert.equal(pkg.version, '1.0.0');
  assert.match(pkg.description, /Cloudflare Workers AI, OpenRouter, OrcaRouter, OneRouter/);
  assert.match(pkg.author, /Amir Parsa/);
  assert.equal(APP.package, 'technamooz-ai-version1.0.0');
  assert.equal(APP.version, '1.0.0');
  assert.equal(APP.authorEn, 'Amir Parsa');
});

test('wrangler config keeps existing KV and Workers AI; setup provisions D1 auth binding', () => {
  const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
  assert.match(toml, /run_worker_first\s*=\s*true/);
  assert.match(toml, /binding\s*=\s*"DB"/);
  assert.match(toml, /\[ai\]/);
  assert.match(toml, /binding\s*=\s*"AI"/);
  assert.equal(/\[\[d1_databases\]\]/.test(toml), false);
  assert.match(readFileSync(join(ROOT, 'scripts/setup-auth-d1.mjs'), 'utf8'), /d1 create arenaai-auth/);
  assert.equal(existsSync(join(ROOT, 'migrations', '0001_auth.sql')), true);
  assert.equal(/python/i.test(toml), false);
});

test('all four provider adapters are configured with HTTPS defaults', () => {
  assert.deepEqual(PLATFORM_ORDER, ['workersai', 'openrouter', 'orcarouter', 'onerouter']);
  for (const id of PLATFORM_ORDER) {
    assert.ok(PLATFORMS[id], id);
    assert.ok(PLATFORMS[id].defaultModel);
    if (PLATFORMS[id].baseUrl) assert.match(PLATFORMS[id].baseUrl, /^https:\/\//);
  }
  assert.equal(PLATFORMS.onerouter.allowBaseUrl, true);
});

test('required public/admin assets exist and public HTML has no admin link', () => {
  for (const name of ['logo.svg', 'logo.png', 'favicon-32.png', 'apple-touch-icon.png', 'og-cover.png']) {
    assert.equal(existsSync(join(PUBLIC, 'assets', name)), true, name);
  }
  const publicHtml = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
  assert.equal(publicHtml.includes('href="/admin"'), false);
  assert.match(publicHtml, /og-cover\.png/);
  assert.match(publicHtml, /favicon-32\.png/);
  const adminHtml = readFileSync(join(PUBLIC, 'admin.html'), 'utf8');
  assert.match(adminHtml, /پنل مدیریت/);
});
