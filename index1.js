// ============ Trigger Bot (index1.js) ============
const { Telegraf, session, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');

// ---------- Env ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY; // ترجیحاً service_role
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

// برای جلوگیری از دوبل‌شدن jobها
const scheduledJobs = new Set(); // key: `${chatId}:${messageId}`

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

// entities → HTML + extra
const createFormattedMessage = (text, entities = []) => {
  if (!text) text = ' ';
  if (!entities || entities.length === 0) {
    return { html: text, extra: { parse_mode: undefined, disable_web_page_preview: true } };
  }
  let t = text;
  const sorted = [...entities].sort((a, b) => b.offset - a.offset);
  sorted.forEach((e) => {
    const start = e.offset, end = e.offset + e.length;
    if (start < 0 || end > t.length) return;
    const chunk = t.substring(start, end);
    let w = chunk;
    switch (e.type) {
      case 'bold': w = `<b>${chunk}</b>`; break;
      case 'italic': w = `<i>${chunk}</i>`; break;
      case 'underline': w = `<u>${chunk}</u>`; break;
      case 'strikethrough': w = `<s>${chunk}</s>`; break;
      case 'code': w = `<code>${chunk}</code>`; break;
      case 'pre': w = `<pre>${chunk}</pre>`; break;
      case 'text_link': w = `<a href="${e.url}">${chunk}</a>`; break;
      case 'text_mention': w = e.user?.id ? `<a href="tg://user?id=${e.user.id}">${chunk}</a>` : chunk; break;
      default: w = chunk;
    }
    t = t.substring(0, start) + w + t.substring(end);
  });
  return { html: t, extra: { parse_mode: 'HTML', disable_web_page_preview: true } };
};

// دریافت تنظیمات تریگر از Supabase با کش
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

// بررسی عضویت ربات در گروه قبل از ارسال
const isBotStillMember = async (chatId) => {
  try {
    const me = await bot.telegram.getMe();
    const st = await bot.telegram.getChatMember(chatId, me.id);
    return ['administrator', 'creator', 'member'].includes(st.status);
  } catch {
    return false;
  }
};

// ارسال با رتریِ فقط برای خطاهای موقتی
const shouldRetry = (err) => {
  const desc = (err && err.response && err.response.description) || err.message || '';
  if (/^403:/.test(desc) || /chat not found/i.test(desc) || /bad request/i.test(desc)) return false; // غیرموقتی
  if (/^400:/.test(desc)) return false;
  // موقتی‌ها:
  return /429|timeout|ETIMEOUT|ECONNRESET|EAI_AGAIN|5\d{2}/i.test(desc);
};

const sendWithSmartRetry = async ({ chatId, replyToMessageId, html, extra }) => {
  const attempts = [0, 1000, 3000]; // حداکثر 3 تلاش
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, attempts[i]));
    try {
      await bot.telegram.sendMessage(chatId, html, { reply_to_message_id: replyToMessageId, ...createGlassButton(), ...extra });
      return true;
    } catch (e) {
      lastErr = e;
      if (!shouldRetry(e)) break;
    }
  }
  console.log('❌ ارسال پیام تاخیری شکست خورد:', (lastErr && lastErr.message) || lastErr);
  return false;
};

// آزادسازی کاربر از قرنطینه (اختیاری)
const releaseUserFromQuarantine = async (userId) => {
  if (!QUARANTINE_BOT_URL || !API_SECRET_KEY) return true;
  let apiUrl = QUARANTINE_BOT_URL.startsWith('http') ? QUARANTINE_BOT_URL : `https://${QUARANTINE_BOT_URL}`;
  apiUrl = apiUrl.replace(/\/+$/, '');
  const apiEndpoint = `${apiUrl}/api/release-user`;
  const body = { userId: parseInt(userId, 10), secretKey: API_SECRET_KEY, sourceBot: SELF_BOT_ID };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await axios.post(apiEndpoint, body, { timeout: 8000, headers: { 'Content-Type': 'application/json' }});
      if (resp.data?.success) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 1200));
  }
  return false;
};

// ---------- Ownership-safe joins ----------
bot.on('my_chat_member', async (ctx) => {
  try {
    const newStatus = ctx.update.my_chat_member?.new_chat_member?.status;
    const adderId = ctx.update.my_chat_member?.from?.id;
    const chatId = ctx.chat?.id;

    if (newStatus && ['member', 'administrator'].includes(newStatus)) {
      if (adderId !== OWNER_ID) {
        try {
          await bot.telegram.sendMessage(chatId,
            'این ربات متعلق به مجموعه اکلیس است ، شما حق استفاده از آنها رو ندارین ، حدتو بدون');
        } catch {}
        try { await bot.telegram.leaveChat(chatId); } catch {}
      }
    }
  } catch (e) { console.log('my_chat_member error:', e.message); }
});

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
#ورود #ماشین #موتور (تاخیری) | #خروج (پیام فوری)`
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
const handleTrigger = async (ctx, triggerType) => {
  try {
    if (ctx.chat.type === 'private') return;

    const userName = ctx.from.first_name || 'کاربر';
    const userId = ctx.from.id;

    const row = await getTriggerRow(ctx.chat.id, triggerType);
    const delay = Math.max(1, Math.min(3600, row?.delay ?? 5)); // 1..3600
    const delayedMessage = row?.delayed_message ?? 'عملیات تکمیل شد! ✅';
    const messageEntities = row?.message_entities ?? [];

    const emoji = triggerType === 'ورود' ? '🎴' : (triggerType === 'ماشین' ? '🚗' : '🏍️');
    const initial = `${emoji}┊${userName} وارد منطقه شد\n\n⏳┊زمان: ${formatTime(delay)}`;
    await ctx.reply(initial, { reply_to_message_id: ctx.message.message_id, ...createGlassButton() });

    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const jobKey = `${chatId}:${messageId}`;

    // جلوگیری از دوبل‌شدن job
    if (scheduledJobs.has(jobKey)) return;
    scheduledJobs.add(jobKey);

    // زمان‌بندی غیرمسدودکننده
    setTimeout(async () => {
      try {
        // اگر ربات دیگر عضو گروه نیست، ارسال را لغو کن
        const stillMember = await isBotStillMember(chatId);
        if (!stillMember) return;

        // آماده‌سازی متن
        const fmt = createFormattedMessage(delayedMessage, messageEntities);

        // ارسال با رتری موقتی
        const ok = await sendWithSmartRetry({
          chatId,
          replyToMessageId: messageId,
          html: fmt.html,
          extra: fmt.extra
        });

        if (ok) {
          // آزادسازی از قرنطینه (اگر لینک شده)
          await releaseUserFromQuarantine(userId);
        }
      } catch (e) {
        console.log('❌ ارسال پیام تاخیری/آزادسازی:', e.message);
      } finally {
        scheduledJobs.delete(jobKey);
      }
    }, delay * 1000);

  } catch (e) {
    console.log('❌ پردازش تریگر:', e.message);
  }
};

// #خروج: فقط پیام فوری
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

    // خروج فوری
    if (text.includes('#خروج')) {
      await handleFarewell(ctx);
      return;
    }

    // تریگرهای تاخیری
    if (text.includes('#ورود')) await handleTrigger(ctx, 'ورود');
    if (text.includes('#ماشین')) await handleTrigger(ctx, 'ماشین');
    if (text.includes('#موتور')) await handleTrigger(ctx, 'موتور');

    // Wizard تنظیم تریگر
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
