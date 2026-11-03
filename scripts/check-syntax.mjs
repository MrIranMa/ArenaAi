// ============================================================
//  Technamooz AI — technamooz-ai-version1.0.0
//  scripts/check-syntax.mjs — syntax check for all JS sources
//  (worker modules are ESM; package.json has "type":"module")
// ============================================================

import { execSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.wrangler' || name === '.git') continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.m?js$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(root);
let fail = 0;
for (const f of files) {
  try {
    execSync(`node --check ${JSON.stringify(f)}`, { stdio: 'ignore' });
    console.log('  ✓', relative(root, f));
  } catch (e) {
    fail++;
    console.log('  ✗ SYNTAX ERROR →', relative(root, f));
    try {
      execSync(`node --check ${JSON.stringify(f)}`, { stdio: 'inherit' });
    } catch { /* printed */ }
  }
}
console.log('');
if (fail) {
  console.log(`${fail} file(s) have syntax errors — fix them before deploy.`);
  process.exit(1);
}
console.log('✅ همهٔ فایل‌های JS سالم هستند (Technamooz AI — امیر پارسا).');
