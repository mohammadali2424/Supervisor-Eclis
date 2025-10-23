const { Telegraf, session, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');

// ==================[ تنظیمات اولیه ]==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;
const OWNER_ID = parseInt(process.env.OWNER_ID) || 0;
const API_SECRET_KEY = process.env.API_SECRET_KEY;
const BOT_INSTANCES = process.env.BOT_INSTANCES ? JSON.parse(process.env.BOT_INSTANCES) : [];
const SELF_BOT_ID = process.env.SELF_BOT_ID || 'trigger_1';
const SYNC_ENABLED = process.env.SYNC_ENABLED === 'true';

// کش فوق بهینه
const cache = new NodeCache({ 
  stdTTL: 1800,
  checkperiod: 600,
  maxKeys: 3000,
  useClones: false
});

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());
bot.use(session({
  defaultSession: () => ({
    settingTrigger: false,
    triggerType: null,
    step: null,
    delay: null,
    chatId: null
  })
}));

// ==================[ پینگ بهینه ]==================
const startAutoPing = () => {
  if (!process.env.RENDER_EXTERNAL_URL) return;
  const PING_INTERVAL = 14 * 60 * 1000;
  const selfUrl = process.env.RENDER_EXTERNAL_URL;

  const performPing = async () => {
    try {
      await axios.head(`${selfUrl}/ping`, { timeout: 5000 });
    } catch (error) {
      setTimeout(performPing, 2 * 60 * 1000);
    }
  };

  setTimeout(performPing, 45000);
  setInterval(performPing, PING_INTERVAL);
};

app.head('/ping', (req, res) => res.status(200).end());
app.get('/ping', (req, res) => {
  res.status(200).json({ status: 'active', botId: SELF_BOT_ID });
});

// ==================[ تابع آزادسازی - کاملاً بازنویسی شده ]==================
const releaseUserFromQuarantine = async (userId) => {
  try {
    if (!SYNC_ENABLED) {
      console.log(`🔕 سینک غیرفعال - آزادسازی کاربر ${userId} انجام نشد`);
      return false;
    }

    const cacheKey = `release:${userId}`;
    const cachedResult = cache.get(cacheKey);
    if (cachedResult !== undefined) {
      console.log(`✅ استفاده از کش برای آزادسازی کاربر ${userId}`);
      return cachedResult;
    }

    const quarantineBots = BOT_INSTANCES.filter(bot => bot.type === 'quarantine');
    if (quarantineBots.length === 0) {
      console.log('⚠️ هیچ ربات قرنطینه‌ای برای آزادسازی پیدا نشد');
      return false;
    }

    let successCount = 0;
    const promises = quarantineBots.map(async (botInstance) => {
      try {
        let apiUrl = botInstance.url;
        if (!apiUrl.startsWith('http')) apiUrl = `https://${apiUrl}`;
        
        // استفاده از داده فشرده برای کاهش Egress
        const response = await axios.post(`${apiUrl}/api/release-user`, {
          u: userId,
          s: botInstance.secretKey || API_SECRET_KEY,
          b: SELF_BOT_ID
        }, { 
          timeout: 8000,
          headers: { 'X-Compressed': 'true' }
        });

        if (response.data && response.data.s) {
          console.log(`✅ کاربر ${userId} از ربات ${botInstance.id} آزاد شد`);
          return true;
        }
        return false;
      } catch (error) {
        console.log(`❌ خطا در آزادسازی از ${botInstance.id}:`, error.message);
        return false;
      }
    });

    const results = await Promise.allSettled(promises);
    successCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;

    const finalResult = successCount > 0;
    cache.set(cacheKey, finalResult, 600);
    
    console.log(`🎯 آزادسازی کاربر ${userId}: ${successCount}/${quarantineBots.length} موفق`);
    return finalResult;
  } catch (error) {
    console.error('❌ خطای کلی در آزادسازی:', error);
    return false;
  }
};

