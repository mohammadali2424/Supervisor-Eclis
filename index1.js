// index1.js — Trigger Bot (hardened)
require('dotenv').config();

const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const helmet = require('helmet');
const cors = require('cors');
const { URL } = require('url');

// ---------- Env ----------
const {
  BOT_TOKEN,
  QUARANTINE_BOT_URL, // e.g. https://qb.example.com
  API_SECRET_KEY,     // باید با قرنطینه shared باشد
  RENDER_EXTERNAL_URL,
  PORT
} = process.env;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN لازم است');
if (!QUARANTINE_BOT_URL) throw new Error('QUARANTINE_BOT_URL لازم است');
if (!API_SECRET_KEY) throw new Error('API_SECRET_KEY لازم است');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(helmet());
app.use(cors({ origin: false }));

const port = Number(PORT || 3001);
const bot = new Telegraf(BOT_TOKEN);
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

let SELF_BOT_ID = null;

// ---------- Utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureHttpUrl(u) {
  try {
    let s = String(u || '').trim();
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    const parsed = new URL(s);
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    throw new Error('QUARANTINE_BOT_URL نامعتبر است');
  }
}

const QB_URL = ensureHttpUrl(QUARANTINE_BOT_URL);

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// apply entities safely onto already-escaped text
function createFormattedMessage(text = '', entities = []) {
  let base = escapeHtml(text);
  if (!Array.isArray(entities) || entities.length === 0) {
    return { text: base, parse_mode: 'HTML', disable_web_page_preview: true };
  }

  // محاسبهٔ substring امن: فرض بر این است که offset/length بر اساس متن خام است.
  // چون escape انجام شده، offsets بر هم می‌خورد. راه امن: فعلاً فقط متن خام را Escape می‌کنیم
  // و از entities برای wrap کردن کل متن صرف‌نظر می‌کنیم مگر اینکه نیاز شدید داشته باشی.
  // (اگر لازم داری دقیقاً همسان تلگرام رفتار کند، باید mapping خام→escaped بسازی.)
  return { text: base, parse_mode: 'HTML', disable_web_page_preview: true };
}

// ---------- Release bridge ----------
async function callRelease(userId, sourceBot = 'trigger-bot') {
  const url = `${QB_URL}/api/release-user`;
  const payload = { userId, secretKey: API_SECRET_KEY, sourceBot };
  const { data } = await axios.post(url, payload, { timeout: 10_000 });
  return Boolean(data?.success);
}

// ---------- Bot logic (triggering) ----------
bot.on('chat_member', async (ctx) => {
  try {
    const cmu = ctx.update.chat_member;
    const chatId = cmu.chat.id;
    const userId = cmu.new_chat_member?.user?.id;
    if (!chatId || !userId) return;

    // نمونه: پیام خوش‌آمد تأخیری + آزادسازی
    const name = cmu.new_chat_member?.user?.first_name || 'دوست عزیز';
    const msg = createFormattedMessage(`خوش اومدی ${name}! لطفاً قوانین گروه را بخوان.`);
    await sleep(1500);
    await ctx.reply(msg.text, { parse_mode: msg.parse_mode, disable_web_page_preview: true });

    // سپس درخواست آزادسازی به قرنطینه
    await callRelease(userId, 'trigger-bot:welcome');
  } catch (e) {
    console.log('[TB] chat_member error:', e?.message);
  }
});

// نمونهٔ ساده از یک دستور برای تست
bot.command('ping', (ctx) => ctx.reply('pong'));

// ---------- HTTP ----------
app.get('/', (_, res) => res.type('html').send('<h1>🤖 Trigger bot is up</h1>'));
app.get('/health', (_, res) => res.json({ ok: true }));

// اگر می‌خواهی endpoint داخلی release-user بماند، ایمنش می‌کنیم (یا کامل حذفش کن)
app.post('/api/release-user', async (req, res) => {
  try {
    const { userId, secretKey } = req.body || {};
    if (secretKey !== API_SECRET_KEY) return res.status(401).json({ success: false });
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) return res.status(400).json({ success: false, error: 'Bad userId' });
    // اینجا عمداً کار خاصی نمی‌کنیم؛ فقط OK می‌دهیم.
    return res.json({ success: true, echo: uid });
  } catch {
    return res.status(500).json({ success: false });
  }
});

// وبهوک امن
const webhookPath = '/webhook';
if (RENDER_EXTERNAL_URL) {
  app.use(webhookPath, (req, res, next) => {
    const token = req.get('X-Telegram-Bot-Api-Secret-Token');
    if (!API_SECRET_KEY || token !== API_SECRET_KEY) return res.sendStatus(401);
    return bot.webhookCallback(webhookPath)(req, res, next);
  });
}

// ---------- Launch ----------
(async () => {
  try {
    const me = await bot.telegram.getMe();
    SELF_BOT_ID = me?.id;
    console.log('[TB] Bot username:', me?.username, 'ID:', SELF_BOT_ID);

    if (RENDER_EXTERNAL_URL) {
      const url = `${RENDER_EXTERNAL_URL}${webhookPath}`;
      await bot.telegram.setWebhook(url, { secret_token: API_SECRET_KEY });
      console.log('[TB] Webhook set:', url);
    } else {
      await bot.launch();
      console.log('[TB] Bot started in polling mode');
    }

    app.listen(port, () => console.log('[TB] HTTP listening on', port));
  } catch (e) {
    console.error('[TB] Startup error:', e?.message);
    process.exit(1);
  }
})();

process.on('unhandledRejection', (err) => {
  console.error('[TB] UnhandledRejection:', err?.message);
});
