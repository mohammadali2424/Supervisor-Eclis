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

// ==================[ سشن بهبود یافته ]==================
bot.use(session({
  defaultSession: () => ({
    settingTrigger: false,
    triggerType: null,
    step: null,
    delay: null,
    chatId: null,
    userStates: {} // حالت‌های کاربران مختلف
  })
}));

// ==================[ پینگ ]==================
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

// ==================[ تابع آزادسازی - کاملاً اصلاح شده ]==================
const releaseUserFromQuarantine = async (userId) => {
  try {
    if (!QUARANTINE_BOT_URL || !API_SECRET_KEY) {
      console.log('❌ آدرس ربات قرنطینه یا کلید API تنظیم نشده');
      return false;
    }

    console.log(`🔓 درخواست آزادسازی کاربر ${userId} از قرنطینه...`);
    
    let apiUrl = QUARANTINE_BOT_URL;
    if (!apiUrl.startsWith('http')) {
      apiUrl = `https://${apiUrl}`;
    }
    
    apiUrl = apiUrl.replace(/\/+$/, '');
    const apiEndpoint = `${apiUrl}/api/release-user`;

    const requestData = {
      userId: parseInt(userId),
      secretKey: API_SECRET_KEY,
      sourceBot: SELF_BOT_ID
    };

    // تلاش با مکانیزم retry
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`🔄 تلاش ${attempt} برای آزادسازی کاربر ${userId}...`);
        
        const response = await axios.post(apiEndpoint, requestData, { 
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json'
          }
        });

        if (response.data && response.data.success) {
          console.log(`✅ کاربر ${userId} با موفقیت آزاد شد`);
          
          // پاک کردن کش کاربر
          cache.del(`user_quarantine_${userId}`);
          return true;
        } else {
          console.log(`❌ پاسخ ناموفق از ربات قرنطینه:`, response.data);
          lastError = new Error(response.data?.message || 'پاسخ ناموفق از سرور');
        }
      } catch (error) {
        lastError = error;
        console.log(`❌ خطا در تلاش ${attempt}:`, error.message);
        
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    console.log(`❌ آزادسازی کاربر ${userId} پس از 3 تلاش ناموفق ماند`);
    return false;
  } catch (error) {
    console.log(`❌ خطای غیرمنتظره در آزادسازی کاربر ${userId}:`, error.message);
    return false;
  }
};

