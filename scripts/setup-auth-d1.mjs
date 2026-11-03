import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(root, 'wrangler.toml');
const migrationPath = resolve(root, 'migrations/0001_auth.sql');
const run = (args) => execSync('npx wrangler ' + args.join(' '), { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

if (!existsSync(configPath) || !existsSync(migrationPath)) throw new Error('فایل‌های تنظیمات یا migration پیدا نشدند.');
let config = readFileSync(configPath, 'utf8');
if (!config.includes('binding = "AUTH_DB"')) {
  console.log('در حال ساخت دیتابیس SQLite روی Cloudflare D1…');
  let output = '';
  try { output = run(['d1', 'create', 'arenaai-auth']); }
  catch (error) { output = String(error.stdout || '') + '\n' + String(error.stderr || ''); }
  const id = output.match(/database_id\s*=\s*"([a-f0-9-]+)"/i)?.[1];
  if (!id) {
    console.error(output);
    throw new Error('ساخت D1 انجام نشد. ابتدا فقط یک بار npx wrangler login را اجرا کنید و دوباره npm run setup:auth را بزنید.');
  }
  const binding = '\n# SQLite database for account registration and sessions\n[[d1_databases]]\nbinding = "AUTH_DB"\ndatabase_name = "arenaai-auth"\ndatabase_id = "' + id + '"\n';
  const varsIndex = config.indexOf('\n[vars]');
  config = varsIndex >= 0 ? config.slice(0, varsIndex) + binding + config.slice(varsIndex) : config + binding;
  writeFileSync(configPath, config, 'utf8');
  console.log('D1 ساخته شد و binding به wrangler.toml اضافه شد.');
} else {
  console.log('Binding دیتابیس D1 از قبل وجود دارد.');
}
console.log('در حال اعمال schema و ساخت جدول‌های کاربران و نشست‌ها…');
console.log(run(['d1', 'migrations', 'apply', 'arenaai-auth', '--remote']));
console.log('آماده است. اکنون npm run deploy را اجرا کنید.');
