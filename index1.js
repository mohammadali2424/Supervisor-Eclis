const { Telegraf, session, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const https = require('https');

// ==================[ تنظیمات اولیه ]==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3001;
const OWNER_ID = process.env.OWNER_ID || '123456789';
const QUARANTINE_BOT_URL = process.env.QUARANTINE_BOT_URL;
const API_SECRET_KEY = process.env.API_SECRET_KEY;

// ==================[ تنظیمات چندرباتی جدید ]==================
const BOT_INSTANCES = process.env.BOT_INSTANCES ? 
  JSON.parse(process.env.BOT_INSTANCES) : [];
  
const SELF_BOT_ID = process.env.SELF_BOT_ID || 'trigger_1';
const SYNC_ENABLED = process.env.SYNC_ENABLED === 'true';

// کش ب��ای ذخیره وضعیت ربات‌ها و تریگرها
const cache = new NodeCache({ stdTTL: 300, checkperiod: 600 });

// ==================[ مکانیزم قطع مدار (Circuit Breaker) جدید ]==================
const circuitBreaker = {
  state: 'CLOSED', // می‌تواند: CLOSED, OPEN, HALF_OPEN
  failureCount: 0,
  failureThreshold: 10, // پس از ۱۰ خطای پشت سرهم
  timeout: 30000, // به مدت ۳۰ ثانیه باز می‌ماند
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
  if (circuitBreaker.state === 'HALF_OPEN') {
    circuitBreaker.state = 'CLOSED';
    circuitBreaker.failureCount = 0;
    console.log('🟢 Circuit Breaker reset to CLOSED');
  }
};

const recordFailure = () => {
  circuitBreaker.failureCount++;
  if (circuitBreaker.failureCount >= circuitBreaker.failureThreshold) {
    circuitBreaker.state = 'OPEN';
    circuitBreaker.nextAttempt = Date.now() + circuitBreaker.timeout;
    console.log('🔴 Circuit Breaker triggered to OPEN state');
  }
};
// ==================[ پایان مکانیزم قطع مدار ]==================

// بررسی متغیرهای محیطی ضروری
if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ لطفاً مطمئن شوید همه متغیرهای محیطی تنظیم شده‌اند');
  process.exit(1);
}

// ایجاد axios instance با تنظیمات بهینه
const axiosInstance = axios.create({
  timeout: 15000,
  httpsAgent: new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    keepAliveMsecs: 10000
  })
});

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ایجاد bot instance با تنظیمات بهینه
const bot = new Telegraf(BOT_TOKEN, {
  telegram: {
    agent: new https.Agent({
      keepAlive: true,
      timeout: 10000,
      maxSockets: 50
    })
  },
  handlerTimeout: 9000
});

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

// ==================[ توابع پیشرفته برای آزادسازی با مکانیزم قطع مدار ]==================
const releaseUserFromQuarantine = async (userId) => {
  // بررسی قطع مدار
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
    
    // آزادسازی از تمام ربات‌های قرنطینه
    for (const botInstance of BOT_INSTANCES) {
      if (botInstance.type === 'quarantine') {
        const result = await releaseUserFromBotInstance(userId, botInstance);
        results.push(result);
      }
    }
    
    // همچنین آزادسازی از ربات فعلی (اگر قرنطینه باشد)
    if (QUARANTINE_BOT_URL && API_SECRET_KEY) {
      const currentResult = await releaseUserSingleInstance(userId);
      results.push(currentResult);
    }
    
    const successCount = results.filter(r => r.success).length;
    console.log(`✅ کاربر ${userId} از ${successCount}/${results.length} ربات آزاد شد`);
    
    // ثبت موفقیت در قطع مدار
    recordSuccess();
    
    return successCount > 0;
  } catch (error) {
    // ثبت خطا در قطع مدار
    recordFailure();
    console.error('❌ خطا در آزادسازی چندرباتی:', error);
    // Fallback به حالت عادی
    return await releaseUserSingleInstance(userId);
  }
};