// ==================[ تابع کمکی برای بررسی وضعیت کاربر ]==================
const checkUserQuarantineStatus = async (userId) => {
  try {
    const cacheKey = `user_quarantine_${userId}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    if (!QUARANTINE_BOT_URL || !API_SECRET_KEY) {
      return { isQuarantined: false };
    }

    let apiUrl = QUARANTINE_BOT_URL;
    if (!apiUrl.startsWith('http')) {
      apiUrl = `https://${apiUrl}`;
    }
    
    apiUrl = apiUrl.replace(/\/+$/, '');
    const apiEndpoint = `${apiUrl}/api/check-quarantine`;

    const requestData = {
      userId: parseInt(userId),
      secretKey: API_SECRET_KEY
    };

    const response = await axios.post(apiEndpoint, requestData, { 
      timeout: 8000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (response.data) {
      cache.set(cacheKey, response.data, 300); // کش برای 5 دقیقه
      return response.data;
    }

    return { isQuarantined: false };
  } catch (error) {
    console.log(`❌ خطا در بررسی وضعیت کاربر ${userId}:`, error.message);
    return { isQuarantined: false };
  }
};

// ==================[ تابع ایجاد فرمت پیام ]==================
const createFormattedMessage = (text, entities = []) => {
  if (!entities || entities.length === 0) {
    return { 
      text: text || 'پیام خالی',
      parse_mode: undefined,
      disable_web_page_preview: true
    };
  }

  let formattedText = text || '';
  const sortedEntities = [...entities].sort((a, b) => b.offset - a.offset);
  
  sortedEntities.forEach(entity => {
    const { offset, length, type } = entity;
    const start = offset;
    const end = offset + length;
    
    if (start >= formattedText.length || end > formattedText.length) return;
    
    const entityText = formattedText.substring(start, end);
    let wrappedText = entityText;
    
    switch (type) {
      case 'bold':
        wrappedText = `<b>${entityText}</b>`;
        break;
      case 'italic':
        wrappedText = `<i>${entityText}</i>`;
        break;
      case 'underline':
        wrappedText = `<u>${entityText}</u>`;
        break;
      case 'strikethrough':
        wrappedText = `<s>${entityText}</s>`;
        break;
      case 'code':
        wrappedText = `<code>${entityText}</code>`;
        break;
      case 'pre':
        wrappedText = `<pre>${entityText}</pre>`;
        break;
      case 'text_link':
        wrappedText = `<a href="${entity.url}">${entityText}</a>`;
        break;
      case 'text_mention':
        wrappedText = `<a href="tg://user?id=${entity.user.id}">${entityText}</a>`;
        break;
      default:
        wrappedText = entityText;
    }
    
    formattedText = formattedText.substring(0, start) + wrappedText + formattedText.substring(end);
  });

  return { 
    text: formattedText, 
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
};

// ==================[ تابع handleTrigger - کاملاً اصلاح شده ]==================
const handleTrigger = async (ctx, triggerType) => {
  try {
    if (ctx.chat.type === 'private') return;

    const userName = ctx.from.first_name || 'کاربر';
    const userId = ctx.from.id;
    
    // بررسی وضعیت فعلی کاربر
    const quarantineStatus = await checkUserQuarantineStatus(userId);
    console.log(`🔍 وضعیت قرنطینه کاربر ${userId}:`, quarantineStatus);
    
    if (triggerType === 'خروج') {
      await ctx.reply(`🧭┊سفر به سلامت ${userName}`, { 
        reply_to_message_id: ctx.message.message_id,
        ...createGlassButton()
      });
      
      // آزادسازی فوری کاربر
      console.log(`🔓 درخواست آزادسازی فوری کاربر ${userId}...`);
      await releaseUserFromQuarantine(userId);
      return;
    }
    
    const cacheKey = `trigger_${ctx.chat.id}_${triggerType}`;
    let triggerData = cache.get(cacheKey);
    
    if (!triggerData) {
      try {
        const { data, error } = await supabase
          .from('triggers')
          .select('delay, delayed_message, message_entities')
          .eq('chat_id', ctx.chat.id)
          .eq('trigger_type', triggerType)
          .single();

        if (!error && data) {
          triggerData = data;
          cache.set(cacheKey, data, 3600);
        }
      } catch (error) {
        console.log('خطا در دریافت داده از دیتابیس:', error.message);
      }
    }

    const delay = triggerData?.delay || 5;
    const delayedMessage = triggerData?.delayed_message || 'عملیات تکمیل شد! ✅';
    const messageEntities = triggerData?.message_entities || [];
    const triggerEmoji = triggerType === 'ورود' ? '🎴' : triggerType === 'ماشین' ? '🚗' : '🏍️';
    
    const initialMessage = `${triggerEmoji}┊${userName} وارد منطقه شد\n\n⏳┊زمان: ${formatTime(delay)}`;
    
    await ctx.reply(initialMessage, { 
      reply_to_message_id: ctx.message.message_id,
      ...createGlassButton()
    });

    // ذخیره داده‌های لازم برای تایمر
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;

    // ایجاد تایمر با مدیریت بهتر
    const timerId = setTimeout(async () => {
      try {
        console.log(`🕒 تایمر برای کاربر ${userId} به پایان رسید`);
        
        const formattedMessage = createFormattedMessage(delayedMessage, messageEntities);
        
        const messageOptions = {
          reply_to_message_id: messageId,
          ...createGlassButton(),
          ...formattedMessage
        };

        await bot.telegram.sendMessage(chatId, formattedMessage.text, messageOptions);
        
        console.log(`🔓 شروع فرآیند آزادسازی کاربر ${userId}...`);
        const releaseResult = await releaseUserFromQuarantine(userId);
        
        if (releaseResult) {
          console.log(`✅ کاربر ${userId} با موفقیت آزاد شد`);
        } else {
          console.log(`❌ آزادسازی کاربر ${userId} ناموفق بود`);
          
          // تلاش مجدد پس از 10 ثانیه
          setTimeout(async () => {
            console.log(`🔄 تلاش مجدد برای آزادسازی کاربر ${userId}...`);
            await releaseUserFromQuarantine(userId);
          }, 10000);
        }
      } catch (error) {
        console.log('❌ خطا در ارسال پیام تأخیری:', error.message);
      }
    }, delay * 1000);

    // ذخیره تایمر برای مدیریت بهتر
    const userTimerKey = `timer_${userId}_${ctx.chat.id}`;
    cache.set(userTimerKey, timerId, delay + 10);

  } catch (error) {
    console.log('❌ خطا در پردازش تریگر:', error.message);
  }
};

const formatTime = (seconds) => {
  if (seconds < 60) return `${seconds} ثانیه`;
  const minutes = Math.floor(seconds / 60);
  return minutes + ' دقیقه';
};

const createGlassButton = () => {
  return Markup.inlineKeyboard([
    Markup.button.callback('Eclis World', 'show_glass')
  ]);
};

bot.action('show_glass', async (ctx) => {
  try {
    await ctx.answerCbQuery('به دنیای اکلیس خوش آمدید!', { show_alert: true });
  } catch (error) {
    await ctx.answerCbQuery('⚠️ خطا!', { show_alert: true });
  }
});

// ==================[ دستور جدید برای آزادسازی دستی ]==================
bot.command('free', async (ctx) => {
  try {
    const access = checkOwnerAccess(ctx);
    if (!access.hasAccess) {
      return ctx.reply(access.message);
    }

    const userId = ctx.from.id;
    console.log(`🔓 درخواست آزادسازی دستی کاربر ${userId}...`);
    
    const result = await releaseUserFromQuarantine(userId);
    
    if (result) {
      await ctx.reply('✅ شما با موفقیت از قرنطینه آزاد شدید.');
    } else {
      await ctx.reply('❌ خطا در آزادسازی. لطفاً دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.');
    }
  } catch (error) {
    console.log('❌ خطا در دستور آزادسازی:', error.message);
    await ctx.reply('❌ خطا در پردازش درخواست.');
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

// بقیه دستورات مانند قبل...
// [کدهای دستورات help, status, off, set_t1, set_t2, set_t3 مانند قبل باقی می‌مانند]

// ==================[ API بهبود یافته ]==================
app.post('/api/release-user', async (req, res) => {
  try {
    const { userId, secretKey } = req.body;
    
    if (!secretKey || secretKey !== API_SECRET_KEY) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    
    // پاسخ فوری و سپس پردازش
    res.status(200).json({ 
      success: true, 
      botId: SELF_BOT_ID,
      message: 'درخواست آزادسازی دریافت شد'
    });
    
  } catch (error) {
    res.status(500).json({ error: 'internal server error' });
  }
});

// ==================[ راه‌اندازی ]==================
app.use(bot.webhookCallback('/webhook'));
app.get('/', (req, res) => {
  res.send(`🤖 تریگر ${SELF_BOT_ID} فعال - مالک: ${OWNER_ID}`);
});

app.listen(PORT, () => {
  console.log(`🚀 تریگر ${SELF_BOT_ID} راه‌اندازی شد`);
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
  console.log('خطای catch نشده:', error.message);
});
