const { Telegraf, session, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');

// ==================[ تنظیمات ]==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;
const OWNER_ID = parseInt(process.env.OWNER_ID) || 0;
const QUARANTINE_BOT_URL = process.env.QUARANTINE_BOT_URL;
const API_SECRET_KEY = process.env.API_SECRET_KEY;
const SELF_BOT_ID = process.env.SELF_BOT_ID || 'trigger_1';

// کش فوق العاده بهینه
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
bot.use(session({
  defaultSession: () => ({
    settingTrigger: false,
    triggerType: null,
    step: null,
    delay: null,
    chatId: null
  })
}));

// ==================[ پینگ هوشمند 13:59 دقیقه ]==================
const startAutoPing = () => {
  if (!process.env.RENDER_EXTERNAL_URL) return;

  const PING_INTERVAL = 13 * 60 * 1000 + 59 * 1000; // دقیقاً 13:59 دقیقه
  const selfUrl = process.env.RENDER_EXTERNAL_URL;

  const performPing = async () => {
    try {
      // استفاده از HEAD برای کاهش Egress
      await axios.head(`${selfUrl}/ping`, { 
        timeout: 5000,
        headers: { 'User-Agent': 'AutoPing' }
      });
    } catch (error) {
      // بدون لاگ برای صرفه‌جویی در Egress
      setTimeout(performPing, 60000); // تلاش مجدد بعد از 1 دقیقه
    }
  };

  // شروع پینگ بعد از 30 ثانیه
  setTimeout(performPing, 30000);
  setInterval(performPing, PING_INTERVAL);
};

app.head('/ping', (req, res) => res.status(200).end());
app.get('/ping', (req, res) => {
  res.status(200).json({ 
    status: 'active', 
    bot: SELF_BOT_ID,
    t: Date.now() // timestamp کوتاه
  });
});

// ==================[ توابع بهینه شده ]==================
const formatTime = (seconds) => {
  if (seconds < 60) return `${seconds} ثانیه`;
  const minutes = Math.floor(seconds / 60);
  return minutes + ' دقیقه';
};

// تابع آزادسازی - فوق بهینه
const releaseUserFromQuarantine = async (userId) => {
  try {
    if (!QUARANTINE_BOT_URL) return false;

    const cacheKey = `release_${userId}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const apiUrl = QUARANTINE_BOT_URL.startsWith('http') ? 
        QUARANTINE_BOT_URL : `https://${QUARANTINE_BOT_URL}`;
      
      // استفاده از داده فشرده
      const response = await axios.post(`${apiUrl}/api/release-user`, {
        u: userId, // userId فشرده
        k: API_SECRET_KEY
      }, { 
        timeout: 8000,
        headers: { 'X-Optimized': '1' }
      });

      const result = !!(response.data && response.data.s);
      cache.set(cacheKey, result, 300); // کش 5 دقیقه
      return result;
    } catch (error) {
      cache.set(cacheKey, false, 60); // کش 1 دقیقه برای خطا
      return false;
    }
  } catch (error) {
    return false;
  }
};

// پردازش تریگر - کاملاً بهینه
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
    
    // کش تریگرها
    const cacheKey = `trigger_${ctx.chat.id}_${triggerType}`;
    let triggerData = cache.get(cacheKey);
    
    if (!triggerData) {
      try {
        const { data } = await supabase
          .from('triggers')
          .select('delay, delayed_message')
          .eq('chat_id', ctx.chat.id)
          .eq('trigger_type', triggerType)
          .single();

        if (data) {
          triggerData = data;
          cache.set(cacheKey, data, 3600); // کش 1 ساعته
        }
      } catch (error) {
        // بدون لاگ
      }
    }

    const delay = triggerData?.delay || 5;
    const delayedMessage = triggerData?.delayed_message || 'عملیات تکمیل شد! ✅';
    const triggerEmoji = triggerType === 'ورود' ? '🎴' : triggerType === 'ماشین' ? '🚗' : '🏍️';
    
    const initialMessage = `${triggerEmoji}┊${userName} وارد منطقه شد\n\n⏳┊زمان: ${formatTime(delay)}`;
    
    await ctx.reply(initialMessage, { 
      reply_to_message_id: ctx.message.message_id,
      ...createGlassButton()
    });

    // تایمر بهینه
    setTimeout(async () => {
      try {
        await ctx.telegram.sendMessage(ctx.chat.id, delayedMessage, {
          reply_to_message_id: ctx.message.message_id,
          ...createGlassButton(),
          disable_web_page_preview: true
        });
        
        // آزادسازی بدون انتظار
        releaseUserFromQuarantine(userId).catch(() => {});
      } catch (error) {
        // بدون لاگ
      }
    }, delay * 1000);
  } catch (error) {
    // فقط خطاهای مهم
  }
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

