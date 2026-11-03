// ============================================================
//  ArenaAi — ArenaAi-v1.0.0
//  Author: ArenaAi
//  scripts/setup-kv.mjs — one-shot setup:
//    1) creates the KV namespace DB via wrangler (no D1, no Python)
//    2) writes its id into wrangler.toml (replacing the placeholder)
//  Usage: npm run setup   →   then: npm run deploy
//  Provider keys and the Telegram token are added later in /admin.
// ============================================================

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const tomlPath = root + 'wrangler.toml';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main() {
  console.log('\n🚀 ArenaAi — Amaliyat-e Setup (ArenaAi)');
  console.log('──────────────────────────────────────────────────');

  if (!existsSync(tomlPath)) {
    console.error('❌ wrangler.toml پیدا نشد. از ریشهٔ پروژه اجرا کن.');
    process.exit(1);
  }

  let toml = readFileSync(tomlPath, 'utf8');
  if (toml.indexOf('PASTE_YOUR_KV_NAMESPACE_ID_HERE') === -1) {
    console.log('✅ wrangler.toml از قبل KV id دارد — نیازی به کار اضافه نیست.');
    console.log('\nقدم بعدی:  npx wrangler deploy');
    return;
  }

  console.log('📦 ساخت KV namespace با wrangler …');
  let out = '';
  try {
    out = run(`npx wrangler kv namespace create DB 2>&1`);
  } catch (e) {
    out = (e && e.stdout ? String(e.stdout) : '') + (e && e.stderr ? String(e.stderr) : '');
  }

  // wrangler prints something like: id = "03894b7c…7fae"
  const matches = [...out.matchAll(/id\s*=\s*"([a-f0-9]{32})"/g)].map((m) => m[1]);
  const unique = [...new Set(matches)];

  if (!unique.length) {
    console.log('\n⚠️ id automatically پیدا نشد. خروجی wrangler:\n────────────');
    console.log(out.slice(0, 1200));
    console.log('\nراه حل دستی:');
    console.log('  1) npx wrangler kv namespace create DB');
    console.log('  2) مقدار "id" را در wrangler.toml مقابل PASTE_YOUR_KV_NAMESPACE_ID_HERE بگذار');
    process.exit(2);
  }

  const kvId = unique[0];
  toml = toml.replace('PASTE_YOUR_KV_NAMESPACE_ID_HERE', kvId);
  writeFileSync(tomlPath, toml, 'utf8');

  console.log('\n✅ KV namespace ساخته شد: ' + kvId);
  console.log('✅ wrangler.toml به‌روز شد.');
  console.log('\nحالا دیپلوی کن:');
  console.log('   npx wrangler deploy\n');
}

main();