// ==================[ تابع handleTrigger - اصلاح شده ]==================
const handleTrigger = async (ctx, triggerType) => {
  try {
    if (ctx.chat.type === 'private') return;

    const userName = ctx.from.first_name || 'ناشناس';
    const chatTitle = ctx.chat.title || 'گروه ناشناخته';
    const userId = ctx.from.id;
    
    if (triggerType === 'خروج') {
      const exitMessage = `🧭┊سفر به سلامت ${userName}`;
      await ctx.reply(exitMessage, { 
        reply_to_message_id: ctx.message.message_id,
        ...createGlassButton()
      });
      return;
    }
    
    const cacheKey = `trigger:${ctx.chat.id}:${triggerType}`;
    let triggerData = cache.get(cacheKey);
    
    if (!triggerData) {
      try {
        const { data, error } = await supabase
          .from('triggers')
          .select('delay, delayed_message, message_entities')
          .eq('chat_id', ctx.chat.id)
          .eq('trigger_type', triggerType)
          .single();

        if (error) throw error;

        if (data) {
          triggerData = data;
          cache.set(cacheKey, data, 1800);
        }
      } catch (error) {
        console.log(`⚠️ تریگر برای #${triggerType} پیدا نشد`);
      }
    }

    const delay = triggerData?.delay || 5;
    const delayedMessage = triggerData?.delayed_message || 'عملیات تکمیل شد! ✅';
    const messageEntities = triggerData?.message_entities;

    const formattedTime = formatTime(delay);
    const triggerEmoji = triggerType === 'ورود' ? '🎴' : triggerType === 'ماشین' ? '🚗' : '🏍️';
    
    let initialMessage;
    if (triggerType === 'ورود') {
      initialMessage = `${triggerEmoji}┊پلیر ${userName} وارد منطقه ${chatTitle} شدید\n\n⏳┊زمان سفر شما ${formattedTime}`;
    } else if (triggerType === 'ماشین') {
      initialMessage = `${triggerEmoji}┊ماشین ${userName} وارد گاراژ شد\n\n⏳┊زمان آماده سازی ${formattedTime}`;
    } else {
      initialMessage = `${triggerEmoji}┊موتور ${userName} وارد گاراژ شد\n\n⏳┊زمان آماده سازی ${formattedTime}`;
    }

    await ctx.reply(initialMessage, { 
      reply_to_message_id: ctx.message.message_id,
      ...createGlassButton()
    });

    console.log(`⏰ تریگر #${triggerType} برای کاربر ${userId} فعال شد - تأخیر: ${delay}ثانیه`);

    // تایمر اصلی - کاملاً اصلاح شده
    setTimeout(async () => {
      try {
        const messageOptions = {
          reply_to_message_id: ctx.message.message_id,
          ...createGlassButton(),
          disable_web_page_preview: true
        };
        
        if (messageEntities && messageEntities.length > 0) {
          messageOptions.entities = messageEntities;
        }
        
        await ctx.telegram.sendMessage(ctx.chat.id, delayedMessage, messageOptions);
        
        console.log(`🔓 درحال آزادسازی کاربر ${userId} از قرنطینه...`);
        
        // آزادسازی کاربر - اینجا مشکل اصلی حل شد
        const releaseResult = await releaseUserFromQuarantine(userId);
        
        if (releaseResult) {
          console.log(`✅ کاربر ${userId} با موفقیت از قرنطینه آزاد شد`);
        } else {
          console.log(`⚠️ کاربر ${userId} آزادسازی نشد - بررسی تنظیمات سینک`);
        }
        
      } catch (error) {
        console.error(`❌ خطا در ارسال پیام تأخیری:`, error.message);
      }
    }, delay * 1000);
  } catch (error) {
    console.error(`❌ خطا در پردازش #${triggerType}:`, error.message);
  }
};

