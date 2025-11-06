// ============ Trigger Bot (index1.js) ============
const { Telegraf, session, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');

// ---------- Env ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;
const OWNER_ID = parseInt(process.env.OWNER_ID || '0', 10);
const SELF_BOT_ID = process.env.SELF_BOT_ID || 'trigger_1';
const QUARANTINE_BOT_URL = process.env.QUARANTINE_BOT_URL || '';
const API_SECRET_KEY = process.env.API_SECRET_KEY || '';

if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN تنظیم نشده'); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('❌ SUPABASE_URL/SUPABASE_KEY تنظیم نشده'); process.exit(1); }

// ---------- Infra ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

const cache = new NodeCache({ stdTTL: 3600, checkperiod: 1200, maxKeys: 4000 });

// ---------- Session ----------
bot.use(session({
  defaultSession: () => ({ settingTrigger: false, triggerType: null, step: null, delay: null, chatId: null })
}));

// ---------- Keep-alive ----------
const startAutoPing = () => {
  if (!process.env.RENDER_EXTERNAL_URL) return;
  const PING_INTERVAL = 13 * 60 * 1000 + 59 * 1000;
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  const ping = async () => { try { await axios.head(`${selfUrl}/ping`, { timeout: 5000 }); } catch { setTimeout(ping, 60_000); } };
  setTimeout(ping, 30_000); setInterval(ping, PING_INTERVAL);
};
app.head('/ping', (_req, res) => res.status(200).end());
app.get('/ping', (_req, res) => res.status(200).json({ status: 'active', bot: SELF_BOT_ID }));

// ---------- Helpers ----------
const isOwner = (ctx) => (ctx.from?.id === OWNER_ID);
const replyNotOwner = async (ctx) => {
  try { await ctx.reply('به غیر از ارباب کسی نمیتونه به ما دستور بده', { reply_to_message_id: ctx.message?.message_id }); } catch {}
};
const ensureOwner = (ctx) => { if (isOwner(ctx)) return true; replyNotOwner(ctx); return false; };

const formatTime = (s) => (s < 60 ? `${s} ثانیه` : `${Math.floor(s/60)} دقیقه`);
const createGlassButton = () => Markup.inlineKeyboard([Markup.button.callback('Eclis World', 'show_glass')]);

const getTriggerRow = async (chatId, triggerType) => {
  const key = `trigger_${chatId}_${triggerType}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const { data, error } = await supabase
    .from('triggers')
    .select('delay, delayed_message, message_entities')
    .eq('chat_id', `${chatId}`)
    .eq('trigger_type', triggerType)
    .single();

  if (!error && data) { cache.set(key, data, 3600); return data; }
  return null;
};

// ---------- Actions ----------
bot.action('show_glass', async (ctx) => {
  try { await ctx.answerCbQuery('به دنیای اکلیس خوش آمدید!', { show_alert: true }); }
  catch { await ctx.answerCbQuery('⚠️ خطا!', { show_alert: true }); }
});

// ---------- Commands ----------
bot.start((ctx) => ctx.reply('نینجا در خدمت شماست 🥷🏻'));

bot.command('help', (ctx) => {
  ctx.reply(
`🤖 راهنما:
/status - وضعیت
/set_t1 - تنظیم #ورود
/set_t2 - تنظیم #ماشین
/set_t3 - تنظیم #موتور
/off - غیرفعال کردن و ترک گروه
#ورود #ماشین #موتور #خروج`
  );
});

bot.command('status', async (ctx) => {
  if (!ensureOwner(ctx)) return;
  let info = '\n⚙️ تریگرها:';
  const { data, error } = await supabase.from('triggers').select('trigger_type, delay').eq('chat_id', `${ctx.chat.id}`);
  if (!error && data?.length) {
    data.forEach(t => {
      const emoji = t.trigger_type === 'ورود' ? '🚪' : (t.trigger_type === 'ماشین' ? '🚗' : '🏍️');
      info += `\n${emoji} #${t.trigger_type}: ${formatTime(t.delay)}`;
    });
  } else info += '\n❌ تریگری تنظیم نشده';
  ctx.reply(`🤖 وضعیت:${info}`);
});

