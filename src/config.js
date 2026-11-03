// ============================================================
//  ArenaAi — ArenaAi-v1.0.0
//  Author: ArenaAi
//  src/config.js — application metadata, providers, defaults, limits
// ============================================================

export const APP = {
  name: 'ArenaAi',
  faName: 'آرنا ای‌آی',
  package: 'arenaai-1.0.0',
  version: '1.0.0',
  author: 'ArenaAi',
  authorEn: 'ArenaAi',
  tagline: 'دستیار هوش مصنوعی حرفه‌ای ArenaAi',
  description: 'پلتفرم چت هوش مصنوعی، ربات تلگرام و پنل مدیریت روی Cloudflare Workers',
  defaultAdminUser: 'admin',
  defaultAdminPass: 'admin',
  supportTelegram: '',
  supportHandle: '',
  website: '',
  social: []
};

export const KV_KEYS = {
  settings: 'settings:global',
  creds: 'creds:admin',
  tgBot: 'tg:bot',
  tgAdmins: 'tg:admins',
  logs: 'logs:recent',
  modelCache: (platform) => 'cache:models:v2:' + platform,
  providerKey: (platform) => 'keys:provider:' + platform,
  cfAccount: 'keys:cloudflare'
};

// All providers are OpenAI-compatible except Cloudflare Workers AI,
// which uses the native [ai] binding (or the REST fallback).
export const PLATFORMS = {
  workersai: {
    id: 'workersai',
    label: 'Cloudflare Workers AI',
    faLabel: 'کلادفلر (Workers AI)',
    icon: '☁️',
    color: '#f48120',
    desc: 'رایگان و سریع روی لبهٔ کلادفلر — بدون نیاز به کلید بیرونی',
    free: true,
    requiresKey: false,
    baseUrl: null,
    docs: 'https://developers.cloudflare.com/workers-ai/',
    keysUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    faLabel: 'OpenRouter',
    icon: '🌐',
    color: '#7c5cff',
    desc: 'صدها مدل از همهٔ شرکت‌ها؛ ده‌ها مدل رایگان با یک کلید',
    free: true,
    requiresKey: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    keyPrefix: 'sk-or-',
    docs: 'https://openrouter.ai/docs/quickstart',
    keysUrl: 'https://openrouter.ai/keys',
    defaultModel: 'openrouter/free'
  },
  orcarouter: {
    id: 'orcarouter',
    label: 'OrcaRouter',
    faLabel: 'OrcaRouter',
    icon: '🐋',
    color: '#22d3ee',
    desc: 'روتر چندمدلی با مدل‌های رایگان و ۲۰۰+ مدل دیگر',
    free: true,
    requiresKey: true,
    baseUrl: 'https://api.orcarouter.ai/v1',
    keyPrefix: 'sk-orca-',
    docs: 'https://docs.orcarouter.ai/introduction',
    keysUrl: 'https://www.orcarouter.ai',
    defaultModel: 'orcarouter/free'
  },
  onerouter: {
    id: 'onerouter',
    label: 'OneRouter',
    faLabel: 'OneRouter',
    icon: '🧭',
    color: '#34d399',
    desc: 'درگاه سازگار با OpenAI برای چند سرویس‌دهنده (قابل تنظیم)',
    free: true,
    requiresKey: true,
    baseUrl: 'https://llm.onerouter.pro/v1',
    keyPrefix: '',
    allowBaseUrl: true,
    docs: 'https://infron.ai/docs',
    keysUrl: 'https://infron.ai/dashboard/apiKeys',
    defaultModel: 'deepseek/deepseek-v4.1-flash:free'
  }
};

export const PLATFORM_ORDER = ['workersai', 'openrouter', 'orcarouter', 'onerouter'];

export const DEFAULT_SETTINGS = {
  siteTitle: 'ArenaAi | آرنا ای‌آی',
  announcement: '',
  defaultPlatform: 'workersai',
  defaultModel: {
    workersai: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    openrouter: 'openrouter/free',
    orcarouter: 'orcarouter/free',
    onerouter: 'deepseek/deepseek-v4.1-flash:free'
  },
  defaultPersona: 'general',
  // Maximum output budget. Provider/model caps are applied automatically.
  maxTokensNormal: 4096,
  maxTokensDeep: 12288,
  // Per-user conversation memory.
  roundsCap: 24,
  memoryEnabled: true,
  factsEnabled: true,
  fallbackEnabled: true,
  maintenance: false,
  extraInstructions: '',
  feedbackPrompt: 'پیام شما برای تیم ArenaAi ثبت شد ❤️'
};

export const LIMITS = {
  messageMaxChars: 24000,
  chatRateLimit: 35,
  chatRateWindowSec: 600,
  loginTries: 6,
  loginWindowSec: 900,
  sessionTtlSec: 43200, // 12 hours
  deepTokensLimit: 32768,
  factsCap: 16,
  contextCharsNormal: 36000,
  contextCharsDeep: 90000,
  maxModelsReturn: 650,
  adminPageSize: 20,
  broadcastBatch: 10,
  passwordMin: 12,
  passwordMax: 72,
  // PBKDF2 is CPU-bound. The free Workers plan has a very small CPU budget.
  // 2,500 iterations keeps admin login reliable on the free plan.
  // On a paid plan you can set ADMIN_PBKDF2_ITERATIONS=100000 as a Worker var.
  pbkdf2Iterations: 2500,
  pbkdf2MaxIterations: 100000
};

export function platformList() {
  return PLATFORM_ORDER.map((id) => {
    const p = PLATFORMS[id];
    return {
      id: p.id,
      label: p.label,
      faLabel: p.faLabel,
      icon: p.icon,
      color: p.color,
      desc: p.desc,
      free: p.free,
      requiresKey: p.requiresKey,
      docs: p.docs,
      keysUrl: p.keysUrl,
      defaultModel: p.defaultModel,
      allowBaseUrl: !!p.allowBaseUrl
    };
  });
}
