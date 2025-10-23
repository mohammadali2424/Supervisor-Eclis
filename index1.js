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
const OWNER_ID = process.env.OWNER_ID;
const API_SECRET_KEY = process.env.API_SECRET_KEY;
const BOT_INSTANCES = process.env.BOT_INSTANCES ? JSON.parse(process.env.BOT_INSTANCES) : [];
const SELF_BOT_ID = process.env.SELF_BOT_ID || 'trigger_1';
const SYNC_ENABLED = process.env.SYNC_ENABLED === 'true';

// کش پیشرفته برای تریگرها
const cache = new NodeCache({ 
  stdTTL: 600,        // 10 دقیقه
  checkperiod: 120,
  maxKeys: 10000
});

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());

// سشن برای تنظیم تریگر
bot.use(session({
  defaultSession: () => ({
    settingTrigger: false,
    triggerType: null,
    step: null,
    delay: null,
    chatId: null
  })
}));

// ==================[ پینگ خودکار ]==================
const startAutoPing = () => {
  if (!process.env.RENDER_EXTERNAL_URL) return;

  const PING_INTERVAL = 13 * 60 * 1000 + 59 * 1000;
  const selfUrl = process.env.RENDER_EXTERNAL_URL;

  const performPing = async () => {
    try {
      await axios.get(`${selfUrl}/ping`, { timeout: 10000 });
    } catch (error) {
      setTimeout(performPing, 2 * 60 * 1000);
    }
  };

  setTimeout(performPing, 30000);
  setInterval(performPing, PING_INTERVAL);
};

app.get('/ping', (req, res) => {
  res.status(200).json({
    status: 'active',
    botId: SELF_BOT_ID,
    timestamp: new Date().toISOString()
  });
});

// ==================[ توابع بهینه‌شده با کش ]==================
const formatTime = (seconds) => {
  if (seconds < 60) return `${seconds} ثانیه`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes} دقیقه` : `${minutes} دقیقه و ${remainingSeconds} ثانیه`;
};

const checkUserAccess = async (ctx) => {
  try {
    if (ctx.from.id.toString() === OWNER_ID) return { hasAccess: true, isOwner: true };
    if (ctx.chat.type === 'private') return { hasAccess: false, reason: 'این دستور فقط در گروه کار می‌کند' };

    const member = await ctx.getChatMember(ctx.from.id);
    if (member.status === 'creator') return { hasAccess: true, isCreator: true };
    if (member.status === 'administrator') return { hasAccess: true, isAdmin: true };

    return { hasAccess: false, reason: 'شما ادمین نیستید' };
  } catch (error) {
    return { hasAccess: false, reason: 'خطا در بررسی دسترسی' };
  }
};

// ==================[ توابع آزادسازی - با کش ]==================
const releaseUserFromQuarantine = async (userId) => {
  try {
    if (!SYNC_ENABLED) {
      return false;
    }

    // کش برای نتایج آزادسازی
    const cacheKey = `release:${userId}`;
    const cachedResult = cache.get(cacheKey);
    if (cachedResult !== undefined) {
      console.log(`✅ استفاده از کش برای آزادسازی کاربر ${userId}`);
      return cachedResult;
    }

    const quarantineBots = BOT_INSTANCES.filter(bot => bot.type === 'quarantine');
    let successCount = 0;

    // غیرهمزمان اجرا کن تا Egress کمتری مصرف شه
    const promises = quarantineBots.map(async (botInstance) => {
      try {
        let apiUrl = botInstance.url;
        if (!apiUrl.startsWith('http')) apiUrl = `https://${apiUrl}`;
        
        await axios.post(`${apiUrl}/api/release-user`, {
          userId: userId,
          secretKey: botInstance.secretKey || API_SECRET_KEY,
          sourceBot: SELF_BOT_ID
        }, { timeout: 5000 });
        
        return true;
      } catch (error) {
        return false;
      }
    });

    const results = await Promise.allSettled(promises);
    successCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;

    const finalResult = successCount > 0;
    // نتیجه رو در کش ذخیره کن (2 دقیقه)
    cache.set(cacheKey, finalResult, 120);
    
    return finalResult;
  } catch (error) {
    return false;
  }
};

