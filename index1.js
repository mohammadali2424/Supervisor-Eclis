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
const OWNER_ID = process.env.OWNER_ID || '123456789';
const QUARANTINE_BOT_URL = process.env.QUARANTINE_BOT_URL;
const API_SECRET_KEY = process.env.API_SECRET_KEY;

// ==================[ تنظیمات چندرباتی ]==================
const BOT_INSTANCES = process.env.BOT_INSTANCES ? 
  JSON.parse(process.env.BOT_INSTANCES) : [];
  
const SELF_BOT_ID = process.env.SELF_BOT_ID || 'trigger_1';
const SYNC_ENABLED = process.env.SYNC_ENABLED === 'true';

// کش برای ذخیره وضعیت
const cache = new NodeCache({ stdTTL: 300, checkperiod: 600 });

// ==================[ مکانیزم قطع مدار ]==================
const circuitBreaker = {
  state: 'CLOSED',
  failureCount: 0,
  failureThreshold: 5,
  timeout: 30000,
  nextAttempt: Date.now()
};

const checkCircuitBreaker = () => {
  if (circuitBreaker.state === 'OPEN') {
    if (Date.now() < circuitBreaker.nextAttempt) {
      console.log('🔴 Circuit Breaker is OPEN, rejecting request');
      return false;
    } else {
      circuitBreaker.state = 'HALF_OPEN';
      circuitBreaker.failureCount = 0;
    }
  }
  return true;
};

const recordSuccess = () => {
  circuitBreaker.state = 'CLOSED';
  circuitBreaker.failureCount = 0;
};

const recordFailure = () => {
  circuitBreaker.failureCount++;
  if (circuitBreaker.failureCount >= circuitBreaker.failureThreshold) {
    circuitBreaker.state = 'OPEN';
    circuitBreaker.nextAttempt = Date.now() + circuitBreaker.timeout;
    console.log('🔴 Circuit Breaker triggered to OPEN state');
  }
};

// بررسی متغیرهای محیطی ضروری
if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ لطفاً مطمئن شوید همه متغیرهای محیطی تنظیم شده‌اند');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new Telegraf(BOT_TOKEN);
const app = express();

// میدلورهای اصلی
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

// ==================[ پینگ خودکار برای جلوگیری از خوابیدن ]==================
const startAutoPing = () => {
  if (!process.env.RENDER_EXTERNAL_URL) {
    console.log('🚫 پینگ خودکار غیرفعال (محلی)');
    return;
  }

  const PING_INTERVAL = 13 * 60 * 1000 + 59 * 1000; // هر 13 دقیقه و 59 ثانیه
  const selfUrl = process.env.RENDER_EXTERNAL_URL;

  console.log('🔁 راه‌اندازی پینگ خودکار هر 13:59 دقیقه...');

  const performPing = async () => {
    try {
      console.log('🏓 ارسال پینگ خودکار برای جلوگیری از خوابیدن...');
      const startTime = Date.now();
      const response = await axios.get(`${selfUrl}/ping`, { 
        timeout: 10000 
      });
      const endTime = Date.now();
      console.log(`✅ پینگ موفق (${endTime - startTime}ms) - ربات فعال می‌ماند`);
    } catch (error) {
      console.error('❌ پینگ ناموفق:', error.message);
      setTimeout(performPing, 2 * 60 * 1000);
    }
  };

  setTimeout(performPing, 30000);
  setInterval(performPing, PING_INTERVAL);
};

// endpoint پینگ
app.get('/ping', (req, res) => {
  console.log('🏓 دریافت پینگ - ربات فعال است');
  res.status(200).json({
    status: 'active',
    botId: SELF_BOT_ID,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + ' ثانیه',
    message: 'ربات فعال و بیدار است 🚀'
  });
});

// توابع کمکی
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
    console.error('خطا در بررسی دسترسی:', error);
    return { hasAccess: false, reason: 'خطا در بررسی دسترسی' };
  }
};

