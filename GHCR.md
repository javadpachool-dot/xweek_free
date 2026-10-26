# ساخت ایمیج رایگان با GitHub Actions

1. یک ریپازیتوری عمومی در GitHub بساز (نام پیشنهادی: `xweek`).
2. محتویات این پوشه را در ریپازیتوری آپلود کن. اگر آپلود پوشه مخفی `.github` سخت بود، فایل `.github/workflows/build.yml` را از طریق «Add file → Create new file» با همین مسیر بساز و محتوایش را کپی کن.
3. به تب **Actions** برو و ورک‌فلو `build-xweek` را اجرا کن.
4. بعد از موفقیت، به **Packages** برو → `xweek` → **Package settings** → **Change visibility** → **Public**.
5. آدرس ایمیج: `ghcr.io/<github-username>/xweek:latest`

نکته: اگر پکیج را Public نکردی، در پنل آروان «رجیستری خصوصی» را روشن کن و نام کاربری GitHub و یک Personal Access Token با دسترسی `read:packages` بده.