// ==================[ تابع handleTrigger - با کش ]==================
const handleTrigger = async (ctx, triggerType) => {
  try {
    if (ctx.chat.type === 'private') return;

    const userName = ctx.from.first_name || 'ناشناس';
    const chatTitle = ctx.chat.title || 'گروه ناشناخته';
    
    if (triggerType === 'خروج') {
      const exitMessage = `🧭┊سفر به سلامت ${userName}`;
      await ctx.reply(exitMessage, { 
        reply_to_message_id: ctx.message.message_id,
        ...createGlassButton()
      });
      return;
    }
    
    // 🔍 اول از کش تریگرها رو بگیر
    const cacheKey = `trigger:${ctx.chat.id}:${triggerType}`;
    let triggerData = cache.get(cacheKey);
    
    if (!triggerData) {
      // اگر در کش نبود، از دیتابیس بگیر
      try {
        const { data } = await supabase
          .from('triggers')
          .select('delay, delayed_message, message_entities')
          .eq('chat_id', ctx.chat.id)
          .eq('trigger_type', triggerType)
          .single();

        if (data) {
          triggerData = data;
          cache.set(cacheKey, data, 600); // 10 دقیقه
        }
      } catch (error) {
        // خطا رو لاگ نکن تا Egress کمتری مصرف بشه
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
        
        // آزادسازی کاربر از قرنطینه
        await releaseUserFromQuarantine(ctx.from.id);
        
      } catch (error) {
        // خطا رو لاگ نکن
      }
    }, delay * 1000);
  } catch (error) {
    // خطای اصلی رو لاگ کن
    console.error(`❌ خطا در پردازش #${triggerType}:`, error);
  }
};

// ==================[ دکمه شیشه‌ای ]==================
const createGlassButton = () => {
  return Markup.inlineKeyboard([
    Markup.button.callback('𝐄𝐜𝐥𝐢𝐬 𝐖𝐨𝐫𝐥𝐝', 'show_glass_message')
  ]);
};

bot.action('show_glass_message', async (ctx) => {
  try {
    const messageText = ctx.update.callback_query.message.text;
    let alertMessage = 'به دنیای اکلیس خوش آمدید!';
    
    if (messageText.includes('ورود') || messageText.includes('ماشین') || messageText.includes('موتور')) {
      alertMessage = messageText.includes('زمان سفر') || messageText.includes('زمان آماده سازی') 
        ? 'مدت زمان شما تا دریافت بقیه مسیر ها' 
        : 'مسیر های شما برای رفتن به مکان بعدی';
    } else if (messageText.includes('خروج') || messageText.includes('سفر به سلامت')) {
      alertMessage = 'به مسیر هایی که انتخاب میکنین ، دقت کنین ، شاید خطری شمارا تهدید کند...';
    }
    
    await ctx.answerCbQuery(alertMessage, { show_alert: true });
  } catch (error) {
    await ctx.answerCbQuery('⚠️ خطایی رخ داد!', { show_alert: true });
  }
});

// ==================[ دستورات ربات ]==================
bot.start((ctx) => {
  ctx.reply('اوپراتور اکلیس درخدمت شماست 🥷🏻');
});