// ==================[ توابع آزادسازی ]==================
const releaseUserFromQuarantine = async (userId) => {
  if (!checkCircuitBreaker()) {
    throw new Error('Circuit Breaker is OPEN');
  }

  try {
    if (!SYNC_ENABLED) {
      console.log('⚠️  حالت هماهنگی غیرفعال است');
      return await releaseUserSingleInstance(userId);
    }

    console.log(`🔄 در حال آزاد کردن کاربر ${userId} از تمام ربات‌ها...`);
    
    const results = [];
    
    for (const botInstance of BOT_INSTANCES) {
      if (botInstance.type === 'quarantine') {
        try {
          let apiUrl = botInstance.url;
          if (!apiUrl.startsWith('http')) apiUrl = `https://${apiUrl}`;
          apiUrl = apiUrl.replace(/\/$/, '');
          
          const response = await axios.post(`${apiUrl}/api/release-user`, {
            userId: userId,
            secretKey: botInstance.secretKey,
            sourceBot: SELF_BOT_ID
          }, { timeout: 5000 });
          
          results.push({ success: true, botId: botInstance.id });
        } catch (error) {
          console.error(`❌ خطا در ارتباط با ${botInstance.id}:`, error.message);
          results.push({ success: false, botId: botInstance.id });
        }
      }
    }
    
    if (QUARANTINE_BOT_URL && API_SECRET_KEY) {
      const currentResult = await releaseUserSingleInstance(userId);
      results.push({ success: currentResult });
    }
    
    const successCount = results.filter(r => r.success).length;
    console.log(`✅ کاربر ${userId} از ${successCount}/${results.length} ربات آزاد شد`);
    
    recordSuccess();
    return successCount > 0;
  } catch (error) {
    recordFailure();
    console.error('❌ خطا در آزادسازی چندرباتی:', error);
    return await releaseUserSingleInstance(userId);
  }
};

const releaseUserSingleInstance = async (userId) => {
  try {
    if (!QUARANTINE_BOT_URL || !API_SECRET_KEY) {
      console.error('❌ متغیرهای ارتباطی تنظیم نشده‌اند');
      return false;
    }

    let apiUrl = QUARANTINE_BOT_URL;
    if (!apiUrl.startsWith('http')) apiUrl = `https://${apiUrl}`;
    apiUrl = apiUrl.replace(/\/$/, '');
    
    const response = await axios.post(`${apiUrl}/api/release-user`, {
      userId: userId,
      secretKey: API_SECRET_KEY,
      sourceBot: SELF_BOT_ID
    }, { timeout: 8000 });

    return response.data.success;
  } catch (error) {
    console.error('❌ خطا در آزاد کردن کاربر از قرنطینه:', error.message);
    return false;
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
    console.error('❌ خطا در پردازش دکمه شیشه‌ای:', error);
    ctx.answerCbQuery('⚠️ خطایی رخ داد!', { show_alert: true });
  }
});

// ==================[ تابع handleTrigger ]==================
const handleTrigger = async (ctx, triggerType) => {
  if (!checkCircuitBreaker()) {
    try {
      await ctx.reply('⏳ سیستم در حال حاضر شلوغ است. لطفاً چند لحظه دیگر تلاش کنید.');
    } catch (e) {
      console.error('خطا در ارسال پیام شلوغی:', e);
    }
    return;
  }

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
    
    let delay = 5;
    let delayedMessage = 'عملیات تکمیل شد! ✅';
    let messageEntities = null;

    const cacheKey = `trigger:${ctx.chat.id}:${triggerType}`;
    let triggerData = cache.get(cacheKey);
    
    if (!triggerData) {
      try {
        const { data } = await supabase
          .from('triggers')
          .select('*')
          .eq('chat_id', ctx.chat.id)
          .eq('trigger_type', triggerType)
          .single();

        if (data) {
          triggerData = data;
          cache.set(cacheKey, data, 300);
        }
      } catch (error) {
        console.error('خطا در دریافت تریگر:', error);
      }
    }

    if (triggerData) {
      delay = triggerData.delay;
      delayedMessage = triggerData.delayed_message;
      messageEntities = triggerData.message_entities;
    }

    const formattedTime = formatTime(delay);
    const triggerEmoji = triggerType === 'ورود' ? '🎴' : triggerType === 'ماشین' ? '🚗' : '��️';
    
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
        
        console.log(`🔄 در حال آزاد کردن کاربر ${ctx.from.id} از قرنطینه...`);
        const releaseSuccess = await releaseUserFromQuarantine(ctx.from.id);
        
        if (releaseSuccess) {
          console.log(`✅ کاربر ${ctx.from.id} با موفقیت از قرنطینه خارج شد`);
        } else {
          console.log(`❌ آزاد کردن کاربر ${ctx.from.id} از قرنطینه ناموفق بود`);
        }
        
        recordSuccess();
      } catch (error) {
        recordFailure();
        console.error('❌ خطا در ارسال پیام تأخیری:', error);
      }
    }, delay * 1000);
  } catch (error) {
    recordFailure();
    console.error(`❌ خطا در پردازش #${triggerType}:`, error);
  }
};