const setupTrigger = async (ctx, triggerType) => {
  if (!ensureOwner(ctx)) return;
  ctx.session.settingTrigger = true;
  ctx.session.triggerType = triggerType;
  ctx.session.step = 'delay';
  ctx.session.chatId = ctx.chat.id;
  const emoji = triggerType === 'ورود' ? '🚪' : (triggerType === 'ماشین' ? '🚗' : '🏍️');
  await ctx.reply(`${emoji} تریگر #${triggerType}\n⏰ زمان به ثانیه:`);
};
bot.command('set_t1', (ctx) => setupTrigger(ctx, 'ورود'));
bot.command('set_t2', (ctx) => setupTrigger(ctx, 'ماشین'));
bot.command('set_t3', (ctx) => setupTrigger(ctx, 'موتور'));

bot.command('off', async (ctx) => {
  if (!ensureOwner(ctx)) return;
  const chatId = `${ctx.chat.id}`;
  const { error } = await supabase.from('triggers').delete().eq('chat_id', chatId);
  if (error) { await ctx.reply('⚠️ تریگرها پاک نشد، تلاش برای ترک گروه...'); }
  else {
    ['ورود','ماشین','موتور','خروج'].forEach(t => cache.del(`trigger_${chatId}_${t}`));
    await ctx.reply('✅ تریگرها پاک شد. ربات گروه را ترک می‌کند...');
  }
  try { await ctx.leaveChat(); } catch {}
});

// ---------- Trigger runtime ----------
const releaseUserFromQuarantine = async (userId) => {
  if (!QUARANTINE_BOT_URL || !API_SECRET_KEY) return true;
  let apiUrl = QUARANTINE_BOT_URL.startsWith('http') ? QUARANTINE_BOT_URL : `https://${QUARANTINE_BOT_URL}`;
  apiUrl = apiUrl.replace(/\/+$/, '');
  const apiEndpoint = `${apiUrl}/api/release-user`;
  const body = { userId: parseInt(userId, 10), secretKey: API_SECRET_KEY, sourceBot: SELF_BOT_ID };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await axios.post(apiEndpoint, body, { timeout: 10000, headers: { 'Content-Type': 'application/json' }});
      if (resp.data?.success) return true;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
};

const handleTrigger = async (ctx, triggerType) => {
  try {
    if (ctx.chat.type === 'private') return; // فقط برای گروه‌ها

    const userName = ctx.from.first_name || 'کاربر';
    const userId = ctx.from.id;

    // دریافت پیکربندی تریگر
    const row = await getTriggerRow(ctx.chat.id, triggerType);
    const delay = row?.delay ?? 5;  // تاخیر به ثانیه (حداقل 1 ثانیه)
    const delayedMessage = row?.delayed_message ?? 'عملیات تکمیل شد! ✅';
    const messageEntities = row?.message_entities ?? [];  // استفاده از entities برای format

    const emoji = triggerType === 'ورود' ? '🎴' : (triggerType === 'ماشین' ? '🚗' : '🏍️');
    const initialMessage = `${emoji}┊${userName} وارد منطقه شد\n\n⏳┊زمان: ${formatTime(delay)}`;

    await ctx.reply(initialMessage, { reply_to_message_id: ctx.message.message_id, ...createGlassButton() });

    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;

    // ارسال پیام تأخیری پس از delay
    setTimeout(async () => {
      try {
        // ارسال پیام با entities
        const formatted = createFormattedMessage(delayedMessage, messageEntities);
        await bot.telegram.sendMessage(chatId, formatted.text, { reply_to_message_id: messageId, ...createGlassButton(), ...formatted });

        // آزادسازی از قرنطینه (اگر مورد نیاز بود)
        await releaseUserFromQuarantine(userId);
      } catch (e) {
        console.log('❌ ارسال پیام تأخیری/آزادسازی:', e.message);
      }
    }, delay * 1000); // تاخیر به ثانیه
  } catch (e) {
    console.log('❌ پردازش تریگر:', e.message);
  }
};

