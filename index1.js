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
});

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());

// ==================[ سشن ]==================
bot.use(session({
  defaultSession: () => ({
    settingTrigger: false,
    triggerType: null,
    step: null,
    delay: null,
    chatId: null
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

    // تلاش با مکانیزم retry
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
          ctx.reply(`${emoji} تریگر #${ctx.session.triggerType} تنظیم شد!`);
        } else {
          ctx.reply('❌ خطا در ذخیره تریگر');
        }
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
