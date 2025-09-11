import os
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

url: str = os.environ.get("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml3d3V3c25qYmNjZmJxaHJ4aW1iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc1ODEyMDEsImV4cCI6MjA3MzE1NzIwMX0.3qArWnMOVzSkqnt8dQVnLjo2NfMmSkXLF98lLE67smY")
key: str = os.environ.get("sb_publishable_jp6Y8uXFzN8SR3lOEY4wVw_gtgYw-yz")

supabase: Client = create_client(url, key)

def get_trigger_settings(trigger_text: str):
    """دریافت تنظیمات یک تریگر از دیتابیس"""
    response = supabase.table("triggers").select("*").eq("trigger_text", trigger_text).execute()
    if response.data:
        return response.data[0]  # اولین نتیجه را برگردان
    return None

def set_trigger(trigger_text: str, immediate_response: str, delayed_response: str, delay_seconds: int):
    """ذخیره یا به‌روزرسانی تنظیمات یک تریگر در دیتابیس"""
    data = {
        "trigger_text": trigger_text,
        "immediate_response": immediate_response,
        "delayed_response": delayed_response,
        "delay_seconds": delay_seconds
    }
    # از upsert استفاده می‌کنیم تا اگر تریگر وجود داشت آپدیت شود
    response = supabase.table("triggers").upsert(data).execute()
    return response