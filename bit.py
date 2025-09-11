import os
import logging
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters, JobQueue
from dotenv import load_dotenv
from database import get_trigger_settings, set_trigger

# تنظیمات لاگ
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()
TOKEN = os.environ.get("8225223005:AAF21vF7aRFPRcYpEIEbAzmug2MSo39VkhI")
ADMIN_ID = int(os.environ.get("7495437597"))  # آیدی عددی ادمین اصلی

# ------------------ دستورات مدیریتی (فقط برای ادمین) ------------------

async def set_trigger_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """دستور /settrigger برای تنظیم تریگر توسط ادمین"""
    user_id = update.effective_user.id
    if user_id != ADMIN_ID:
        await update.message.reply_text("❌ فقط ادمین اصلی می‌تواند از این دستور استفاده کند.")
        return

    # فرمت دستور: /settrigger #تریگر | پاسخ فوری | پاسخ تاخیری | تاخیر(ثانیه)
    if not context.args:
        await update.message.reply_text("⚠️ فرمت دستور صحیح نیست.\n\nاستفاده: /settrigger #تریگر | پاسخ فوری | پاسخ تاخیری | تاخیر(ثانیه)")
        return

    try:
        # ترکیب تمام آرگومان‌ها و سپس split توسط |
        full_args = " ".join(context.args).split("|")
        if len(full_args) < 4:
            await update.message.reply_text("⚠️ لطفاً تمام بخش‌ها را وارد کنید.\n\nاستفاده: /settrigger #تریگر | پاسخ فوری | پاسخ تاخیری | تاخیر(ثانیه)")
            return

        trigger_text = full_args[0].strip()
        imm_resp = full_args[1].strip()
        del_resp = full_args[2].strip()
        delay_sec = int(full_args[3].strip())

        # ذخیره در دیتابیس
        response = set_trigger(trigger_text, imm_resp, del_resp, delay_sec)
        if response:
            await update.message.reply_text(f"✅ تریگر '{trigger_text}' با موفقیت تنظیم شد!\n\n✅ پاسخ فوری: {imm_resp}\n\n⏳ پاسخ تاخیری ({delay_sec} ثانیه): {del_resp}")
        else:
            await update.message.reply_text("❌ خطایی در ذخیره تریگر رخ داد.")

    except ValueError:
        await update.message.reply_text("❌ مقدار تاخیر باید یک عدد باشد (ثانیه).")
    except Exception as e:
        logger.error(f"Error in set_trigger: {e}")
        await update.message.reply_text("❌ خطای داخلی رخ داد.")

# ------------------ پردازش پیام‌های معمولی برای تشخیص تریگر ------------------

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """پردازش همه پیام‌ها برای بررسی وجود تریگر"""
    user_message = update.message.text
    if not user_message or not user_message.startswith("#"):
        return  # اگر پیام متن نیست یا با # شروع نمی‌شود، کاری نکن

    # بررسی وجود تریگر در دیتابیس
    trigger_settings = get_trigger_settings(user_message)
    if not trigger_settings:
        return  # تریگر پیدا نشد

    # 1. ارسال پاسخ فوری
    await update.message.reply_text(trigger_settings['immediate_response'])

    # 2. برنامه‌ریزی برای ارسال پاسخ تأخیری
    delay = trigger_settings['delay_seconds']
    chat_id = update.effective_chat.id
    context.job_queue.run_once(
        send_delayed_message,
        delay,
        data={
            'chat_id': chat_id,
            'delayed_response': trigger_settings['delayed_response']
        },
        name=f"delayed_msg_{chat_id}_{user_message}"
    )

async def send_delayed_message(context: ContextTypes.DEFAULT_TYPE):
    """تابعی که پس از تاخیر، پیام را می‌فرستد"""
    job_data = context.job.data
    await context.bot.send_message(chat_id=job_data['chat_id'], text=job_data['delayed_response'])

# ------------------ تابع اصلی ------------------

def main():
    """راه‌اندازی ربات"""
    application = Application.builder().token(TOKEN).build()

    # اضافه کردن هندلرها
    application.add_handler(CommandHandler("settrigger", set_trigger_command))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    # شروع ربات
    application.run_polling()
    print("ربات روشن است...")

if __name__ == "__main__":
    main()