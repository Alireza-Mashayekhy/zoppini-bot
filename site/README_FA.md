# فایل‌های اتصال بک‌اند سایت

این فایل‌ها را برنامه‌نویس در بک‌اند NestJS سایت قرار دهد، نه در Next.js یا کد مرورگر. فایل‌ها یک لایهٔ محافظت‌شده و قرارداد محدود برای گزارش‌ها می‌سازند؛ چون سورس واقعی بک‌اند و امضای متدهای سرویس‌های فروشگاه در اختیار ما نبود، لازم است adapter خواندن داده به سرویس‌های واقعی سفارش/محصول/موجودی وصل شود.

## فایل‌ها

- `bot-service-key.guard.ts`: احراز هویت سرویس‌به‌سرویس با Bearer secret و مقایسهٔ زمان‌ثابت.
- `bot-reports.contract.ts`: قرارداد خروجی مجاز و توابع داده‌خوان.
- `bot-reports.controller.ts`: endpointهای فروش، مشتری، موجودی کم و جست‌وجوی سفارش.

## نصب در پروژه

1. پوشه‌ای مثل `back/src/bot-reports/` بسازید و این سه فایل را آنجا قرار دهید.
2. `ZOPPINI_BOT_SERVICE_TOKEN` را در secret manager یا environment امن backend تنظیم کنید. مقدار قوی و تصادفی بسازید و عین همان را با نام `ZOPPINI_BOT_SERVICE_TOKEN` در environment سرویس ربات بگذارید. این مقدار را در source، git، چت یا لاگ ثبت نکنید.
3. در `AppModule`، `ConfigModule` باید در دسترس باشد. ماژول `BotReportsModule` بسازید و Controller و Guard را ثبت کنید.
4. برای `BOT_REPORTS_READER` یک adapter واقعی بسازید که `OrderService`، `ProductsService` و سرویس مشتری موجود را با متدهای interface بخواند. Entity خام را برنگردانید؛ فقط فیلدهای تعریف‌شده در contract را بسازید.
5. در `main.ts` پروژه پیشوند `/api` وجود دارد؛ مسیرهای نهایی از این رو با `/api/bot/v1/` شروع می‌شوند.
6. محدودیت نرخ را با Throttler موجود پروژه اعمال کنید. HTTPS اجباری باشد. در صورت امکان endpoint را فقط از IP/شبکهٔ سرویس ربات بپذیرید.
7. در خروجی سفارش، نام/تلفن/ایمیل/آدرس مشتری، کد ملی، رمز، دادهٔ خام درگاه، IP و user-agent را نفرستید.

## روش ساخت module

الگوی ثبت provider:

```ts
@Module({
  controllers: [BotReportsController],
  providers: [
    BotServiceKeyGuard,
    ZoppiniBotReportsAdapter,
    { provide: BOT_REPORTS_READER, useExisting: ZoppiniBotReportsAdapter },
  ],
})
export class BotReportsModule {}
```

`ZoppiniBotReportsAdapter` باید `implements BotReportsReader` داشته باشد و متدها را با سرویس‌های فعلی پروژه پیاده کند. این mapping را باید با سورس واقعی و منطق مالی تأیید کرد؛ واحد پول و تعریف درآمد از این گزارش handoff قابل استنتاج قطعی نیست.

## مسیرهای API

```text
GET /api/bot/v1/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD
GET /api/bot/v1/reports/customers?from=YYYY-MM-DD&to=YYYY-MM-DD
GET /api/bot/v1/inventory/low-stock?threshold=3
GET /api/bot/v1/orders/{orderNumber}
```

هر درخواست باید این header را داشته باشد:

```text
Authorization: Bearer <ZOPPINI_BOT_SERVICE_TOKEN>
```

## نکات لازم پیش از production

- تعریف فروش: فقط پرداخت موفق، و نحوهٔ کسر refund و لغو را با صاحب کسب‌وکار قطعی کنید.
- واحد مبلغ: ریال یا تومان را از منطق قطعی فروشگاه تأیید کنید. از تبدیل دوباره جلوگیری کنید.
- موجودی: تعیین کنید کدام فیلد مرجع است (برای مثال `stock` یا موجودی شعبه) و زمان آخرین sync راهکاران را برگردانید.
- زمان: بازهٔ روزانه بر اساس `Asia/Tehran` محاسبه شود.
- در brief مقدار `synchronize: true` برای TypeORM گزارش شده است؛ پیش از هر schema change در production، migration و رفتار TypeORM را بررسی کنید.
- مسیرهای قدیمی `/api/admin/*` مخصوص نشست مدیرند و پاسخ خام‌شان را به ربات ندهید.

## درخواست نمونه از ربات

```http
GET /api/bot/v1/reports/sales?from=2026-10-21&to=2026-10-21
Authorization: Bearer <secret>
Accept: application/json
```
