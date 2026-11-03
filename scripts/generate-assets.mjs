// ============================================================
//  ArenaAi — ArenaAi-v1.0.0
//  scripts/generate-assets.mjs — build PNG logo, favicon and OG cover
//  Author: ArenaAi
//  Run: npm run assets   (requires the optional sharp package)
// ============================================================

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const assets = join(root, 'public', 'assets');
await mkdir(assets, { recursive: true });

const svg = await readFile(join(assets, 'logo.svg'));

await sharp(svg, { density: 384 })
  .resize(512, 512, { fit: 'contain' })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(join(assets, 'logo.png'));

await sharp(svg, { density: 384 })
  .resize(32, 32, { fit: 'contain' })
  .png({ compressionLevel: 9 })
  .toFile(join(assets, 'favicon-32.png'));

await sharp(svg, { density: 384 })
  .resize(180, 180, { fit: 'contain' })
  .png({ compressionLevel: 9 })
  .toFile(join(assets, 'apple-touch-icon.png'));

// A branded 1200×630 social preview. The Persian wordmark is rendered as
// shapes through the logo; the readable English copy stays font-safe.
const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#070b18"/>
      <stop offset=".55" stop-color="#101636"/>
      <stop offset="1" stop-color="#1b1038"/>
    </linearGradient>
    <linearGradient id="line" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#22d3ee"/>
      <stop offset=".5" stop-color="#7c5cff"/>
      <stop offset="1" stop-color="#ec4899"/>
    </linearGradient>
    <radialGradient id="glow" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#7c5cff" stop-opacity=".32"/>
      <stop offset="1" stop-color="#7c5cff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="940" cy="150" r="290" fill="url(#glow)"/>
  <circle cx="240" cy="520" r="220" fill="url(#glow)" opacity=".55"/>
  <path d="M0 70 H1200" stroke="url(#line)" stroke-width="3" opacity=".8"/>
  <path d="M0 560 H1200" stroke="url(#line)" stroke-width="2" opacity=".35"/>
  <text x="424" y="232" font-family="DejaVu Sans, Arial, sans-serif" font-size="64" font-weight="700" fill="#eef4ff">ArenaAi</text>
  <text x="426" y="286" font-family="DejaVu Sans, Arial, sans-serif" font-size="27" fill="#9aa8d4">Professional AI chat on Cloudflare Workers</text>
  <text x="426" y="336" font-family="DejaVu Sans, Arial, sans-serif" font-size="24" fill="#22d3ee">Web Chat  •  Telegram Bot  •  16 Personas</text>
  <text x="426" y="384" font-family="DejaVu Sans, Arial, sans-serif" font-size="22" fill="#9aa8d4">Cloudflare Workers AI · OpenRouter · OrcaRouter · OneRouter</text>
  <rect x="426" y="432" width="356" height="52" rx="26" fill="url(#line)" opacity=".18"/>
  <text x="604" y="466" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="20" fill="#dce6ff">ArenaAi</text>
  <text x="1088" y="574" text-anchor="end" font-family="DejaVu Sans, Arial, sans-serif" font-size="19" fill="#6f7fae">ArenaAi</text>
</svg>`;

const ogLogo = await sharp(svg, { density: 384 })
  .resize(280, 280, { fit: 'contain' })
  .png()
  .toBuffer();
const ogPng = await sharp(Buffer.from(ogSvg))
  .composite([{ input: ogLogo, left: 92, top: 175 }])
  .png({ compressionLevel: 9 })
  .toBuffer();
await writeFile(join(assets, 'og-cover.png'), ogPng);

console.log('✓ public/assets/logo.png');
console.log('✓ public/assets/favicon-32.png');
console.log('✓ public/assets/apple-touch-icon.png');
console.log('✓ public/assets/og-cover.png');
