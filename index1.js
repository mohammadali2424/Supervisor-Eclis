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

// ==================[ تابع آزادسازی ]==================
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

    const response = await axios.post(apiEndpoint, requestData, { 
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (response.data && response.data.success) {
      console.log(`✅ کاربر ${userId} با موفقیت آزاد شد`);
      return true;
    } else {
      console.log(`❌ خطا در آزادسازی کاربر ${userId}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ خطا در ارتباط با ربات قرنطینه:`, error.message);
    return false;
  }
};

// ==================[ تابع استخراج محتوا - کاملاً اصلاح شده ]==================
const extractMessageContent = (ctx) => {
  let text = '';
  let entities = [];
  
  if (ctx.message.text) {
    text = ctx.message.text;
    entities = ctx.message.entities || [];
  } else if (ctx.message.caption) {
    text = ctx.message.caption;
    entities = ctx.message.caption_entities || [];
  }
  
  return { text, entities };
};

// ==================[ تابع ایجاد فرمت پیام - جدید ]==================
const createFormattedMessage = (text, entities) => {
  if (!entities || entities.length === 0) {
    return { text, parse_mode: undefined };
  }

  // اگر entities داریم، از HTML parse mode استفاده می‌کنیم
  let formattedText = text;
  
  // مرتب کردن entities بر اساس offset به صورت نزولی
  const sortedEntities = [...entities].sort((a, b) => b.offset - a.offset);
  
  // اعمال entities به متن
  sortedEntities.forEach(entity => {
    const { offset, length, type } = entity;
    const start = offset;
    const end = offset + length;
    const entityText = text.substring(start, end);
    
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
    disable_web_page_preview: false // اجازه نمایش پیش‌نمایش لینک
  };
};

// ==================[ تابع handleTrigger - کاملاً اصلاح شده ]==================
const handleTrigger = async (ctx, triggerType) => {
  try {
    if (ctx.chat.type === 'private') return;

    const userName = ctx.from.first_name || 'کاربر';
    const userId = ctx.from.id;
    
    if (triggerType === 'خروج') {
      await ctx.reply(`🧭┊سفر به سلامت ${userName}`, { 
        reply_to_message_id: ctx.message.message_id,
        ...createGlassButton()
      });
      return;
    }
    
    const cacheKey = `trigger_${ctx.chat.id}_${triggerType}`;
    let triggerData = cache.get(cacheKey);
    
    if (!triggerData) {
      try {
        const { data } = await supabase
          .from('triggers')
          .select('delay, delayed_message, message_entities')
          .eq('chat_id', ctx.chat.id)
          .eq('trigger_type', triggerType)
          .single();

        if (data) {
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

    setTimeout(async () => {
  try {
    await ctx.telegram.sendMessage(ctx.chat.id, delayedMessage, {
      reply_to_message_id: ctx.message.message_id,
      ...createGlassButton(),
      disable_web_page_preview: true // این خط را اضافه کنید
    });
    
        await ctx.telegram.sendMessage(ctx.chat.id, formattedMessage.text, messageOptions);
        
        // آزادسازی کاربر بدون نمایش پیام
        console.log(`🕒 تایمر برای کاربر ${userId} به پایان رسید، شروع آزادسازی...`);
        await releaseUserFromQuarantine(userId);
      } catch (error) {
        console.log('❌ خطا در ارسال پیام تأخیری:', error.message);
      }
    }, delay * 1000);
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

// ==================[ پردازش پیام‌ها - کاملاً اصلاح شده ]==================
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

        // استخراج کامل محتوا شامل متن و entities
        const messageContent = extractMessageContent(ctx);
        
        await supabase.from('triggers').insert({
          chat_id: ctx.session.chatId,
          trigger_type: ctx.session.triggerType,
          delay: ctx.session.delay,
          delayed_message: messageContent.text,
          message_entities: messageContent.entities, // ذخیره entities
          updated_at: new Date().toISOString()
        });

        cache.del(`trigger_${ctx.session.chatId}_${ctx.session.triggerType}`);

        const emoji = ctx.session.triggerType === 'ورود' ? '🚪' : 
                     ctx.session.triggerType === 'ماشین' ? '🚗' : '🏍️';
        ctx.reply(`${emoji} تریگر #${ctx.session.triggerType} تنظیم شد!`);
      } catch (error) {
        console.log('خطا در ذخیره:', error);
        ctx.reply('❌ خطا در ذخیره');
      }
      ctx.session.settingTrigger = false;
    }
  } catch (error) {
    console.log('خطا در پردازش پیام:', error.message);
  }
});

// ==================[ API ]==================
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