// ==================[ توابع کمکی ]==================
const formatTime = (seconds) => {
  if (seconds < 60) return `${seconds} ثانیه`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes} دقیقه` : `${minutes} دقیقه و ${remainingSeconds} ثانیه`;
};

const createGlassButton = () => {
  return Markup.inlineKeyboard([
    Markup.button.callback('𝐄𝐜𝐥𝐢𝐬 𝐖𝐨𝐫𝐥𝐝', 'show_glass_message')
  ]);
};

const checkUserAccess = async (ctx) => {
  try {
    const userId = ctx.from.id;
    if (userId === OWNER_ID) return { hasAccess: true, isOwner: true };
    if (ctx.chat.type === 'private') return { hasAccess: false, reason: 'این دستور فقط در گروه کار می‌کند' };

    const adminCacheKey = `admin:${ctx.chat.id}:${userId}`;
    const cachedAdmin = cache.get(adminCacheKey);
    if (cachedAdmin !== undefined) {
      return cachedAdmin ? 
        { hasAccess: true, isAdmin: true } : 
        { hasAccess: false, reason: 'شما ادمین نیستید' };
    }

    const member = await ctx.getChatMember(userId);
    const isAdmin = ['creator', 'administrator'].includes(member.status);
    cache.set(adminCacheKey, isAdmin, 600);
    
    return isAdmin ? 
      { hasAccess: true, isAdmin: true, isCreator: member.status === 'creator' } : 
      { hasAccess: false, reason: 'شما ادمین نیستید' };
  } catch (error) {
    return { hasAccess: false, reason: 'خطا در بررسی دسترسی' };
  }
};

// ==================[ دستورات ربات ]==================
bot.start((ctx) => ctx.reply('اوپراتور اکلیس درخدمت شماست 🥷🏻'));

bot.command('help', (ctx) => {
  ctx.reply(`
🤖 راهنمای ربات اکلیس - نسخه مدیریتی
/start - شروع کار با ربات
/status - بررسی وضعیت ربات در گروه
/set_t1 - تنظیم تریگر برای #ورود
/set_t2 - تنظیم تریگر برای #ماشین  
/set_t3 - تنظیم تریگر برای #موتور
/off - غیرفعال کردن ربات در گروه
/help - نمایش این راهنما
#ورود - فعال کردن تریگر ورود
#ماشین - فعال کردن تریگر ماشین
#موتور - فعال کردن تریگر موتور
#خروج - خروج از منطقه
  `);
});

bot.command('status', async (ctx) => {
  try {
    const userAccess = await checkUserAccess(ctx);
    if (!userAccess.hasAccess) {
      ctx.reply(`❌ ${userAccess.reason}`);
      return;
    }

    const statusCacheKey = `status:${ctx.chat.id}`;
    const cachedStatus = cache.get(statusCacheKey);
    if (cachedStatus) {
      ctx.reply(cachedStatus);
      return;
    }

    let triggerInfo = '\n⚙️ تنظیمات تریگرها:';
    const chatTriggersCache = cache.get(`triggers:${ctx.chat.id}`);
    
    if (chatTriggersCache) {
      chatTriggersCache.forEach(trigger => {
        const emoji = trigger.trigger_type === 'ورود' ? '🚪' : 
                     trigger.trigger_type === 'ماشین' ? '🚗' : '🏍️';
        triggerInfo += `\n${emoji} #${trigger.trigger_type}: ${formatTime(trigger.delay)}`;
      });
    } else {
      try {
        const { data: triggers, error } = await supabase
          .from('triggers')
          .select('trigger_type, delay')
          .eq('chat_id', ctx.chat.id);

        if (!error && triggers && triggers.length > 0) {
          triggers.forEach(trigger => {
            const emoji = trigger.trigger_type === 'ورود' ? '🚪' : 
                         trigger.trigger_type === 'ماشین' ? '🚗' : '🏍️';
            triggerInfo += `\n${emoji} #${trigger.trigger_type}: ${formatTime(trigger.delay)}`;
          });
          cache.set(`triggers:${ctx.chat.id}`, triggers, 1800);
        } else {
          triggerInfo += '\n❌ هیچ تریگری تنظیم نشده است';
        }
      } catch (error) {
        triggerInfo += '\n❌ خطا در دریافت اطلاعات';
      }
    }

    const statusMessage = `🤖 وضعیت ربات در این گروه:${triggerInfo}\n🔗 وضعیت ارتباط با ربات‌های قرنطینه: ${SYNC_ENABLED ? 'فعال' : 'غیرفعال'}`;
    cache.set(statusCacheKey, statusMessage, 600);
    ctx.reply(statusMessage);
  } catch (error) {
    ctx.reply('❌ خطا در بررسی وضعیت');
  }
});

