const { Telegraf, session, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;
const OWNER_ID = parseInt(process.env.OWNER_ID) || 0;
const QUARANTINE_BOT_URL = process.env.QUARANTINE_BOT_URL;
const API_SECRET_KEY = process.env.API_SECRET_KEY;
const SELF_BOT_ID = process.env.SELF_BOT_ID || 'trigger_1';

const cache = new NodeCache({ 
  stdTTL: 3600,
  checkperiod: 1200,
  maxKeys: 2000
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

// ==================[ پینگ 13:59 دقیقه ]==================
const startAutoPing = () => {
  if (!process.env.RENDER_EXTERNAL_URL) return;
  const PING_INTERVAL = 13 * 60 * 1000 + 59 * 1000;
  const selfUrl = process.env.RENDER_EXTERNAL_URL;

  const performPing = async () => {
    try {
      await axios.head(`${selfUrl}/ping`, { timeout: 5000 });
    } catch (error) {
      setTimeout(performPing, 60000);
    }
  };

  setTimeout(performPing, 30000);
  setInterval(performPing, PING_INTERVAL);
};

app.head('/ping', (req, res) => res.status(200).end());
app.get('/ping', (req, res) => {
  res.status(200).json({ status: 'active', bot: SELF_BOT_ID });
});

// ==================[ تابع آزادسازی - کاملاً بازنویسی شده ]==================
const releaseUserFromQuarantine = async (userId) => {
  try {
    console.log(`\n🔓 ========== شروع آزادسازی کاربر ${userId} ==========`);
    
    if (!QUARANTINE_BOT_URL) {
      console.log('❌ QUARANTINE_BOT_URL تنظیم نشده');
      return false;
    }
    
    if (!API_SECRET_KEY) {
      console.log('❌ API_SECRET_KEY تنظیم نشده');
      return false;
    }

    console.log(`📡 آدرس ربات قرنطینه: ${QUARANTINE_BOT_URL}`);
    console.log(`👤 کاربر مورد نظر: ${userId}`);
    console.log(`🔑 کلید API: ${API_SECRET_KEY ? 'تنظیم شده' : 'تنظیم نشده'}`);
    
    // آماده‌سازی آدرس API
    let apiUrl = QUARANTINE_BOT_URL.trim();
    if (!apiUrl.startsWith('http')) {
      apiUrl = `https://${apiUrl}`;
    }
    
    // حذف اسلش‌های اضافی
    apiUrl = apiUrl.replace(/\/+$/, '');
    const apiEndpoint = `${apiUrl}/api/release-user`;
    
    console.log(`🌐 endpoint نهایی: ${apiEndpoint}`);

    const requestData = {
      userId: parseInt(userId),
      secretKey: API_SECRET_KEY,
      sourceBot: SELF_BOT_ID
    };

    console.log('📦 داده‌های ارسالی:', JSON.stringify(requestData, null, 2));

    const response = await axios.post(apiEndpoint, requestData, { 
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TriggerBot/1.0'
      }
    });

    console.log('✅ درخواست با موفقیت ارسال شد');
    console.log('📨 وضعیت پاسخ:', response.status);
    console.log('📝 پاسخ سرور:', JSON.stringify(response.data, null, 2));

    if (response.data && response.data.success) {
      console.log(`🎉 کاربر ${userId} با موفقیت آزاد شد`);
      return true;
    } else {
      console.log(`⚠️ پاسخ سرور نشان می‌دهد آزادسازی موفق نبوده`);
      return false;
    }
  } catch (error) {
    console.log(`❌ خطا در ارتباط با ربات قرنطینه:`);
    console.log('📋 پیغام خطا:', error.message);
    
    if (error.code) {
      console.log('🏷️ کد خطا:', error.code);
    }
    
    if (error.response) {
      console.log('📊 وضعیت HTTP:', error.response.status);
      console.log('📝 داده پاسخ خطا:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.log('🔌 درخواست ارسال شد اما پاسخی دریافت نشد');
      console.log('🌐 آدرس درخواست:', error.request._currentUrl || 'نامشخص');
    }
    
    console.log('🔍 جزئیات کامل خطا:', error);
    return false;
  }
};

// ==================[ تابع handleTrigger - کاملاً بازنویسی شده ]==================
const handleTrigger = async (ctx, triggerType) => {
  try {
    console.log(`\n🎯 ========== شروع تریگر ${triggerType} ==========`);
    
    if (ctx.chat.type === 'private') {
      console.log('❌ پیام در چت خصوصی است - نادیده گرفته می‌شود');
      return;
    }

    const userName = ctx.from.first_name || 'کاربر';
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;

    console.log(`👤 کاربر: ${userName} (${userId})`);
    console.log(`💬 گروه: ${ctx.chat.title} (${chatId})`);
    console.log(`🏷️ تریگر: ${triggerType}`);
    
    if (triggerType === 'خروج') {
      console.log('🚪 تریگر خروج فعال شد');
      await ctx.reply(`🧭┊سفر به سلامت ${userName}`, { 
        reply_to_message_id: ctx.message.message_id,
        ...createGlassButton()
      });
      return;
    }
    
    const cacheKey = `trigger_${chatId}_${triggerType}`;
    console.log(`🔑 کلید کش: ${cacheKey}`);
    
    let triggerData = cache.get(cacheKey);
    
    if (!triggerData) {
      console.log('📡 داده در کش یافت نشد - دریافت از دیتابیس...');
      try {
        const { data, error } = await supabase
          .from('triggers')
          .select('delay, delayed_message')
          .eq('chat_id', chatId)
          .eq('trigger_type', triggerType)
          .single();

        if (error) {
          console.log('❌ خطا در دریافت از دیتابیس:', error.message);
        }

        if (data) {
          triggerData = data;
          cache.set(cacheKey, data, 3600);
          console.log('✅ داده از دیتابیس دریافت و در کش ذخیره شد');
        } else {
          console.log('⚠️ داده‌ای در دیتابیس یافت نشد - استفاده از مقادیر پیش‌فرض');
        }
      } catch (error) {
        console.log('❌ خطا در دریافت داده از دیتابیس:', error.message);
      }
    } else {
      console.log('✅ داده از کش بازیابی شد');
    }

    const delay = triggerData?.delay || 5;
    const delayedMessage = triggerData?.delayed_message || 'عملیات تکمیل شد! ✅';
    const triggerEmoji = triggerType === 'ورود' ? '🎴' : triggerType === 'ماشین' ? '🚗' : '🏍️';
    
    const initialMessage = `${triggerEmoji}┊${userName} وارد منطقه شد\n\n⏳┊زمان: ${formatTime(delay)}`;
    
    console.log(`⏰ تایمر تنظیم شده: ${delay} ثانیه`);
    console.log(`📝 پیام تأخیری: ${delayedMessage}`);

    const sentMessage = await ctx.reply(initialMessage, { 
      reply_to_message_id: ctx.message.message_id,
      ...createGlassButton()
    });

    console.log(`✅ پیام اولیه ارسال شد - شروع تایمر ${delay} ثانیه‌ای`);

    // ذخیره اطلاعات تایمر برای استفاده بعدی
    const timerData = {
      userId: userId,
      userName: userName,
      chatId: chatId,
      triggerType: triggerType,
      delayedMessage: delayedMessage,
      originalMessageId: ctx.message.message_id
    };

    setTimeout(async () => {
      try {
        console.log(`\n⏰ ========== تایمر به پایان رسید برای کاربر ${userId} ==========`);
        console.log(`👤 آزادسازی کاربر: ${userName} (${userId})`);
        
        // اول پیام تأخیری رو ارسال کن
        console.log('📤 ارسال پیام تأخیری...');
        await ctx.telegram.sendMessage(chatId, delayedMessage, {
          reply_to_message_id: ctx.message.message_id,
          ...createGlassButton(),
          disable_web_page_preview: true
        });
        console.log('✅ پیام تأخیری ارسال شد');
        
        // حالا کاربر رو آزاد کن
        console.log('🔓 شروع فرآیند آزادسازی کاربر از قرنطینه...');
        const releaseResult = await releaseUserFromQuarantine(userId);
        
        if (releaseResult) {
          console.log(`🎉 کاربر ${userId} با موفقیت از قرنطینه آزاد شد`);
          // پیام موفقیت آمیز
          await ctx.telegram.sendMessage(chatId, `✅ کاربر ${userName} از قرنطینه آزاد شد و می‌تواند به گروه‌های دیگر برود.`, {
            ...createGlassButton()
          });
        } else {
          console.log(`⚠️ کاربر ${userId} آزاد نشد`);
          // پیام خطا
          await ctx.telegram.sendMessage(chatId, `❌ خطا در آزادسازی کاربر ${userName} از قرنطینه. لطفاً با پشتیبانی تماس بگیرید.`, {
            ...createGlassButton()
          });
        }
      } catch (error) {
        console.log('❌ خطا در ارسال پیام تأخیری:', error.message);
      }
    }, delay * 1000);

    console.log(`✅ تریگر ${triggerType} با موفقیت تنظیم شد`);

  } catch (error) {
    console.log('❌ خطا در پردازش تریگر:', error.message);
    console.log('🔍 جزئیات خطا:', error);
  }
};

const formatTime = (seconds) => {
  if (seconds < 60) return `${seconds} ثانیه`;
  const minutes = Math.floor(seconds / 60);
  return minutes + ' دقیقه';
};

const createGlassButton = () => {
  return Markup.inlineKeyboard([
    Markup.button.callback('𝐄𝐜𝐥𝐢𝐬 𝐖𝐨𝐫𝐥𝐝', 'show_glass')
  ]);
};

bot.action('show_glass', async (ctx) => {
  try {
    await ctx.answerCbQuery('به دنیای اکلیس خوش آمدید!', { show_alert: true });
  } catch (error) {
    await ctx.answerCbQuery('⚠️ خطا!', { show_alert: true });
  }
});

// ==================[ بررسی مالکیت ]==================
const checkOwnerAccess = (ctx) => {
  const userId = ctx.from.id;
  if (userId !== OWNER_ID) {
    return {
      hasAccess: false,
      message: '🚫 شما مالک اکلیس نیستی ، حق استفاده از بات این مجموعه رو نداری ، حدتو بدون'
    };
  }
  return { hasAccess: true };
};

// ==================[ دستورات با بررسی مالکیت ]==================
bot.command('help', (ctx) => {
  ctx.reply(`🤖 راهنما:
/status - وضعیت
/set_t1 - تنظیم #ورود
/set_t2 - تنظیم #ماشین  
/set_t3 - تنظیم #موتور
/off - غیرفعال کردن
#ورود #ماشین #موتور #خروج`);
});

bot.command('status', async (ctx) => {
  try {
    const access = checkOwnerAccess(ctx);
    if (!access.hasAccess) {
      ctx.reply(access.message);
      return;
    }

    let triggerInfo = '\n⚙️ تریگرها:';
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
    } else {
      triggerInfo += '\n❌ تریگری تنظیم نشده';
    }

    ctx.reply(`🤖 وضعیت:${triggerInfo}`);
  } catch (error) {
    ctx.reply('❌ خطا');
  }
});

bot.command('off', async (ctx) => {
  try {
    const access = checkOwnerAccess(ctx);
    if (!access.hasAccess) {
      ctx.reply(access.message);
      return;
    }

    const chatId = ctx.chat.id;
    await supabase.from('triggers').delete().eq('chat_id', chatId);
    
    ['ورود', 'ماشین', 'موتور'].forEach(type => {
      cache.del(`trigger_${chatId}_${type}`);
    });

    ctx.reply('✅ ربات غیرفعال شد');
    
    try {
      await ctx.leaveChat();
    } catch (error) {}
  } catch (error) {
    ctx.reply('❌ خطا');
  }
});

const setupTrigger = async (ctx, triggerType) => {
  try {
    const access = checkOwnerAccess(ctx);
    if (!access.hasAccess) {
      ctx.reply(access.message);
      return;
    }

    ctx.session.settingTrigger = true;
    ctx.session.triggerType = triggerType;
    ctx.session.step = 'delay';
    ctx.session.chatId = ctx.chat.id;

    const emoji = triggerType === 'ورود' ? '🚪' : triggerType === 'ماشین' ? '🚗' : '🏍️';
    await ctx.reply(`${emoji} تریگر #${triggerType}\n⏰ زمان به ثانیه:`);
  } catch (error) {
    ctx.reply('❌ خطا');
  }
};

bot.command('set_t1', (ctx) => setupTrigger(ctx, 'ورود'));
bot.command('set_t2', (ctx) => setupTrigger(ctx, 'ماشین'));
bot.command('set_t3', (ctx) => setupTrigger(ctx, 'موتور'));

// ==================[ پردازش پیام‌ها ]==================
bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text;
    
    console.log(`📨 دریافت پیام: "${text}" از کاربر ${ctx.from.id}`);
    
    if (text.includes('#ورود')) {
      console.log('🎯 تشخیص تریگر #ورود');
      await handleTrigger(ctx, 'ورود');
    }
    if (text.includes('#ماشین')) {
      console.log('🎯 تشخیص تریگر #ماشین');
      await handleTrigger(ctx, 'ماشین');
    }
    if (text.includes('#موتور')) {
      console.log('🎯 تشخیص تریگر #موتور');
      await handleTrigger(ctx, 'موتور');
    }
    if (text.includes('#خروج')) {
      console.log('🎯 تشخیص تریگر #خروج');
      await handleTrigger(ctx, 'خروج');
    }

    if (!ctx.session.settingTrigger) return;

    const access = checkOwnerAccess(ctx);
    if (!access.hasAccess) {
      ctx.reply(access.message);
      ctx.session.settingTrigger = false;
      return;
    }

    if (ctx.session.step === 'delay') {
      const delay = parseInt(ctx.message.text);
      if (isNaN(delay) || delay <= 0 || delay > 3600) {
        ctx.reply('❌ عدد 1 تا 3600');
        return;
      }

      ctx.session.delay = delay;
      ctx.session.step = 'message';
      await ctx.reply(`✅ زمان: ${formatTime(delay)}\n📝 پیام:`);
    } else if (ctx.session.step === 'message') {
      try {
        await supabase.from('triggers').delete()
          .eq('chat_id', ctx.session.chatId)
          .eq('trigger_type', ctx.session.triggerType);

        await supabase.from('triggers').insert({
          chat_id: ctx.session.chatId,
          trigger_type: ctx.session.triggerType,
          delay: ctx.session.delay,
          delayed_message: ctx.message.text,
          updated_at: new Date().toISOString()
        });

        cache.del(`trigger_${ctx.session.chatId}_${ctx.session.triggerType}`);

        const emoji = ctx.session.triggerType === 'ورود' ? '🚪' : 
                     ctx.session.triggerType === 'ماشین' ? '🚗' : '🏍️';
        ctx.reply(`${emoji} تریگر #${ctx.session.triggerType} تنظیم شد!`);
      } catch (error) {
        ctx.reply('❌ خطا در ذخیره');
      }
      ctx.session.settingTrigger = false;
    }
  } catch (error) {
    console.log('❌ خطا در پردازش پیام:', error.message);
  }
});

