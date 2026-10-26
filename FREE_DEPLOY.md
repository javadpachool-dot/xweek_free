# استقرار رایگان xWeek

این نسخه برای اجرای رایگان روی **Render** آماده شده است. دیتابیس روی **Turso** می‌ماند و مدل از **GitHub Models** استفاده می‌کند. هیچ‌کدام کارت بانکی نمی‌خواهند.

## سایت‌هایی که لازم داری

1. **GitHub** — کد و GitHub Models (همین اکانتی که داری)
2. **Turso** — دیتابیس رایگان سازگار با SQLite
3. **Render** — اجرای اپ (Free plan)
4. **UptimeRobot** — بیدار نگه داشتن Render (اختیاری ولی توصیه‌شده)

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

## ۲. GitHub Models

در GitHub یک توکن بساز:

- Settings → Developer settings → Personal access tokens → Fine-grained tokens
- دسترسی **Models: Read-only** را بده

مقدار توکن را بعداً در Render به‌عنوان `OPENAI_API_KEY` بگذار. آن را در چت یا فایل عمومی نگذار.

## ۳. Render

1. در [render.com](https://render.com) با GitHub ثبت‌نام کن (Free، بدون کارت).
2. **New +** → **Blueprint**.
3. ریپوی `javadpachool-dot/xweek` را وصل کن.
4. Render فایل `render.yaml` را می‌خواند. **Apply** را بزن.
5. این مقادیر را پر کن:

```env
OPENAI_API_KEY=<GitHub token>
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
APP_USER=<یک نام کاربری>
APP_PASS=<یک رمز قوی>
```

بقیه مقادیر در `render.yaml` از قبل تنظیم شده‌اند:

```env
OPENAI_BASE_URL=https://models.github.ai/inference
OPENAI_MODEL=openai/gpt-4o-mini
OPENAI_AUTH_SCHEME=bearer
DATABASE_PATH=/tmp/xweek.db
HOST=0.0.0.0
```

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

بعد در اپ یک پیام ساده بفرست. اگر خطای AI داد، در Render → Logs را ببین. اگر GitHub Models سقف روزانه داد، مدل را عوض کن:

```env
OPENAI_MODEL=openai/gpt-4.1-mini
```

## نکته‌های مهم

- داده اصلی در Turso است. فایل `/tmp/xweek.db` روی Render فقط replica موقت است و با هر restart از Turso سینک می‌شود.
- `APP_USER` و `APP_PASS` را حتماً پر کن، وگرنه آدرس عمومی اپ بدون رمز باز می‌شود.
- GitHub Models رایگان حدود ۱۵۰ درخواست در روز می‌دهد. xWeek برای هر پیام ممکن است چند درخواست بزند؛ برای استفاده شخصی معمولاً کافی است.
- اگر Render خواست کارت بدهی، ادامه نده. Free plan آن نباید کارت بخواهد.
- اگر GitHub Models از Render در دسترس نبود، جایگزین رایگان: Groq با `https://api.groq.com/openai/v1` و مدل `llama-3.3-70b-versatile` (اگر در دسترس بود).
