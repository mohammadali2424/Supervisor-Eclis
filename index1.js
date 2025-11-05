const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OWNER_ID = parseInt(process.env.OWNER_ID) || 0;
const API_SECRET_KEY = process.env.API_SECRET_KEY;
const SELF_BOT_ID = process.env.SELF_BOT_ID || 'trigger_1';

const cache = new NodeCache({
  stdTTL: 3600, // کش به مدت ۱ ساعت
  checkperiod: 1200, // بررسی کش هر ۲۰ دقیقه
  maxKeys: 2000, // حداکثر تعداد کلیدها
});

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());

// ==================[ دستور /start ]==================
bot.start((ctx) => {
  ctx.reply('نینجا در خدمت شماست 🥷🏻');
});

// ==================[ چک کردن دسترسی مالک ]==================
const checkOwnerAccess = (ctx) => {
  const userId = ctx.from.id;
  if (userId !== OWNER_ID) {
    return {
      hasAccess: false,
      message: '🚫 شما مالک اکلیس نیستی ، حق استفاده از بات این مجموعه رو نداری ، حدتو بدون',
    };
  }
  return { hasAccess: true };
};

// ==================[ تابع پردازش تریگر ]==================
const handleTrigger = async (ctx, triggerType) => {
  try {
    const userId = ctx.from.id;
    const userName = ctx.from.first_name || 'کاربر';

    let initialMessage = '';
    if (triggerType === 'ورود') {
      initialMessage = `${userName} وارد منطقه شد`;
    } else if (triggerType === 'ماشین') {
      initialMessage = `${userName} وارد ماشین شد`;
    } else {
      initialMessage = `${userName} وارد موتور شد`;
    }

    // ارسال پیام اولیه
    await ctx.reply(initialMessage);

    console.log(`🔄 پردازش تریگر ${triggerType} برای کاربر ${userId}`);
  } catch (error) {
    console.log('❌ خطا در پردازش تریگر:', error.message);
  }
};

// ==================[ پردازش دستورات ]==================
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
  const access = checkOwnerAccess(ctx);
  if (!access.hasAccess) {
    ctx.reply(access.message);
    return;
  }

  ctx.reply('🤖 وضعیت: ربات فعال است!');
});

bot.command('off', async (ctx) => {
  const access = checkOwnerAccess(ctx);
  if (!access.hasAccess) {
    ctx.reply(access.message);
    return;
  }

  ctx.reply('❌ ربات غیرفعال شد!');
  // سایر عملیات غیرفعال کردن ربات...
});

// ==================[ پردازش پیام‌ها ]==================
bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text;

    // بررسی اینکه آیا پیام شامل تریگرهاست
    if (text.includes('#ورود')) await handleTrigger(ctx, 'ورود');
    if (text.includes('#ماشین')) await handleTrigger(ctx, 'ماشین');
    if (text.includes('#موتور')) await handleTrigger(ctx, 'موتور');
    if (text.includes('#خروج')) await handleTrigger(ctx, 'خروج');
  } catch (error) {
    console.log('❌ خطا در پردازش پیام:', error.message);
  }
});

// ==================[ ذخیره‌سازی داده‌ها و کاهش درخواست‌ها به Supabase ]==================
const getTriggerData = async (chatId, triggerType) => {
  const cacheKey = `trigger_${chatId}_${triggerType}`;
  const cachedData = cache.get(cacheKey);

  if (cachedData) {
    return cachedData; // اگر داده‌ها از قبل در کش موجود باشد، از کش استفاده می‌شود
  }

  try {
    // اگر داده‌ها در کش نیست، از Supabase می‌خواهیم که آن‌ها را بیاورد
    const { data, error } = await supabase
      .from('triggers')
      .select('*')
      .eq('chat_id', chatId)
      .eq('trigger_type', triggerType)
      .single();

    if (error) {
      console.log(`❌ خطا در دریافت داده از Supabase:`, error.message);
      return null;
    }

    // داده‌ها را در کش ذخیره می‌کنیم برای استفاده بعدی
    cache.set(cacheKey, data, 3600);  // داده‌ها برای ۱ ساعت در کش نگهداری می‌شود
    return data;
  } catch (error) {
    console.log(`❌ خطا در درخواست از Supabase:`, error.message);
    return null;
  }
};

// ==================[ راه‌اندازی سرور ]==================
app.listen(3000, () => {
  console.log(`🚀 ربات تریگر ${SELF_BOT_ID} راه‌اندازی شد`);
  bot.launch();
});
