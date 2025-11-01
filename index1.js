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
  maxKeys: 2000,
  useClones: false
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
    userId: null
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
      console.log('✅ پینگ موفق - تریگر');
    } catch (error) {
      console.log('❌ خطا در پینگ تریگر:', error.message);
      setTimeout(performPing, 60000);
    }
  };

  setTimeout(performPing, 30000);
  setInterval(performPing, PING_INTERVAL);
};

app.head('/ping', (req, res) => res.status(200).end());
app.get('/ping', (req, res) => {
  res.status(200).json({ status: 'active', bot: SELF_BOT_ID, timestamp: new Date().toISOString() });
});

// ==================[ تابع آزادسازی بهبود یافته ]==================
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
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`🔄 تلاش ${attempt} برای آزادسازی کاربر ${userId}...`);
        
        const response = await axios.post(apiEndpoint, requestData, { 
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': `TriggerBot/${SELF_BOT_ID}`
          }
        });

        if (response.data && response.data.success) {
          console.log(`✅ کاربر ${userId} با موفقیت آزاد شد`);
          cache.del(`user_quarantine_${userId}`);
          return true;
        } else {
          console.log(`❌ پاسخ ناموفق از ربات قرنطینه:`, response.data);
        }
      } catch (error) {
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

// ==================[ تابع ایجاد فرمت پیام ]==================
const createFormattedMessage = (text, entities = []) => {
  if (!text || !entities || entities.length === 0) {
    return { 
      text: text || 'پیام خالی',
      parse_mode: undefined,
      disable_web_page_preview: true
    };
  }

  let formattedText = text;
  const sortedEntities = [...entities].sort((a, b) => b.offset - a.offset);
  
  sortedEntities.forEach(entity => {
    const { offset, length, type } = entity;
    const start = offset;
    const end = offset + length;
    
    if (start >= formattedText.length || end > formattedText.length) {
      return;
    }
    
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

// ==================[ تابع handleTrigger بهبود یافته ]==================
const handleTrigger = async (ctx, triggerType) => {
  try {
    if (ctx.chat.type === 'private') {
      await ctx.reply('❌ این دستور فقط در گروه قابل استفاده است');
      return;
    }

    const userName = ctx.from.first_name || 'کاربر';
    const userId = ctx.from.id;
    
    if (triggerType === 'خروج') {
      await ctx.reply(`🧭┊سفر به سلامت ${userName}`, { 
        reply_to_message_id: ctx.message.message_id,
        ...createGlassButton()
      });
      
      console.log(`🔓 درخواست آزادسازی فوری کاربر ${userId}...`);
      const releaseResult = await releaseUserFromQuarantine(userId);
      
      if (releaseResult) {
        console.log(`✅ کاربر ${userId} با موفقیت آزاد شد`);
      } else {
        console.log(`❌ آزادسازی کاربر ${userId} ناموفق بود`);
      }
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

        if (error) {
          console.log(`❌ خطا در دریافت تریگر ${triggerType}:`, error.message);
        }

        if (data) {
          triggerData = data;
          cache.set(cacheKey, data, 3600);
        }
      } catch (error) {
        console.log('❌ خطا در دریافت داده از دیتابیس:', error.message);
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

    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;

    setTimeout(async () => {
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
        }
      } catch (error) {
        console.log('❌ خطا در ارسال پیام تأخیری:', error.message);
      }
    }, delay * 1000);

  } catch (error) {
    console.log('❌ خطا در پردازش تریگر:', error.message);
    try {
      await ctx.reply('❌ خطا در پردازش درخواست');
    } catch (e) {
      console.log('❌ خطا در ارسال پیام خطا:', e.message);
    }
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

// ==================[ بررسی مالکیت ]==================
const checkOwnerAccess = (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || userId !== OWNER_ID) {
    return {
      hasAccess: false,
      message: '🚫 شما مالک اکلیس نیستی ، حق استفاده از بات این مجموعه رو نداری ، حدتو بدون'
    };
  }
  return { hasAccess: true };
};

// ==================[ دستورات ]==================
bot.command('help', async (ctx) => {
  try {
    await ctx.reply(`🤖 راهنما:
/status - وضعیت
/set_t1 - تنظیم #ورود
/set_t2 - تنظیم #ماشین  
/set_t3 - تنظیم #موتور
/off - غیرفعال کردن
#ورود #ماشین #موتور #خروج`);
  } catch (error) {
    console.log('❌ خطا در دستور help:', error.message);
  }
});

bot.command('status', async (ctx) => {
  try {
    const access = checkOwnerAccess(ctx);
    if (!access.hasAccess) {
      return await ctx.reply(access.message);
    }

    let triggerInfo = '\n⚙️ تریگرها:';
    const { data: triggers, error } = await supabase
      .from('triggers')
      .select('trigger_type, delay, delayed_message')
      .eq('chat_id', ctx.chat.id);

    if (!error && triggers && triggers.length > 0) {
      triggers.forEach(trigger => {
        const emoji = trigger.trigger_type === 'ورود' ? '🚪' : 
                     trigger.trigger_type === 'ماشین' ? '🚗' : '🏍️';
        triggerInfo += `\n${emoji} #${trigger.trigger_type}: ${formatTime(trigger.delay)}`;
      });
    } else {
      triggerInfo += '\n❌ تریگری تنظیم نشده';
    }

    await ctx.reply(`🤖 وضعیت:${triggerInfo}`);
  } catch (error) {
    console.log('❌ خطا در دستور status:', error.message);
    await ctx.reply('❌ خطا در دریافت وضعیت');
  }
});

bot.command('off', async (ctx) => {
  try {
    const access = checkOwnerAccess(ctx);
    if (!access.hasAccess) {
      return await ctx.reply(access.message);
    }

    const chatId = ctx.chat.id;
    const { error } = await supabase.from('triggers').delete().eq('chat_id', chatId);
    
    if (!error) {
      ['ورود', 'ماشین', 'موتور'].forEach(type => {
        cache.del(`trigger_${chatId}_${type}`);
      });
      await ctx.reply('✅ ربات غیرفعال شد');
    } else {
      await ctx.reply('❌ خطا در غیرفعال کردن');
    }
    
    try {
      await ctx.leaveChat();
      console.log(`🚪 ربات تریگر از گروه ${chatId} خارج شد`);
    } catch (error) {
      console.log('⚠️ خطا در خروج از گروه:', error.message);
    }
  } catch (error) {
    console.log('❌ خطا در دستور off:', error.message);
    await ctx.reply('❌ خطا در غیرفعال کردن');
  }
});

const setupTrigger = async (ctx, triggerType) => {
  try {
    const access = checkOwnerAccess(ctx);
    if (!access.hasAccess) {
      return await ctx.reply(access.message);
    }

    ctx.session.settingTrigger = true;
    ctx.session.triggerType = triggerType;
    ctx.session.step = 'delay';
    ctx.session.chatId = ctx.chat.id;
    ctx.session.userId = ctx.from.id;

    const emoji = triggerType === 'ورود' ? '🚪' : triggerType === 'ماشین' ? '🚗' : '🏍️';
    await ctx.reply(`${emoji} تریگر #${triggerType}\n⏰ زمان به ثانیه (۱-۳۶۰۰):`);
  } catch (error) {
    console.log('❌ خطا در شروع تنظیم تریگر:', error.message);
    await ctx.reply('❌ خطا در شروع تنظیم تریگر');
  }
};

bot.command('set_t1', (ctx) => setupTrigger(ctx, 'ورود'));
bot.command('set_t2', (ctx) => setupTrigger(ctx, 'ماشین'));
bot.command('set_t3', (ctx) => setupTrigger(ctx, 'موتور'));

// ==================[ پردازش پیام‌ها ]==================
bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text;
    
    if (text.includes('#ورود')) await handleTrigger(ctx, 'ورود');
    if (text.includes('#ماشین')) await handleTrigger(ctx, 'ماشین');
    if (text.includes('#موتور')) await handleTrigger(ctx, 'موتور');
    if (text.includes('#خروج')) await handleTrigger(ctx, 'خروج');

    if (!ctx.session.settingTrigger) return;

    const access = checkOwnerAccess(ctx);
    if (!access.hasAccess) {
      await ctx.reply(access.message);
      ctx.session.settingTrigger = false;
      return;
    }

    if (ctx.session.userId !== ctx.from.id) {
      await ctx.reply('❌ جلسه تنظیم منقضی شده است. مجدداً دستور را ارسال کنید.');
      ctx.session.settingTrigger = false;
      return;
    }

    if (ctx.session.step === 'delay') {
      const delay = parseInt(ctx.message.text);
      if (isNaN(delay) || delay <= 0 || delay > 3600) {
        await ctx.reply('❌ لطفاً عدد بین ۱ تا ۳۶۰۰ ثانیه وارد کنید:');
        return;
      }

      ctx.session.delay = delay;
      ctx.session.step = 'message';
      await ctx.reply(`✅ زمان: ${formatTime(delay)}\n📝 پیام نهایی:`);
    } else if (ctx.session.step === 'message') {
      try {
        const text = ctx.message.text;
        const entities = ctx.message.entities || [];
        
        await supabase.from('triggers').delete()
          .eq('chat_id', ctx.session.chatId)
          .eq('trigger_type', ctx.session.triggerType);

        const { error } = await supabase.from('triggers').insert({
          chat_id: ctx.session.chatId,
          trigger_type: ctx.session.triggerType,
          delay: ctx.session.delay,
          delayed_message: text,
          message_entities: entities,
          updated_at: new Date().toISOString()
        });

        if (!error) {
          cache.del(`trigger_${ctx.session.chatId}_${ctx.session.triggerType}`);
          const emoji = ctx.session.triggerType === 'ورود' ? '🚪' : 
                       ctx.session.triggerType === 'ماشین' ? '🚗' : '🏍️';
          await ctx.reply(`${emoji} تریگر #${ctx.session.triggerType} تنظیم شد!\n⏰ زمان: ${formatTime(ctx.session.delay)}`);
        } else {
          console.log('❌ خطا در ذخیره تریگر:', error);
          await ctx.reply('❌ خطا در ذخیره تریگر');
        }
      } catch (error) {
        console.log('❌ خطا در ذخیره تریگر:', error);
        await ctx.reply('❌ خطا در ذخیره تریگر');
      }
      ctx.session.settingTrigger = false;
      ctx.session.triggerType = null;
      ctx.session.step = null;
      ctx.session.delay = null;
    }
  } catch (error) {
    console.log('❌ خطا در پردازش پیام:', error.message);
  }
});

// ==================[ API ]==================
app.post('/api/release-user', async (req, res) => {
  try {
    const { userId, secretKey } = req.body;
    
    if (!secretKey || secretKey !== API_SECRET_KEY) {
      console.log('❌ کلید API نامعتبر در تریگر');
      return res.status(401).json({ error: 'unauthorized' });
    }
    
    res.status(200).json({ 
      success: true, 
      botId: SELF_BOT_ID,
      message: 'دریافت شد'
    });
  } catch (error) {
    console.log('❌ خطا در API تریگر:', error.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

// ==================[ راه‌اندازی ]==================
app.use(bot.webhookCallback('/webhook'));

app.get('/', (req, res) => {
  res.send(`
    <h1>🤖 ربات تریگر ${SELF_BOT_ID}</h1>
    <p>ربات فعال است - مالک: ${OWNER_ID}</p>
    <p>ربات قرنطینه: ${QUARANTINE_BOT_URL ? 'متصل' : 'قطع'}</p>
    <p>زمان: ${new Date().toLocaleString('fa-IR')}</p>
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 ربات تریگر ${SELF_BOT_ID} راه‌اندازی شد`);
  console.log(`👤 مالک ربات: ${OWNER_ID}`);
  console.log(`🔗 ربات قرنطینه: ${QUARANTINE_BOT_URL ? 'تنظیم شده' : 'تنظیم نشده'}`);
  console.log(`🌐 پورت: ${PORT}`);
  startAutoPing();
});

if (process.env.RENDER_EXTERNAL_URL) {
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook`;
  bot.telegram.setWebhook(webhookUrl)
    .then(() => console.log('✅ Webhook تریگر تنظیم شد: ' + webhookUrl))
    .catch(error => {
      console.log('❌ خطا در تنظیم Webhook تریگر:', error.message);
      console.log('🔄 راه‌اندازی تریگر با polling...');
      bot.launch();
    });
} else {
  console.log('🔄 راه‌اندازی تریگر با polling...');
  bot.launch();
}

process.on('unhandledRejection', (error) => {
  console.log('❌ خطای catch نشده در تریگر:', error.message);
});

process.on('SIGINT', () => {
  console.log('🛑 دریافت SIGINT - خروج تریگر...');
  bot.stop();
  process.exit();
});

process.on('SIGTERM', () => {
  console.log('🛑 دریافت SIGTERM - خروج تریگر...');
  bot.stop();
  process.exit();
});
