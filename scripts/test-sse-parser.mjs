// ============================================================
//  ArenaAi — offline unit test for parseProviderSse
//  (no Cloudflare account needed — pure stream simulation)
//  Usage: node scripts/test-sse-parser.mjs
// ============================================================
import { parseProviderSse } from '../src/providers.js';

const OPEN = '\x3Cthink\x3E';
const CLOSE = '\x3C/think\x3E';

function stringStream(pieces, { delay = 0, sseWrap = true } = {}) {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(c) {
      for (const p of pieces) {
        // Some tests pass complete SSE frames (`data: ...\n\n`) and others
        // pass bare JSON payloads. Do not double-wrap complete frames.
        const raw = !sseWrap || /^(data:|:)/.test(p) ? p : 'data: ' + p + '\n\n';
        c.enqueue(enc.encode(raw));
        if (delay) await new Promise((r) => setTimeout(r, delay));
      }
      c.close();
    }
  });
}

async function collect(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const out = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of dec.decode(value).split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return out;
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures++;
    console.log('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''));
  }
}

/* ---------- test 1: OpenRouter-style, think tags split across chunks ---------- */
console.log('test 1: think tag split across SSE chunks (OpenRouter style)');
{
  const q1 = 'data: {"choices":[{"delta":{"content":"سلام"}}]}\n\n';
  const q2 = 'data: {"choices":[{"delta":{"content":"' + OPEN.slice(0, 4) + '"}}]}\n\n'; // "<thi"
  const q3 = 'data: {"choices":[{"delta":{"content":"' + OPEN.slice(4) + '"}}]}\n\n';       // "nk>"
  const q4 = 'data: {"choices":[{"delta":{"content":"جواب را حساب می‌کنم"}}]}\n\n';
  const q5 = 'data: {"choices":[{"delta":{"content":"' + CLOSE.slice(0, 5) + '"}}]}\n\n';  // "</thi"
  const q6 = 'data: {"choices":[{"delta":{"content":"' + CLOSE.slice(5) + '"}}]}\n\n';     // "nk>"
  const q7 = 'data: {"choices":[{"delta":{"content":"144"}}]}\n\n';
  const q8 = 'data: [DONE]\n\n';
  const events = await collect(parseProviderSse(stringStream([q1, q2, q3, q4, q5, q6, q7, q8])));
  const kinds = events.map((e) => e.type);
  check('delta first', kinds[0] === 'delta', kinds);
  check('reasoning middle', kinds.includes('reasoning'));
  const last = events[events.length - 1];
  check('answer "144" after think closes', last && last.type === 'delta' && last.v === '144', events);
  const reasoningText = events.filter((e) => e.type === 'reasoning').map((e) => e.v).join('');
  check('reasoning text intact', reasoningText === 'جواب را حساب می‌کنم', reasoningText);
}

/* ---------- test 2: Cloudflare style — reasoning then response ---------- */
console.log('test 2: CF style reasoning events + response');
{
  const pieces = [
    'data: {"reasoning":"فکر اول"}\n\n',
    'data: {"response":"resp2"}\n\n',
    'data: {"response":"' + OPEN + 'تحلیل' + CLOSE + 'پاسخ نهایی"}\n\n',
    'data: [DONE]\n\n'
  ];
  const events = await collect(parseProviderSse(stringStream(pieces)));
  const kinds = events.map((e) => e.type).join(',');
  check('reasoning → delta → reasoning → delta', kinds === 'reasoning,delta,reasoning,delta', events);
  const last = events[events.length - 1];
  check('final answer', last.v === 'پاسخ نهایی', events);
}

/* ---------- test 3: bare CF response with inline think only ---------- */
console.log('test 3: whole answer arrives in ONE CF event with inline tags');
{
  const one = 'data: {"response":"' + OPEN + 'step1...step2' + CLOSE + 'ثبت شد"}\n\n';
  const events = await collect(parseProviderSse(stringStream([one, 'data: [DONE]\n\n'])));
  check('reasoning present', events.some((e) => e.type === 'reasoning'));
  check('delta answer', events[events.length - 1].v === 'ثبت شد', events);
}

/* ---------- test 4: split of the whole think PAIR inside one small chunk ---------- */
console.log('test 4: tag pair arrives across 2-char micro-chunks');
{
  const full = OPEN + 'می‌اندیشم' + CLOSE + 'پاسخ';
  const pieces = [];
  for (let i = 0; i < full.length; i += 2) {
    pieces.push('data: {"response":"' + full.slice(i, i + 2).replace(/"/g, '\\"') + '"}\n\n');
  }
  pieces.push('data: [DONE]\n\n');
  const events = await collect(parseProviderSse(stringStream(pieces)));
  const reasoningText = events.filter((e) => e.type === 'reasoning').map((e) => e.v).join('');
  const deltaText = events.filter((e) => e.type === 'delta').map((e) => e.v).join('');
  check('reasoning == می‌اندیشم', reasoningText === 'می‌اندیشم', { reasoningText });
  check('delta == پاسخ', deltaText === 'پاسخ', { deltaText });
}

/* ---------- test 5: math containing "<" must NOT trigger think mode ---------- */
console.log('test 5: "<" in normal text (e.g. a < b) stays a delta');
{
  const pieces = [
    'data: {"response":"اگر a < b آنگاه x"}\n\n',
    'data: [DONE]\n\n'
  ];
  const events = await collect(parseProviderSse(stringStream(pieces)));
  const deltaText = events.filter((e) => e.type === 'delta').map((e) => e.v).join('');
  check('no reasoning frames', !events.some((e) => e.type === 'reasoning'), events);
  check('text preserved', deltaText === 'اگر a < b آنگاه x', deltaText);
}

/* ---------- test 6: keep-alive comments + noise ---------- */
console.log('test 6: comments / noise are ignored');
{
  const pieces = [
    ': OPENROUTER PROCESSING\n\n',
    'data: {"choices":[{"delta":{}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    'data: not-json-here\n\n',
    'data: [DONE]\n\n'
  ];
  const events = await collect(parseProviderSse(stringStream(pieces)));
  check('only one delta', events.length === 1 && events[0].v === 'ok', events);
}

console.log('');
console.log(failures === 0 ? '✅ همهٔ تست‌های SSE پاس شدند' : '❌ ' + failures + ' تست شکست خورد');
process.exit(failures === 0 ? 0 : 1);