bot.command('help', (ctx) => {
  ctx.reply(`
🤖 راهنمای ربات اکلیس - نسخه مدیریتی

/start - شروع کار با ربات
/status - بررسی وضعیت ربات در گروه
/set_t1 - تنظیم تریگر برای #ورود
/set_t2 - تنظیم تریگر برای #ماشین  
/set_t3 - تنظیم تریگر برای #موتور
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

    let triggerInfo = '\n⚙️ تنظیمات تریگرها:';
    
    // از کش تریگرها رو بگیر
    const chatTriggersCache = cache.get(`triggers:${ctx.chat.id}`);
    if (chatTriggersCache) {
      chatTriggersCache.forEach(trigger => {
        const emoji = trigger.trigger_type === 'ورود' ? '🚪' : 
                     trigger.trigger_type === 'ماشین' ? '🚗' : '🏍️';
        triggerInfo += `\n${emoji} #${trigger.trigger_type}: ${formatTime(trigger.delay)}`;
      });
    } else {
      // اگر در کش نبود، از دیتابیس بگیر
      try {
        const { data: triggers } = await supabase
          .from('triggers')
          .select('trigger_type, delay')
          .eq('chat_id', ctx.chat.id);

        if (triggers && triggers.length > 0) {
          triggers.forEach(trigger => {
            const emoji = trigger.trigger_type === 'ورود' ? '🚪' : 
                         trigger.trigger_type === 'ماشین' ? '🚗' : '🏍️';
            triggerInfo += `\n${emoji} #${trigger.trigger_type}: ${formatTime(trigger.delay)}`;
          });
          // در کش ذخیره کن
          cache.set(`triggers:${ctx.chat.id}`, triggers, 600);
        } else {
          triggerInfo += '\n❌ هیچ تریگری تنظیم نشده است';
        }
      } catch (error) {
        triggerInfo += '\n❌ خطا در دریافت اطلاعات';
      }
    }

    ctx.reply(`
🤖 وضعیت ربات در این گروه:
${triggerInfo}

🔗 وضعیت ارتباط با ربات‌های قرنطینه: ${SYNC_ENABLED ? 'فعال' : 'غیرفعال'}
    `);
  } catch (error) {
    ctx.reply('❌ خطا در بررسی وضعیت');
  }
});

// ==================[ دستورات تنظیم تریگر ]==================
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
    
    if (messageText.includes('#ورود')) {
      await handleTrigger(ctx, 'ورود');
    }
    if (messageText.includes('#ماشین')) {
      await handleTrigger(ctx, 'ماشین');
    }
    if (messageText.includes('#موتور')) {
      await handleTrigger(ctx, 'موتور');
    }
    if (messageText.includes('#خروج')) {
      await handleTrigger(ctx, 'خروج');
    }

    // پردازش تنظیمات تریگر
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
        ctx.reply('❌ لطفاً یک عدد معتبر بین 1 تا 3600 ثانیه وارد کنید');
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
        
        await supabase
          .from('triggers')
          .delete()
          .eq('chat_id', ctx.session.chatId)
          .eq('trigger_type', ctx.session.triggerType);

        await supabase.from('triggers').insert({
          chat_id: ctx.session.chatId,
          trigger_type: ctx.session.triggerType,
          delay: ctx.session.delay,
          delayed_message: ctx.message.text,
          message_entities: messageEntities,
          updated_at: new Date().toISOString(),
          set_by: ctx.from.id,
          set_by_username: ctx.from.username || ctx.from.first_name
        });

        // کش رو پاک کن
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
    console.error('خطا در پردازش پیام:', error);
  }
});

// ==================[ endpointهای API برای ارتباط با ربات‌های قرنطینه ]==================
app.post('/api/check-quarantine', async (req, res) => {
  try {
    const { secretKey } = req.body;
    
    if (!secretKey || secretKey !== API_SECRET_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // ربات تریگر کاربر رو قرنطینه نمی‌کنه
    res.status(200).json({ 
      isQuarantined: false,
      botId: SELF_BOT_ID,
      note: 'این ربات تریگر است و کاربران را قرنطینه نمی‌کند'
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/sync-user', async (req, res) => {
  try {
    const { secretKey } = req.body;
    
    if (!secretKey || secretKey !== API_SECRET_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // فقط تأیید کن که درخواست دریافت شده
    res.status(200).json({ 
      success: true,
      botId: SELF_BOT_ID,
      message: 'درخواست دریافت شد'
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/release-user', async (req, res) => {
  try {
    const { userId, secretKey } = req.body;
    
    if (!secretKey || secretKey !== API_SECRET_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    res.status(200).json({ 
      success: true,
      botId: SELF_BOT_ID,
      message: `درخواست آزادسازی کاربر ${userId} دریافت شد`
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================[ راه‌اندازی سرور ]==================
app.use(bot.webhookCallback('/webhook'));
app.get('/', (req, res) => {
  res.send(`🤖 ربات تلگرام ${SELF_BOT_ID} (تریگر) در حال اجراست!`);
});

app.listen(PORT, () => {
  console.log(`🚀 سرور تریگر ${SELF_BOT_ID} راه‌اندازی شد`);
  startAutoPing();
});

// راه‌اندازی ربات
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