// ==================[ دستورات ]==================
bot.start((ctx) => ctx.reply('اوپراتور اکلیس 🥷🏻'));

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
    const cacheKey = `status_${ctx.chat.id}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      ctx.reply(cached);
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

    const statusMsg = `🤖 وضعیت:${triggerInfo}`;
    cache.set(cacheKey, statusMsg, 600);
    ctx.reply(statusMsg);
  } catch (error) {
    ctx.reply('❌ خطا');
  }
});

bot.command('off', async (ctx) => {
  try {
    const userId = ctx.from.id;
    if (userId !== OWNER_ID) {
      ctx.reply('❌ فقط مالک');
      return;
    }

    const chatId = ctx.chat.id;
    await supabase.from('triggers').delete().eq('chat_id', chatId);
    
    // پاک کردن کش
    ['ورود', 'ماشین', 'موتور'].forEach(type => {
      cache.del(`trigger_${chatId}_${type}`);
    });
    cache.del(`status_${chatId}`);
    cache.del(`triggers_${chatId}`);

    ctx.reply('✅ ربات غیرفعال شد');
    
    try {
      await ctx.leaveChat();
    } catch (error) {
      // بدون لاگ
    }
  } catch (error) {
    ctx.reply('❌ خطا');
  }
});

// تنظیم تریگر
const setupTrigger = async (ctx, triggerType) => {
  try {
    const userId = ctx.from.id;
    if (userId !== OWNER_ID) {
      ctx.reply('❌ فقط مالک');
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

// پردازش پیام‌ها
bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text;
    
    if (text.includes('#ورود')) await handleTrigger(ctx, 'ورود');
    if (text.includes('#ماشین')) await handleTrigger(ctx, 'ماشین');
    if (text.includes('#موتور')) await handleTrigger(ctx, 'موتور');
    if (text.includes('#خروج')) await handleTrigger(ctx, 'خروج');

    if (!ctx.session.settingTrigger) return;

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

        // پاک کردن کش
        cache.del(`trigger_${ctx.session.chatId}_${ctx.session.triggerType}`);
        cache.del(`status_${ctx.session.chatId}`);
        cache.del(`triggers_${ctx.session.chatId}`);

        const emoji = ctx.session.triggerType === 'ورود' ? '🚪' : 
                     ctx.session.triggerType === 'ماشین' ? '🚗' : '🏍️';
        ctx.reply(`${emoji} تریگر #${ctx.session.triggerType} تنظیم شد!`);
      } catch (error) {
        ctx.reply('❌ خطا در ذخیره');
      }
      ctx.session.settingTrigger = false;
    }
  } catch (error) {
    // بدون لاگ
  }
});

// ==================[ API های سبک ]==================
app.post('/api/release-user', async (req, res) => {
  try {
    const { u: userId, k: secretKey } = req.body;
    
    if (!secretKey || secretKey !== API_SECRET_KEY) {
      return res.status(401).json({ e: 'unauthorized' });
    }
    
    res.status(200).json({ s: true, b: SELF_BOT_ID });
  } catch (error) {
    res.status(500).json({ e: 'error' });
  }
});

// ==================[ راه‌اندازی ]==================
app.use(bot.webhookCallback('/webhook'));
app.get('/', (req, res) => {
  res.send(`🤖 تریگر ${SELF_BOT_ID} فعال`);
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

// مدیریت خطاهای ساکت
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});