bot.command('off', async (ctx) => {
  try {
    const userAccess = await checkUserAccess(ctx);
    if (!userAccess.isOwner && !userAccess.isCreator) {
      ctx.reply('❌ فقط مالک ربات یا سازنده گروه می‌تواند ربات را غیرفعال کند.');
      return;
    }

    const chatId = ctx.chat.id;
    const { error: deleteError } = await supabase
      .from('triggers')
      .delete()
      .eq('chat_id', chatId);

    if (deleteError) throw deleteError;

    cache.del(`triggers:${chatId}`);
    cache.del(`trigger:${chatId}:ورود`);
    cache.del(`trigger:${chatId}:ماشین`);
    cache.del(`trigger:${chatId}:موتور`);
    cache.del(`status:${chatId}`);

    ctx.reply('✅ ربات با موفقیت غیرفعال شد و تمام تریگرهای این گروه حذف شدند.');
    
    try {
      await ctx.leaveChat();
    } catch (leaveError) {
      console.log('⚠️ خطا در خروج از گروه:', leaveError.message);
    }
  } catch (error) {
    ctx.reply('❌ خطایی در غیرفعال کردن ربات رخ داد.');
  }
});

// ==================[ تنظیم تریگر ]==================
const setupTrigger = async (ctx, triggerType) => {
  try {
    const userAccess = await checkUserAccess(ctx);
    if (!userAccess.hasAccess) {
      ctx.reply(`❌ ${userAccess.reason}`);
      return;
    }

    ctx.session.settingTrigger = true;
    ctx.session.triggerType = triggerType;
    ctx.session.step = 'delay';
    ctx.session.chatId = ctx.chat.id;

    const triggerEmoji = triggerType === 'ورود' ? '🚪' : triggerType === 'ماشین' ? '🚗' : '🏍️';
    await ctx.reply(`${triggerEmoji} تنظیم تریگر برای #${triggerType}\n\n⏰ لطفاً زمان تأخیر را به ثانیه وارد کنید:`);
  } catch (error) {
    ctx.reply('❌ خطایی در تنظیم تریگر رخ داد.');
  }
};

bot.command('set_t1', (ctx) => setupTrigger(ctx, 'ورود'));
bot.command('set_t2', (ctx) => setupTrigger(ctx, 'ماشین'));
bot.command('set_t3', (ctx) => setupTrigger(ctx, 'موتور'));

// ==================[ پردازش پیام‌ها ]==================
bot.on('text', async (ctx) => {
  try {
    const messageText = ctx.message.text;
    
    if (messageText.includes('#ورود')) await handleTrigger(ctx, 'ورود');
    if (messageText.includes('#ماشین')) await handleTrigger(ctx, 'ماشین');
    if (messageText.includes('#موتور')) await handleTrigger(ctx, 'موتور');
    if (messageText.includes('#خروج')) await handleTrigger(ctx, 'خروج');

    if (!ctx.session.settingTrigger) return;

    const userAccess = await checkUserAccess(ctx);
    if (!userAccess.hasAccess) {
      ctx.reply(`❌ ${userAccess.reason}`);
      ctx.session.settingTrigger = false;
      return;
    }

    if (ctx.session.step === 'delay') {
      const delay = parseInt(ctx.message.text);
      if (isNaN(delay) || delay <= 0 || delay > 3600) {
        ctx.reply('❌ لطفاً یک عدد معتبر بین 1 تا 3600 ��انیه وارد کنید');
        return;
      }

      ctx.session.delay = delay;
      ctx.session.step = 'message';
      const triggerEmoji = ctx.session.triggerType === 'ورود' ? '🚪' : 
                          ctx.session.triggerType === 'ماشین' ? '🚗' : '🏍️';
      await ctx.reply(`${triggerEmoji} زمان تأخیر ثبت شد: ${formatTime(delay)}\n\n📝 حالا پیام تأخیری را ارسال کنید:`);
    } else if (ctx.session.step === 'message') {
      try {
        const messageEntities = ctx.message.entities || [];
        
        const { error: deleteError } = await supabase
          .from('triggers')
          .delete()
          .eq('chat_id', ctx.session.chatId)
          .eq('trigger_type', ctx.session.triggerType);

        if (deleteError) throw deleteError;

        const { error: insertError } = await supabase.from('triggers').insert({
          chat_id: ctx.session.chatId,
          trigger_type: ctx.session.triggerType,
          delay: ctx.session.delay,
          delayed_message: ctx.message.text,
          message_entities: messageEntities,
          updated_at: new Date().toISOString(),
          set_by: ctx.from.id,
          set_by_username: ctx.from.username || ctx.from.first_name
        });

        if (insertError) throw insertError;

        cache.del(`trigger:${ctx.session.chatId}:${ctx.session.triggerType}`);
        cache.del(`triggers:${ctx.session.chatId}`);

        const triggerEmoji = ctx.session.triggerType === 'ورود' ? '🚪' : 
                            ctx.session.triggerType === 'ماشین' ? '🚗' : '🏍️';
        ctx.reply(`${triggerEmoji} تریگر #${ctx.session.triggerType} با موفقیت تنظیم شد!\n\n✅ تریگر قبلی جایگزین شد.`);
      } catch (error) {
        ctx.reply('❌ خطایی در ذخیره تنظیمات رخ داد.');
      }
      ctx.session.settingTrigger = false;
    }
  } catch (error) {
    console.error('❌ خطا در پردازش پیام:', error);
  }
});