// ==================[ دستورات ربات ]==================
bot.start((ctx) => {
  console.log(`🚀 دستور start توسط کاربر ${ctx.from.id} فراخوانی شد`);
  ctx.reply('اوپراتور اکلیس درخدمت شماست 🥷🏻');
});

bot.command('help', (ctx) => {
  console.log(`📖 دستور help توسط کاربر ${ctx.from.id} فراخوانی شد`);
  ctx.reply(`
🤖 راهنمای ربات اکلیس - نسخه مدیریتی

/start - شروع کار با ربات
/status - بررسی وضعیت ربات در گروه
/set_t1 - تنظیم تریگر برای #ورود
/set_t2 - تنظیم تریگر برای #ماشین  
/set_t3 - تنظی�� تریگر برای #موتور
/help - نمایش این راهنما

#ورود - فعال کردن تریگر ورود
#ماشین - فعال کردن تریگر ماشین
#موتور - فعال کردن تریگر موتور
#خروج - خروج از منطقه
  `);
});

bot.command('status', async (ctx) => {
  console.log(`📊 دستور status توسط کاربر ${ctx.from.id} فراخوانی شد`);
  try {
    const userAccess = await checkUserAccess(ctx);
    if (!userAccess.hasAccess) {
      ctx.reply(`❌ ${userAccess.reason}`);
      return;
    }

    let triggerInfo = '\n⚙️ تنظیمات تریگرها:';
    try {
      const { data: triggers } = await supabase
        .from('triggers')
        .select('*')
        .eq('chat_id', ctx.chat.id);

      if (triggers && triggers.length > 0) {
        triggers.forEach(trigger => {
          const emoji = trigger.trigger_type === 'ورود' ? '🚪' : 
                       trigger.trigger_type === 'ماشین' ? '🚗' : '🏍️';
          triggerInfo += `\n${emoji} #${trigger.trigger_type}: ${formatTime(trigger.delay)}`;
        });
      } else {
        triggerInfo += '\n❌ هیچ تریگری تنظیم نشده است';
      }
    } catch (error) {
      triggerInfo += '\n❌ خطا در دریافت اطلاعات';
    }

    ctx.reply(`
🤖 وضعیت ربات در این گروه:
${triggerInfo}

👤 دسترسی شما: ${userAccess.isOwner ? 'مالک' : userAccess.isCreator ? 'سازنده گروه' : userAccess.isAdmin ? 'ادمین' : 'عضو'}
    `);
  } catch (error) {
    console.error('خطا در دستور status:', error);
    ctx.reply('❌ خطا در بررسی وضعیت');
  }
});