// NEW: پیام خروج فوری (بدون تریگر و بدون تاخیر)
const handleFarewell = async (ctx) => {
  try {
    if (ctx.chat.type === 'private') return;
    const user = ctx.from;
    const displayName = user.first_name || user.username || 'کاربر';
    const mention = `<a href="tg://user?id=${user.id}">${displayName}</a>`;
    const text = `🧭┊سفر به سلامت ${mention}`;
    await ctx.reply(text, { reply_to_message_id: ctx.message.message_id, parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) {
    console.log('❌ پیام خروج:', e.message);
  }
};

// ---------- Text pipeline ----------
bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text || '';

    if (text.includes('#خروج')) {
      await handleFarewell(ctx);
      return;
    }

    if (text.includes('#ورود')) await handleTrigger(ctx, 'ورود');
    if (text.includes('#ماشین')) await handleTrigger(ctx, 'ماشین');
    if (text.includes('#موتور')) await handleTrigger(ctx, 'موتور');

    if (!ctx.session.settingTrigger) return;
    if (!isOwner(ctx)) { await replyNotOwner(ctx); ctx.session.settingTrigger = false; return; }

    if (ctx.session.step === 'delay') {
      const delay = parseInt(text, 10);
      if (isNaN(delay) || delay <= 0 || delay > 3600) return ctx.reply('❌ عدد 1 تا 3600');
      ctx.session.delay = delay; ctx.session.step = 'message';
      return ctx.reply(`✅ زمان: ${formatTime(delay)}\n📝 پیام:`);
    }

    if (ctx.session.step === 'message') {
      try {
        const entities = ctx.message.entities || [];
        await supabase.from('triggers').delete().eq('chat_id', ctx.session.chatId).eq('trigger_type', ctx.session.triggerType);
        const { error } = await supabase.from('triggers').insert({
          chat_id: `${ctx.session.chatId}`,
          trigger_type: ctx.session.triggerType,
          delay: ctx.session.delay,
          delayed_message: text,
          message_entities: entities,
          updated_at: new Date().toISOString()
        });
        if (!error) {
          cache.del(`trigger_${ctx.session.chatId}_${ctx.session.triggerType}`);
          const emoji = ctx.session.triggerType === 'ورود' ? '🚪' : (ctx.session.triggerType === 'ماشین' ? '🚗' : '🏍️');
          await ctx.reply(`${emoji} تریگر #${ctx.session.triggerType} تنظیم شد!`);
        } else { await ctx.reply('❌ خطا در ذخیره تریگر'); }
      } catch { await ctx.reply('❌ خطا در ذخیره'); }
      finally { ctx.session.settingTrigger = false; }
    }
  } catch (e) { console.log('خطا در پردازش پیام:', e.message); }
});

// ---------- Webhook / Launch ----------
app.use(bot.webhookCallback('/webhook'));
app.get('/', (_req, res) => res.send(`<h3>🤖 تریگر ${SELF_BOT_ID}</h3><p>مالک: ${OWNER_ID}</p>`));

app.listen(PORT, async () => {
  console.log(`🚀 تریگر ${SELF_BOT_ID} روی پورت ${PORT}`);
  startAutoPing();
  try {
    if (process.env.RENDER_EXTERNAL_URL) {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook`;
      await bot.telegram.setWebhook(webhookUrl);
      console.log('✅ Webhook:', webhookUrl);
    } else {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      await bot.launch();
      console.log('✅ Long polling launched');
    }
  } catch (e) { console.log('⚠️ startup:', e.message); }
});

process.on('unhandledRejection', (err) => console.log('Unhandled:', (err && err.message) || err));