// تابع کمکی برای آزادسازی از یک ربات خاص
const releaseUserFromBotInstance = async (userId, botInstance) => {
  try {
    let apiUrl = botInstance.url;
    if (!apiUrl.startsWith('http')) {
      apiUrl = `https://${apiUrl}`;
    }
    
    apiUrl = apiUrl.replace(/\/$/, '');
    const fullUrl = `${apiUrl}/api/release-user`;
    
    console.log(`🔗 ارسال درخواست به: ${fullUrl}`);

    const response = await axiosInstance.post(fullUrl, {
      userId: userId,
      secretKey: botInstance.secretKey,
      sourceBot: SELF_BOT_ID
    }, {
      timeout: 8000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    console.log(`✅ پاسخ از ${botInstance.id}:`, response.data);
    return { success: true, botId: botInstance.id, data: response.data };
  } catch (error) {
    console.error(`❌ خطا در ارتباط با ${botInstance.id}:`, error.message);
    return { success: false, botId: botInstance.id, error: error.message };
  }
};

// تابع اصلی آزادسازی
const releaseUserSingleInstance = async (userId) => {
  try {
    if (!QUARANTINE_BOT_URL || !API_SECRET_KEY) {
      console.error('❌ متغیرهای QUARANTINE_BOT_URL یا API_SECRET_KEY تنظیم نشده‌اند');
      return false;
    }

    let apiUrl = QUARANTINE_BOT_URL;
    if (!apiUrl.startsWith('http')) {
      apiUrl = `https://${apiUrl}`;
    }
    
    apiUrl = apiUrl.replace(/\/$/, '');
    const fullUrl = `${apiUrl}/api/release-user`;
    
    console.log(`🔗 ارس��ل درخواست تکی به: ${fullUrl}`);

    const response = await axiosInstance.post(fullUrl, {
      userId: userId,
      secretKey: API_SECRET_KEY,
      sourceBot: SELF_BOT_ID
    }, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    console.log(`✅ پاسخ دریافت شد:`, response.data);
    return response.data.success;
  } catch (error) {
    console.error('❌ خطا در آزاد کردن کاربر از قرنطینه:');
    
    if (error.response) {
      console.error('📋 وضعیت:', error.response.status);
      console.error('📋 داده پاسخ:', error.response.data);
    } else if (error.request) {
      console.error('📋 درخواست ارسال شده اما پاسخی دریافت نشد');
    } else {
      console.error('📋 خطا:', error.message);
    }
    
    return false;
  }
};
// ==================[ پایان توابع پیشرفته ]==================

// دکمه شیشه‌ای با متن Eclis World
const createGlassButton = () => {
  return Markup.inlineKeyboard([
    Markup.button.callback('𝐄𝐜𝐥𝐢𝐬 𝐖𝐨𝐫𝐥𝐝', 'show_glass_message')
  ]);
};

// پردازش کلیک روی دکمه شیشه‌ای
bot.action('show_glass_message', async (ctx) => {
  try {
    const messageText = ctx.update.callback_query.message.text;
    let alertMessage = '';
    
    if (messageText.includes('ورود') || messageText.includes('ماشین') || messageText.includes('موتور')) {
      if (messageText.includes('زمان سفر') || messageText.includes('زمان آماده سازی')) {
        alertMessage = 'مدت زمان شما تا دریافت بقیه مسیر ها';
      } else {
        alertMessage = 'مسیر های شما برای رفتن به مکان بعدی';
      }
    } else if (messageText.includes('خروج') || messageText.includes('سفر به سلامت')) {
      alertMessage = 'به مسیر هایی که انتخاب میکنین ، دقت کنین ، شاید خطری شمارا تهدید کند...';
    } else {
      alertMessage = 'به دنیای اکلیس خوش آمدید!';
    }
    
    await ctx.answerCbQuery(alertMessage, { show_alert: true });
  } catch (error) {
    console.error('❌ خطا در پردازش دکمه شیشه‌ای:', error);
    ctx.answerCbQuery('⚠️ خطایی رخ داد!', { show_alert: true });
  }
});

// ==================[ تابع handleTrigger با مکانیزم قطع مدار ]==================
const handleTrigger = async (ctx, triggerType) => {
  // بررسی قطع مدار قبل از پردازش
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

    // استفاده از کش برای بهبود عملکرد
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
          cache.set(cacheKey, data, 300); // کش برای 5 دقیقه
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
        
        console.log(`🔄 در حال آزاد کردن کاربر ${ctx.from.id} از قرنطینه...`);
        const releaseSuccess = await releaseUserFromQuarantine(ctx.from.id);
        
        if (releaseSuccess) {
          console.log(`✅ کاربر ${ctx.from.id} با موفقیت از قرنطینه خارج شد`);
        } else {
          console.log(`❌ آزاد کردن کاربر ${ctx.from.id} از قرنطینه ناموفق بود`);
        }
        
        // ثبت موفقیت در قطع مدار
        recordSuccess();
      } catch (error) {
        // ثبت خطا در قطع مدار
        recordFailure();
        console.error('❌ خطا در ارسال پیام تأخیری:', error);
        try {
          await ctx.telegram.sendMessage(
            ctx.chat.id, 
            delayedMessage, 
            { 
              reply_to_message_id: ctx.message.message_id,
              ...createGlassButton(),
              disable_web_page_preview: true
            }
          );
        } catch (fallbackError) {
          console.error('❌ خطا در ارسال fallback پیام:', fallbackError);
        }
      }
    }, delay * 1000);
  } catch (error) {
    // ثبت خطا در قطع مدار
    recordFailure();
    console.error(`❌ خطا در پردازش #${triggerType}:`, error);
  }
};
// ==================[ پایان تابع handleTrigger بهبود یافته ]==================