// دستورات تنظیم تریگر
const setupTrigger = async (ctx, triggerType) => {
  console.log(`⚙️ دستور set_t برای ${triggerType} توسط کاربر ${ctx.from.id} فراخوانی شد`);
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
    await ctx.reply(`${triggerEmoji} تنظیم تریگر برای #${triggerType}\n\n⏰ لطفاً زمان تأخیر را به ثانیه وارد کنید:\nمثال: 60 (برای 1 دقیقه)`);
  } catch (error) {
    console.error('خطا در دستور set_t:', error);
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
    console.log(`📨 دریافت پیام: ${messageText} از کاربر ${ctx.from.id}`);
    
    if (messageText.includes('#ورود')) {
      console.log(`🎴 پردازش تریگر ورود توسط کاربر ${ctx.from.id}`);
      await handleTrigger(ctx, 'ورود');
    }
    if (messageText.includes('#ماشین')) {
      console.log(`🚗 پردازش تریگر ماشین توسط کاربر ${ctx.from.id}`);
      await handleTrigger(ctx, 'ماشین');
    }
    if (messageText.includes('#موتور')) {
      console.log(`🏍️ پردازش تریگر موتور توسط کاربر ${ctx.from.id}`);
      await handleTrigger(ctx, 'موتور');
    }
    if (messageText.includes('#خروج')) {
      console.log(`🧭 پردازش تریگر خروج توسط کاربر ${ctx.from.id}`);
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

        const cacheKey = `trigger:${ctx.session.chatId}:${ctx.session.triggerType}`;
        cache.del(cacheKey);

        const triggerEmoji = ctx.session.triggerType === 'ورود' ? '🚪' : 
                            ctx.session.triggerType === 'ماشین' ? '🚗' : '🏍️';
        
        ctx.reply(`${triggerEmoji} تریگر #${ctx.session.triggerType} با موفقیت تنظیم شد!\n\n✅ تریگر قبلی جایگزین شد.`);
      } catch (error) {
        console.error('❌ خطای دیتابیس:', error);
        ctx.reply('❌ خطایی در ذخیره تنظیمات رخ داد.');
      }

      ctx.session.settingTrigger = false;
      ctx.session.step = null;
      ctx.session.delay = null;
      ctx.session.triggerType = null;
      ctx.session.chatId = null;
    }
  } catch (error) {
    console.error('خطا در پردازش پیام:', error);
  }
});

// ==================[ endpointهای API ]==================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    botId: SELF_BOT_ID,
    timestamp: new Date().toISOString(),
    port: PORT
  });
});

app.get('/api/bot-status', (req, res) => {
  res.status(200).json({
    status: 'online',
    botId: SELF_BOT_ID,
    type: 'trigger',
    timestamp: new Date().toISOString(),
    connectedBots: BOT_INSTANCES.length
  });
});

app.post('/api/sync-release', async (req, res) => {
  try {
    const { userId, secretKey, sourceBot } = req.body;
    
    if (!secretKey || secretKey !== API_SECRET_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    console.log(`🔄 درخواست هماهنگی از ${sourceBot} برای کاربر ${userId}`);
    
    res.status(200).json({
      success: true,
      botId: SELF_BOT_ID,
      processed: true,
      message: `درخواست هماهنگی از ${sourceBot} پردازش شد`
    });
  } catch (error) {
    console.error('❌ خطا در پردازش هماهنگی:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================[ راه‌اندازی سرور ]==================
app.use(bot.webhookCallback('/webhook'));
app.get('/', (req, res) => {
  res.send(`🤖 ربات تلگرام ${SELF_BOT_ID} در حال اجراست!`);
});

app.listen(PORT, () => {
  console.log(`🚀 سرور تریگر ${SELF_BOT_ID} در پورت ${PORT} راه‌اندازی شد`);
  console.log(`🤖 شناسه ربات: ${SELF_BOT_ID}`);
  console.log(`🔗 حالت هماهنگی: ${SYNC_ENABLED ? 'فعال' : 'غیرفعال'}`);
  console.log(`👥 تعداد ربات‌های متصل: ${BOT_INSTANCES.length}`);
  
  // شروع پینگ خودکار
  startAutoPing();
});

// راه‌اندازی ربات
if (process.env.RENDER_EXTERNAL_URL) {
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook`;
  console.log(`🌐 تنظیم Webhook: ${webhookUrl}`);
  
  bot.telegram.setWebhook(webhookUrl)
    .then(() => {
      console.log('✅ Webhook با موفقیت تنظیم شد');
      console.log('🤖 ربات آماده دریافت پیام‌ها است');
    })
    .catch(error => {
      console.error('❌ خطا در تنظیم Webhook:', error);
      console.log('🔄 استفاده از Long Polling...');
      bot.launch().then(() => {
        console.log('✅ ربات با Long Polling راه‌اندازی شد');
      });
    });
} else {
  console.log('🔄 استفاده از Long Polling...');
  bot.launch().then(() => {
    console.log('✅ ربات با Long Polling راه‌اندازی شد');
  });
}

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