// ==================[ endpointهای API ]==================
app.post('/api/check-quarantine', async (req, res) => {
  try {
    const { s: secretKey } = req.body;
    if (!secretKey || secretKey !== API_SECRET_KEY) {
      return res.status(401).json({ e: 'Unauthorized' });
    }
    res.status(200).json({ q: false, b: SELF_BOT_ID, n: 'این ربات تریگر است' });
  } catch (error) {
    res.status(500).json({ e: 'Internal server error' });
  }
});

app.post('/api/release-user', async (req, res) => {
  try {
    const { u: userId, s: secretKey } = req.body;
    if (!secretKey || secretKey !== API_SECRET_KEY) {
      return res.status(401).json({ e: 'Unauthorized' });
    }
    res.status(200).json({ s: true, b: SELF_BOT_ID });
  } catch (error) {
    res.status(500).json({ e: 'Internal server error' });
  }
});

app.post('/api/remove-user-from-all-chats', async (req, res) => {
  try {
    const { u: userId, s: secretKey } = req.body;
    if (!secretKey || secretKey !== API_SECRET_KEY) {
      return res.status(401).json({ e: 'Unauthorized' });
    }
    res.status(200).json({ s: true, r: 0, b: SELF_BOT_ID });
  } catch (error) {
    res.status(500).json({ e: 'Internal server error' });
  }
});

bot.action('show_glass_message', async (ctx) => {
  try {
    await ctx.answerCbQuery('به دنیای اکلیس خوش آمدید!', { show_alert: true });
  } catch (error) {
    await ctx.answerCbQuery('⚠️ خطایی رخ داد!', { show_alert: true });
  }
});

// ==================[ راه‌اندازی سرور ]==================
app.use(bot.webhookCallback('/webhook'));
app.get('/', (req, res) => {
  res.send(`🤖 ربات تلگرام ${SELF_BOT_ID} (تریگر) فعال - مالک: ${OWNER_ID}`);
});

app.listen(PORT, () => {
  console.log(`🚀 سرور تریگر ${SELF_BOT_ID} راه‌اندازی شد`);
  startAutoPing();
});

if (process.env.RENDER_EXTERNAL_URL) {
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook`;
  bot.telegram.setWebhook(webhookUrl)
    .then(() => console.log('✅ Webhook تنظیم شد'))
    .catch(error => {
      console.error('❌ خطا در تنظیم Webhook:', error);
      bot.launch();
    });
} else {
  bot.launch();
}

process.on('unhandledRejection', (error) => {
  console.error('❌ خطای catch نشده:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ خطای مدیریت نشده:', error);
});