// ==================[ API برای تست ]==================
app.post('/api/test-release', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    console.log(`🧪 تست دستی آزادسازی کاربر ${userId}`);
    const result = await releaseUserFromQuarantine(userId);
    
    res.status(200).json({ 
      success: result,
      message: result ? `User ${userId} released` : `Failed to release user ${userId}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/release-user', async (req, res) => {
  try {
    const { userId, secretKey } = req.body;
    
    if (!secretKey || secretKey !== API_SECRET_KEY) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    
    res.status(200).json({ success: true, botId: SELF_BOT_ID });
  } catch (error) {
    res.status(500).json({ error: 'error' });
  }
});

// ==================[ راه‌اندازی ]==================
app.use(bot.webhookCallback('/webhook'));
app.get('/', (req, res) => {
  res.send(`
    <h1>🤖 تریگر ${SELF_BOT_ID}</h1>
    <p>ربات فعال است - مالک: ${OWNER_ID}</p>
    <p>آدرس قرنطینه: ${QUARANTINE_BOT_URL || 'تنظیم نشده'}</p>
    <p>کلید API: ${API_SECRET_KEY ? 'تنظیم شده' : 'تنظیم نشده'}</p>
    <h3>تست دستی:</h3>
    <form action="/api/test-release" method="post">
      <input type="number" name="userId" placeholder="User ID" required>
      <button type="submit">تست آزادسازی</button>
    </form>
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 تریگر ${SELF_BOT_ID} راه‌اندازی شد`);
  console.log(`🔗 آدرس ربات قرنطینه: ${QUARANTINE_BOT_URL}`);
  console.log(`🔑 کلید API: ${API_SECRET_KEY ? 'تنظیم شده' : '❌ تنظیم نشده'}`);
  console.log(`👤 مالک: ${OWNER_ID}`);
  startAutoPing();
});

if (process.env.RENDER_EXTERNAL_URL) {
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook`;
  bot.telegram.setWebhook(webhookUrl)
    .then(() => console.log('✅ Webhook تنظیم شد'))
    .catch(() => bot.launch());
} else {
  bot.launch();
}

process.on('unhandledRejection', (error) => {
  console.log('❌ خطای catch نشده:', error.message);
});
