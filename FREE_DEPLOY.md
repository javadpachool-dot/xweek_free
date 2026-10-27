# استقرار رایگان xWeek

این نسخه برای اجرای رایگان روی **Render** آماده شده است. دیتابیس روی **Turso** می‌ماند و مدل از **Groq** استفاده می‌کند. هیچ‌کدام کارت بانکی نمی‌خواهند.

> GitHub Models از ۳۰ ژوئیه ۲۰۲۶ بازنشسته شده و به جای پاسخ JSON، متن `OK` برمی‌گرداند. به همین خاطر از Groq استفاده می‌کنیم.

## سایت‌هایی که لازم داری

1. **GitHub** — نگه‌داری کد (از قبل داری)
2. **Turso** — دیتابیس رایگان سازگار با SQLite
3. **Groq** — کلید AI رایگان، بدون کارت
4. **Render** — اجرای اپ (Free plan)
5. **UptimeRobot** — بیدار نگه داشتن Render (اختیاری ولی توصیه‌شده)

## ۱. دیتابیس Turso

در [turso.tech](https://turso.tech) با GitHub ثبت‌نام کن. بعد در ترمینال:

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup
turso db create xweek
turso db show xweek --url
turso db tokens create xweek --expiration never
```

اگر از قبل روی آروان داده داری و می‌خواهی به Turso منتقل شود، ابتدا فایل `/data/xweek.db` را از کانتینر آروان دانلود کن و به‌جای `turso db create xweek` این را بزن:

```bash
turso db create xweek --from-file ./xweek.db
```

مهم: `turso db create xweek` را **بدون** `--tursodb` بزن تا دیتابیس libSQL ساخته شود. دو مقدار آخر را برای Render نگه دار:

```env
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
```

## ۲. کلید Groq

1. به [console.groq.com/keys](https://console.groq.com/keys) برو.
2. با Google یا GitHub وارد شو.
3. **Create API Key** را بزن و کلید `gsk_...` را کپی کن.

این کلید را بعداً در Render به‌عنوان `OPENAI_API_KEY` بگذار. آن را در چت یا فایل عمومی نگذار.

سقف رایگان: حدود ۳۰ درخواست در دقیقه و ۱۰۰۰ درخواست در روز. هر پیام xWeek ممکن است چند درخواست بزند.

## ۳. Render

1. در [render.com](https://render.com) با GitHub ثبت‌نام کن (Free، بدون کارت).
2. **New +** → **Blueprint**.
3. ریپوی `javadpachool-dot/xweek_free` را وصل کن.
4. Render فایل `render.yaml` را می‌خواند. **Apply** را بزن.
5. این مقادیر را پر کن:

```env
OPENAI_API_KEY=<Groq key: gsk_...>
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
APP_USER=<یک نام کاربری>
APP_PASS=<یک رمز قوی>
```

بقیه مقادیر در `render.yaml` از قبل تنظیم شده‌اند:

```env
OPENAI_BASE_URL=https://api.groq.com/openai/v1
OPENAI_MODEL=openai/gpt-oss-120b
OPENAI_AUTH_SCHEME=bearer
DATABASE_PATH=/tmp/xweek.db
HOST=0.0.0.0
```

> مدل‌های قدیمی `llama-3.3-70b-versatile` و `llama-3.1-8b-instant` در ۱۶ اوت ۲۰۲۶ بازنشسته شدند. اگر خطای ۴۰۴ گرفتی، مقدار `OPENAI_MODEL` را روی `openai/gpt-oss-120b` بگذار (یا `openai/gpt-oss-20b`).

6. بعد از deploy، آدرس `https://xweek-xxxx.onrender.com` را باز کن. با `APP_USER` و `APP_PASS` وارد شو.

## ۴. بیدار نگه داشتن Render

Render Free بعد از ۱۵ دقیقه بی‌کاری خواب می‌رود و اولین درخواست حدود ۱ دقیقه طول می‌کشد. در [UptimeRobot](https://uptimerobot.com) رایگان یک HTTP monitor بساز:

- URL: `https://xweek-xxxx.onrender.com/healthz`
- Interval: 5 یا 10 دقیقه

`/healthz` بدون رمز جواب می‌دهد و برای همین ساخته شده است. ۷۵۰ ساعت رایگان Render برای یک سرویس ۲۴/۷ کافی است.

## ۵. اولین تست

```bash
curl https://xweek-xxxx.onrender.com/healthz
# ok
```

بعد در اپ یک پیام ساده بفرست. اگر خطای AI داد:

- `/api/chat/diagnose` را باز کن؛ `configured`، `model`، `baseURL` و خطای واقعی را نشان می‌دهد.
- برای خطای ۴۰۱ کلید Groq را دوباره بساز.
- برای ۴۲۹ کمی صبر کن؛ کد جدید خودش طبق `Retry-After` دوباره تلاش می‌کند. مدل `openai/gpt-oss-20b` همان سقف ۸۰۰۰ توکن در دقیقه را دارد، پس فقط وقتی مدل ۱۲۰b در دسترس نیست از آن استفاده کن.

```env
OPENAI_MODEL=openai/gpt-oss-20b
```

## نکته‌های مهم

- داده اصلی در Turso است. فایل `/tmp/xweek.db` روی Render فقط replica موقت است و با هر restart از Turso سینک می‌شود.
- `APP_USER` و `APP_PASS` را حتماً پر کن، وگرنه آدرس عمومی اپ بدون رمز باز می‌شود.
- اگر Render خواست کارت بدهی، ادامه نده. Free plan آن نباید کارت بخواهد.
- اگر بعداً خواستی به Arvan AIaaS برگردی، فقط سه متغیر `OPENAI_*` را عوض کن.
- اگر سقف ۸۰۰۰ توکن در دقیقهٔ Groq اذیت می‌کند، جایگزین رایگان با سقف بسیار بالاتر **Gemini 3.5 Flash-Lite** است: ۲۵۰٬۰۰۰ توکن در دقیقه و ۵۰۰ درخواست در روز، بدون کارت. کلید از [AI Studio](https://aistudio.google.com/apikey) و این مقادیر:

```env
OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
OPENAI_MODEL=gemini-3.5-flash-lite
OPENAI_AUTH_SCHEME=bearer
```

- جایگزین دوم: **Mistral Small** با `OPENAI_BASE_URL=https://api.mistral.ai/v1` و `OPENAI_MODEL=mistral-small-latest` (حدود ۱ درخواست در ثانیه و ۵۰۰ هزار توکن در دقیقه؛ ممکن است تأیید شماره بخواهد).