// ==================[ CATCH-ALL MECHANISM - مکانیزم جامع ]==================
// پردازش همه انواع پیام‌ها
bot.on('message', async (ctx) => {
  try {
    const messageText = ctx.message.text;
    if (!messageText) return;

    // پردازش تریگرها
    if (messageText.includes('#ورود')) await handleTrigger(ctx, 'ورود');
    if (messageText.includes('#ماشین')) await handleTrigger(ctx, 'ماشین');
    if (messageText.includes('#موتور')) await handleTrigger(ctx, 'موتور');
    if (messageText.includes('#خروج')) await handleTrigger(ctx, 'خروج');

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
      
      await ctx.reply(`${triggerEmoji} زمان تأخیر ثبت شد: ${formatTime(delay)}\n\n📝 حالا پیام تأخیری را برای #${ctx.session.triggerType} ارسال کنید:\n\n💡 می‌توانید از هر فرمتی استفاده کنید (لینک، بولد، ایتالیک و غیره)`);
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

        // پاک کردن کش مربوط به این تریگر
        const cacheKey = `trigger:${ctx.session.chatId}:${ctx.session.triggerType}`;
        cache.del(cacheKey);

        const triggerEmoji = ctx.session.triggerType === 'ورود' ? '🚪' : 
                            ctx.session.triggerType === 'ماشین' ? '🚗' : '🏍️';
        
        const hasFormatting = messageEntities.length > 0;
        let confirmationMessage = `${triggerEmoji} تریگر #${ctx.session.triggerType} با موفقیت تنظیم شد!\n\n✅ تریگر قبلی جایگزین شد.`;
        
        if (hasFormatting) {
          confirmationMessage += `\n\n📋 پیام شما با فرمت اصلی ذخیره شد.`;
        }
        
        ctx.reply(confirmationMessage);
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

// پردازش همه callback queries
bot.on('callback_query', async (ctx) => {
  try {
    // اگر callback مربوط به دکمه شیشه‌ای نیست، آن را نادیده بگیر
    if (ctx.update.callback_query.data !== 'show_glass_message') {
      await ctx.answerCbQuery();
      return;
    }
  } catch (error) {
    console.error('خطا در پردازش callback:', error);
    try {
      await ctx.answerCbQuery();
    } catch (e) {
      // ignore
    }
  }
});

// مدیریت خطاهای جهانی
bot.catch((err, ctx) => {
  console.error('خطای جهانی در ربات:', err);
  try {
    ctx.reply('❌ خطایی در پردازش درخواست رخ داد.');
  } catch (e) {
    // ignore
  }
});
// ==================[ پایان مکانیزم جامع ]==================

// دستورات ربات
bot.start((ctx) => ctx.reply('اوپراتور اکلیس درخدمت شماست 🥷🏻'));

bot.command('help', (ctx) => {
  ctx.reply(`
🤖 راهنمای ربات اکلیس - نسخه مدیریتی

/start - شروع کار با ربات
/status - بررسی وضعیت ربات در گروه
/set_t1 - تنظیم تریگر برای #ورود
/set_t2 - تنظیم تریگر برای #ماشین  
/set_t3 - تنظیم تریگر برای #موتور
/help - نمایش این راهنما

#ورود - فعال کردن تریگر ورود (همه کاربران)
#ماشین - فعال کردن تریگر ماشین (همه کاربران)
#موتور - فعال کردن تریگر موتور (همه کاربران)
#خروج - خروج از منطقه (همه کاربران)

💡 نکته: ربات به طور خودکار تمام فرمت‌های متن را حفظ می‌کند:
• هایپرلینک‌ها
• متن بولد (**متن**)
• متن ایتالیک (_متن_)
• متن خط خورده (~متن~)
• کد اینلاین \`کد\`
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

    // نمایش وضعیت قطع مدار
    const breakerStatus = circuitBreaker.state === 'OPEN' ? '🔴 باز' : 
                         circuitBreaker.state === 'HALF_OPEN' ? '🟡 نیمه باز' : '🟢 بسته';
    
    const cacheStats = cache.getStats();
    const cacheInfo = `\n💾 وضعیت ��ش: ${Math.round(cacheStats.keys / cacheStats.max * 100)}% پر`;

    ctx.reply(`
🤖 وضعیت ربات در این گروه:
${triggerInfo}
${cacheInfo}

⚡ وضعیت قطع مدار: ${breakerStatus}
👤 دسترسی شما: ${userAccess.isOwner ? 'مالک' : userAccess.isCreator ? 'سازنده گروه' : userAccess.isAdmin ? 'ادمین' : 'عضو'}
    `);
  } catch (error) {
    console.error('خطا در دستور status:', error);
    ctx.reply('❌ خطا در بررسی وضعیت');
  }
});

// دستورات تنظیم تریگر
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
    await ctx.reply(`${triggerEmoji} تنظیم تریگر برای #${triggerType}\n\n⏰ لطفاً زمان تأخیر را به ثانیه وارد کنید:\nمثال: 60 (برای 1 دقیقه)`);
  } catch (error) {
    console.error('خطا در دستور set_t:', error);
    ctx.reply('❌ خطایی در تنظیم تریگر رخ داد.');
  }
};

bot.command('set_t1', (ctx) => setupTrigger(ctx, 'ورود'));
bot.command('set_t2', (ctx) => setupTrigger(ctx, 'ماشین'));
bot.command('set_t3', (ctx) => setupTrigger(ctx, 'موتور'));

// ==================[ endpointهای جدید برای مانیتورینگ ]==================
app.get('/api/bot-status', (req, res) => {
  const cacheStats = cache.getStats();
  const memoryUsage = process.memoryUsage();
  
  res.status(200).json({
    status: 'online',
    botId: SELF_BOT_ID,
    type: 'trigger',
    timestamp: new Date().toISOString(),
    connectedBots: BOT_INSTANCES.length,
    version: '2.3.0',
    circuitBreaker: {
      state: circuitBreaker.state,
      failureCount: circuitBreaker.failureCount,
      nextAttempt: circuitBreaker.nextAttempt
    },
    cache: {
      keys: cacheStats.keys,
      hits: cacheStats.hits,
      misses: cacheStats.misses,
      hitRate: cacheStats.hits / (cacheStats.hits + cacheStats.misses) || 0
    },
    memory: {
      used: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB',
      usage: Math.round((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100) + '%'
    }
  });
});

app.post('/api/sync-release', async (req, res) => {
  try {
    const { userId, secretKey, sourceBot } = req.body;
    
    // بررسی کلید امنیتی
    if (!secretKey || secretKey !== API_SECRET_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    console.log(`🔄 درخواست هماهنگی از ${sourceBot} برای کاربر ${userId}`);
    
    // اگر این ربات قرنطینه است، کاربر را آزاد کند
    const result = await processSyncRelease(userId);
    
    res.status(200).json({
      success: true,
      botId: SELF_BOT_ID,
      processed: result,
      message: `درخواست هماهنگی از ${sourceBot} پردازش شد`
    });
  } catch (error) {
    console.error('❌ خطا در پردازش هماهنگی:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const processSyncRelease = async (userId) => {
  // این تابع در ربات قرنطینه پیاده‌سازی می‌شود
  console.log(`📥 دریافت درخواست آزادسازی برای کاربر ${userId}`);
  return true;
};

// endpoint جدید برای ریست قطع مدار
app.post('/api/circuit-breaker/reset', (req, res) => {
  circuitBreaker.state = 'CLOSED';
  circuitBreaker.failureCount = 0;
  circuitBreaker.nextAttempt = Date.now();
  
  console.log('🟢 Circuit Breaker manually reset');
  res.status(200).json({ 
    success: true, 
    message: 'Circuit Breaker reset successfully',
    state: circuitBreaker.state
  });
});
// ==================[ پایان endpointهای جدید ]==================

// وب سرور
app.post('/webhook', async (req, res) => {
  try {
    await bot.handleUpdate(req.body, res);
  } catch (error) {
    console.error('❌ خطا در پردازش Webhook:', error);
    res.status(200).send('OK');
  }
});

app.get('/', (req, res) => res.send('🤖 ربات تلگرام در حال اجراست!'));
app.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase.from('triggers').select('count').limit(1);
    error ? res.status(500).send('❌ خطای اتصال به دیتابیس') : res.send('✅ اتصال به دیتابیس موفقیت‌آمیز است');
  } catch (error) {
    res.status(500).send('❌ خطای غیرمنتظره');
  }
});

app.get('/test-quarantine-connection', async (req, res) => {
  try {
    if (!QUARANTINE_BOT_URL || !API_SECRET_KEY) {
      return res.status(500).send('❌ متغیرهای ارتباطی تنظیم نشده‌اند');
    }

    let apiUrl = QUARANTINE_BOT_URL;
    if (!apiUrl.startsWith('http')) {
      apiUrl = `https://${apiUrl}`;
    }
    
    apiUrl = apiUrl.replace(/\/$/, '');
    const fullUrl = `${apiUrl}/health`;
    
    console.log(`🔗 تست اتصال به: ${fullUrl}`);
    
    const response = await axiosInstance.get(fullUrl, { timeout: 10000 });
    res.status(200).json({ 
      success: true, 
      message: 'اتصال موفقیت‌آمیز بود',
      response: response.data
    });
  } catch (error) {
    console.error('❌ خطا در تست اتصال:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'خطا در اتصال',
      error: error.message 
    });
  }
});

// تابع برای تنظیم Webhook با retry
const setupWebhookWithRetry = async (maxRetries = 5) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 تلاش ${attempt} برای تنظیم Webhook...`);
      await bot.telegram.setWebhook(`${process.env.WEBHOOK_DOMAIN}/webhook`);
      console.log('✅ Webhook با موفقیت تنظیم شد');
      return true;
    } catch (error) {
      console.error(`❌ تلاش ${attempt} برای Webhook ناموفق:`, error.message);
      if (attempt === maxRetries) {
        console.error('❌ همه تلاش‌ها برای تنظیم Webhook ناموفق بود');
        return false;
      }
      // انتظار قبل از تلاش مجدد
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
};

app.listen(PORT, async () => {
  console.log(`🚀 سرور در پورت ${PORT} راه‌اندازی شد`);
  console.log(`🤖 شناسه ربات: ${SELF_BOT_ID}`);
  console.log(`🔗 حالت هماهنگی: ${SYNC_ENABLED ? 'فعال' : 'غیرف��ال'}`);
  console.log(`👥 تعداد ربات‌های متصل: ${BOT_INSTANCES.length}`);
  console.log(`⚡ Circuit Breaker: ${circuitBreaker.state}`);
  console.log(`💾 کش: فعال با TTL: 300 ثانیه`);
  
  if (process.env.WEBHOOK_DOMAIN) {
    try {
      await setupWebhookWithRetry();
    } catch (error) {
      console.error('❌ خطا در تنظیم Webhook:', error);
    }
  } else {
    console.log('🔄 استفاده از Long Polling...');
    bot.launch().then(() => {
      console.log('✅ ربات با Long Polling راه‌اندازی شد');
    }).catch(error => {
      console.error('❌ خطا در راه‌اندازی ربات:', error);
    });
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
