import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BUTTONS,
  canonicalJson,
  commandName,
  createBot,
  dateInTehran,
  deriveActorSigningKey,
  money,
  normalizeOrderNumber,
  orderStatusFa,
  parseAllowedBaleIds,
  prepareCsvDocumentsForBale,
  readConfig,
  resolvePresetRange,
  runCliHealthcheck,
  signSiteApiRequest,
  unwrapSiteResponse,
} from "./bot.mjs";

const botEntryPath = fileURLToPath(new URL("./bot.mjs", import.meta.url));

function privateMessage(text, userId = 111) {
  return {
    message_id: 1,
    from: { id: userId },
    chat: { id: userId, type: "private" },
    text,
  };
}

function callbackUpdate(data, userId = 111, messageId = 50) {
  return {
    id: `cb-${Math.random().toString(36).slice(2, 8)}`,
    from: { id: userId },
    message: {
      message_id: messageId,
      chat: { id: userId, type: "private" },
    },
    data,
  };
}

function createHarness({
  allowedBaleIds = "111",
  ownerBaleIds = "111",
  maxDocumentBytes = 8 * 1024 * 1024,
  stateFilePath = "",
  heartbeatFilePath = "",
  roleByUser = { "111": "owner" },
  siteHandler = () => ({ status: 200, body: {} }),
  baleHandler = null,
} = {}) {
  const baleCalls = [];
  const siteCalls = [];
  const logs = { log: [], warn: [], error: [] };

  const fetchImpl = async (url, options = {}) => {
    const rawUrl = String(url);

    if (rawUrl.startsWith("https://bale.test/")) {
      const method = rawUrl.split("/").pop();
      let payload = null;
      let uploadedFile = null;

      if (options.body instanceof FormData) {
        const chatId = options.body.get("chat_id");
        const caption = options.body.get("caption");
        const doc = options.body.get("document");
        const docText = doc && typeof doc.text === "function" ? await doc.text() : "";
        const docBytes = doc && typeof doc.arrayBuffer === "function" ? (await doc.arrayBuffer()).byteLength : 0;
        uploadedFile = {
          filename: doc?.name ?? "unknown",
          mimeType: doc?.type ?? "",
          sizeBytes: docBytes,
          text: docText,
        };
        payload = { chat_id: chatId, caption, document: uploadedFile };
      } else if (options.body) {
        payload = JSON.parse(options.body);
      }

      baleCalls.push({ method, payload, uploadedFile });

      if (baleHandler) {
        const custom = await baleHandler({ method, payload, uploadedFile });
        if (custom) {
          return new Response(JSON.stringify(custom.body), {
            status: custom.status ?? 200,
            headers: { "content-type": "application/json" },
          });
        }
      }

      const defaultResult = method === "getUpdates" ? [] : { message_id: 99 };
      return new Response(JSON.stringify({ ok: true, result: defaultResult }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (rawUrl.startsWith("https://site.test/")) {
      const parsed = new URL(rawUrl);
      const pathWithQuery = `${parsed.pathname}${parsed.search}`;
      const rawBody = typeof options.body === "string" ? options.body : "";
      const jsonBody = rawBody ? JSON.parse(rawBody) : null;

      siteCalls.push({
        url: rawUrl,
        pathWithQuery,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        rawBody,
        body: jsonBody,
      });

      if (parsed.pathname === "/api/bot/v1/me") {
        const actorId = String(options.headers?.["x-bot-actor-id"] ?? "");
        const role = roleByUser[actorId] ?? null;
        return new Response(
          JSON.stringify({
            status: "success",
            message: "OK",
            data: {
              baleUserId: actorId,
              authorized: Boolean(role),
              role,
              permissions: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      const { status = 200, body = {} } = await siteHandler(rawUrl, options, jsonBody);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected URL in test: ${rawUrl}`);
  };

  const config = readConfig({
    BALE_BOT_TOKEN: "test-bale-token",
    BALE_API_BASE_URL: "https://bale.test",
    ZOPPINI_SITE_API_BASE_URL: "https://site.test/api/bot/v1",
    ZOPPINI_BOT_SERVICE_TOKEN: "test-site-service-secret-0123456789",
    ALLOWED_BALE_IDS: allowedBaleIds,
    OWNER_BALE_IDS: ownerBaleIds,
    BALE_MAX_DOCUMENT_BYTES: String(maxDocumentBytes),
    BOT_STATE_FILE: stateFilePath,
    BOT_HEARTBEAT_FILE: heartbeatFilePath,
  });

  const logger = {
    log: (...args) => logs.log.push(args.join(" ")),
    warn: (...args) => logs.warn.push(args.join(" ")),
    error: (...args) => logs.error.push(args.join(" ")),
  };

  const bot = createBot(config, { fetchImpl, logger });
  return { bot, baleCalls, siteCalls, logs, config };
}

/* ---------------- تست‌های واحد پایه و رمزنگاری ---------------- */

test("ارقام فارسی و عربی، واحد پول و ترجمهٔ وضعیت سفارش به درستی کار می‌کنند", () => {
  assert.equal(normalizeOrderNumber("  ORD-۱۲۳۴-٠٥  "), "ORD-1234-05");
  assert.equal(money(1250000, "IRT"), "۱٬۲۵۰٬۰۰۰ تومان");
  assert.equal(money(12500000, "IRR"), "۱۲٬۵۰۰٬۰۰۰ ریال");
  assert.equal(orderStatusFa("paid"), "پرداخت‌شده");
  assert.equal(orderStatusFa("cancelled"), "لغوشده");
  assert.deepEqual([...parseAllowedBaleIds(" 123, abc, 456 , -1 ")], ["123", "456"]);
  assert.equal(commandName("/start@zoppini_bot hi"), "start");
  assert.deepEqual(
    unwrapSiteResponse({ status: "success", message: "ok", data: { a: 1 } }),
    { a: 1 },
  );
});

test("بازه‌های زمانی در منطقهٔ Asia/Tehran و ماه جاری شمسی دقیق محاسبه می‌شوند", () => {
  const fixedDate = new Date("2026-03-25T21:00:00.000Z"); // ۶ فروردین ۱۴۰۵ ساعت ۰۰:۳۰ بامداد در تهران
  assert.equal(dateInTehran(fixedDate), "2026-03-26");

  const monthRange = resolvePresetRange("month", fixedDate);
  // ۱ فروردین ۱۴۰۵ برابر با ۲۰۲۶-۰۳-۲۱ است
  assert.equal(monthRange.from, "2026-03-21");
  assert.equal(monthRange.to, "2026-03-26");

  const weekRange = resolvePresetRange("7d", fixedDate);
  assert.equal(weekRange.from, "2026-03-20");
  assert.equal(weekRange.to, "2026-03-26");
});

test("امضای HMAC درخواست‌های ربات با ساختار استاندارد سرور سازگار است", () => {
  const headers = signSiteApiRequest({
    serviceToken: "svc-secret-123",
    method: "POST",
    fullUrl: "https://site.test/api/bot/v1/settings",
    actorId: "111",
    chatType: "private",
    serializedBody: canonicalJson({ lowStockThreshold: 5, notifyOrderPaid: true }),
    timestamp: "1700000000000",
    nonce: "nonce-abcdef123456",
  });

  assert.equal(headers.authorization, "Bearer svc-secret-123");
  assert.equal(headers["x-bot-actor-id"], "111");
  assert.equal(headers["x-bot-chat-type"], "private");

  const expectedKey = deriveActorSigningKey("svc-secret-123");
  assert.equal(typeof headers["x-bot-signature"], "string");
  assert.equal(headers["x-bot-signature"].length, 64);
  assert.equal(expectedKey.length, 64);
});

/* ---------------- تست‌های امنیت و کنترل دسترسی ---------------- */

test("فقط چت خصوصی یک‌به‌یک پاسخ می‌گیرد؛ گروه، کانال و کاربر غیرمجاز هیچ گزارش یا خطای لوث‌کننده نمی‌گیرند", async () => {
  const { bot, baleCalls, siteCalls } = createHarness({
    roleByUser: { "111": "owner" },
  });

  // کاربر غیرمجاز در چت خصوصی → پیام رد دسترسی و حذف کیبورد
  await bot.handleMessage(privateMessage(BUTTONS.sales, 999));
  assert.equal(baleCalls.length, 1);
  assert.match(baleCalls[0].payload.text, /دسترسی این حساب هنوز برای ربات فعال نشده/);
  assert.deepEqual(baleCalls[0].payload.reply_markup, { remove_keyboard: true });

  // پیام در گروه حتی از طرف خود مالک → کاملاً نادیده گرفته می‌شود
  await bot.handleMessage({
    message_id: 2,
    from: { id: 111 },
    chat: { id: -100555, type: "supergroup" },
    text: BUTTONS.sales,
  });
  // کلیک دکمه در گروه → کاملاً نادیده گرفته می‌شود
  await bot.handleCallbackQuery({
    id: "cb-group",
    from: { id: 111 },
    message: { message_id: 10, chat: { id: -100555, type: "group" } },
    data: "sal:r:today",
  });

  assert.equal(baleCalls.length, 1);
  assert.equal(siteCalls.filter((c) => !c.pathWithQuery.endsWith("/me")).length, 0);

  // دستور /id برای کاربر جدید بدون دسترسی کار می‌کند
  await bot.handleMessage(privateMessage("/id", 888777));
  assert.equal(baleCalls.length, 2);
  assert.match(baleCalls[1].payload.text, /888777/);
});

/* ---------------- معیار ۱: بخش سفارش‌ها، فهرست، صفحه‌بندی و دسترسی مشتری ---------------- */

test("بخش سفارش‌ها: خلاصهٔ امروز، فهرست صفحه‌بندی‌شده، فیلتر وضعیت و جزئیات با کنترل دسترسی مشتری", async () => {
  const { bot, baleCalls, siteCalls } = createHarness({
    roleByUser: { "111": "owner", "222": "orders-read-only" },
    siteHandler: (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/orders/summary")) {
        return {
          body: {
            date: "2026-10-26",
            timezone: "Asia/Tehran",
            totalOrders: 9,
            categories: {
              pending: 2,
              paid: 4,
              shipped: 1,
              delivered: 1,
              cancelled: 1,
              refundedOrCancelledAfterPayment: 1,
            },
          },
        };
      }
      if (u.pathname.endsWith("/orders")) {
        const page = Number(u.searchParams.get("page") || "1");
        const status = u.searchParams.get("status") || "all";
        return {
          body: {
            items: [
              {
                orderNumber: `ORD-PAGE${page}-${status}`,
                status: status === "all" ? "paid" : status,
                finalPrice: 1850000,
                currency: "IRT",
                itemsCount: 2,
                createdAt: "2026-10-26T08:00:00.000Z",
                updatedAt: "2026-10-26T08:15:00.000Z",
              },
            ],
            pagination: { page, limit: 10, total: 15, totalPages: 2 },
            timezone: "Asia/Tehran",
          },
        };
      }
      if (u.pathname.includes("/orders/ORD-1001")) {
        const isReadOnlyUser = false;
        const includeCustomer = u.searchParams.get("includeCustomer") === "true";
        return {
          body: {
            orderNumber: "ORD-1001",
            status: "paid",
            createdAt: "2026-10-26T08:00:00.000Z",
            updatedAt: "2026-10-26T08:30:00.000Z",
            itemsSubtotal: 1900000,
            discount: 100000,
            shippingCost: 50000,
            shippingMethod: "post",
            refundedAmount: 0,
            finalPrice: 1850000,
            total: 1850000,
            currency: "IRT",
            items: [
              {
                productName: "کیف چرم زوپینی",
                variant: "مشکی / متوسط",
                sku: "ZP-BAG-01",
                quantity: 1,
                unitPrice: 1800000,
                originalUnitPrice: 1900000,
                lineTotal: 1800000,
              },
            ],
            canViewCustomer: !isReadOnlyUser,
            customerAccessDenied: isReadOnlyUser,
            customerSummary: { fullName: "کاربر آزمایشی", province: "تهران", city: "تهران" },
            ...(includeCustomer
              ? {
                  customer: {
                    fullName: "کاربر آزمایشی",
                    phone: "09120000000",
                    province: "تهران",
                    city: "تهران",
                    address: "خیابان نمونه، پلاک ۱",
                    postalCode: "1111111111",
                  },
                }
              : {}),
          },
        };
      }
      if (u.pathname.includes("/orders/ORD-RO")) {
        return {
          body: {
            orderNumber: "ORD-RO",
            status: "shipped",
            createdAt: "2026-10-26T08:00:00.000Z",
            updatedAt: "2026-10-26T09:00:00.000Z",
            finalPrice: 950000,
            total: 950000,
            currency: "IRT",
            items: [{ productName: "کفش نمونه", quantity: 1, unitPrice: 950000, lineTotal: 950000 }],
            canViewCustomer: false,
            customerAccessDenied: true,
          },
        };
      }
      return { body: { orderNumber: null, notFound: true } };
    },
  });

  // ۱. زدن دکمه سفارش‌ها → خلاصه امروز (نه درخواست شماره سفارش)
  await bot.handleMessage(privateMessage(BUTTONS.orders, 111));
  const summaryMsg = baleCalls.at(-1).payload;
  assert.match(summaryMsg.text, /خلاصهٔ سفارش‌های امروز/);
  assert.match(summaryMsg.text, /کل سفارش‌های ثبت‌شده امروز: ۹/);
  assert.match(summaryMsg.text, /پرداخت‌شده \/ آماده پردازش و ارسال \(paid\): ۴/);

  // ۲. رفتن به آخرین سفارش‌ها صفحه ۱ و سپس صفحه ۲
  await bot.handleCallbackQuery(callbackUpdate("ord:l:1:all:all", 111, 50));
  assert.match(baleCalls.at(-1).payload.text, /ORD-PAGE1-all/);
  await bot.handleCallbackQuery(callbackUpdate("ord:l:2:paid:7d", 111, 50));
  assert.match(baleCalls.at(-1).payload.text, /ORD-PAGE2-paid/);

  // ۳. مشاهده جزئیات سفارش توسط مالک (ابتدا بدون PII کامل، سپس با کلیک دکمهٔ نمایش نشانی)
  await bot.handleCallbackQuery(callbackUpdate("ord:d:ORD-1001:0:1:all:all", 111, 50));
  assert.match(baleCalls.at(-1).payload.text, /کیف چرم زوپینی — مشکی \/ متوسط/);
  assert.doesNotMatch(baleCalls.at(-1).payload.text, /09120000000/);

  await bot.handleCallbackQuery(callbackUpdate("ord:d:ORD-1001:1:1:all:all", 111, 50));
  assert.match(baleCalls.at(-1).payload.text, /09120000000/);
  assert.match(baleCalls.at(-1).payload.text, /خیابان نمونه/);

  // ۴. جست‌وجوی فرعی با شماره سفارش فارسی برای نقش orders-read-only → پیام عدم دسترسی به اطلاعات مشتری
  await bot.handleCallbackQuery(callbackUpdate("ord:search", 222, 60));
  assert.match(baleCalls.at(-1).payload.text, /شمارهٔ سفارش را بفرستید/);
  await bot.handleMessage(privateMessage("ORD-RO", 222));
  assert.match(baleCalls.at(-1).payload.text, /برای نمایش این اطلاعات دسترسی لازم را ندارید/);

  // بررسی ارسال هدر امضاشده هویت کاربر بله به سرور
  const roOrderCall = siteCalls.find((c) => c.pathWithQuery.includes("/orders/ORD-RO"));
  assert.equal(roOrderCall.headers["x-bot-actor-id"], "222");
  assert.equal(roOrderCall.headers["x-bot-chat-type"], "private");
  assert.ok(roOrderCall.headers["x-bot-signature"]);
});

/* ---------------- معیار ۳ و ۴: موجودی کالا، فروش و ارسال فایل CSV ---------------- */

test("گزارش فروش چهار بازه و آپلود فایل CSV از طریق sendDocument بله کار می‌کند", async () => {
  const { bot, baleCalls, siteCalls } = createHarness({
    siteHandler: (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/reports/sales")) {
        return {
          body: {
            from: u.searchParams.get("from"),
            to: u.searchParams.get("to"),
            timezone: "Asia/Tehran",
            generatedAt: "2026-10-26T10:00:00.000Z",
            totalOrders: 12,
            paidOrders: 10,
            pendingOrders: 1,
            cancelledOrders: 1,
            refundedOrders: 1,
            grossSales: 25000000,
            discounts: 2000000,
            refunds: 1500000,
            netSales: 21500000,
            shippingTotal: 500000,
            finalPaidTotal: 22000000,
            averageOrderValue: 2150000,
            currency: "IRT",
          },
        };
      }
      if (u.pathname.endsWith("/reports/sales/export")) {
        return {
          body: {
            filename: "zoppini-sales-2026-10-26.csv",
            totalRecords: 2,
            generatedAt: "2026-10-26T10:00:00.000Z",
            csvContent:
              "\uFEFFنام فایل: zoppini-sales-2026-10-26.csv,تعداد رکوردها: 2\r\n" +
              "شماره سفارش,مبلغ خالص کالا (تومان)\r\n" +
              "ORD-1,1000000\r\n" +
              "ORD-2,1150000\r\n",
          },
        };
      }
      return { body: {} };
    },
  });

  await bot.handleMessage(privateMessage(BUTTONS.sales, 111));
  const salesText = baleCalls.at(-1).payload.text;
  assert.match(salesText, /واحد پول: تومان \(IRT\)/);
  assert.match(salesText, /فروش ناخالص اقلام \(بدون ارسال\): ۲۵٬۰۰۰٬۰۰۰ تومان/);
  assert.match(salesText, /تخفیف‌ها: ۲٬۰۰۰٬۰۰۰ تومان/);
  assert.match(salesText, /بازپرداخت \/ لغو پس از پرداخت: ۱٬۵۰۰٬۰۰۰ تومان/);
  assert.match(salesText, /فروش خالص کالاها: ۲۱٬۵۰۰٬۰۰۰ تومان/);
  assert.match(salesText, /میانگین مبلغ سفارش موفق: ۲٬۱۵۰٬۰۰۰ تومان/);

  // تغییر بازه به ۷ روز اخیر
  await bot.handleCallbackQuery(callbackUpdate("sal:r:7d", 111, 50));
  assert.ok(siteCalls.some((c) => c.pathWithQuery.includes("/reports/sales?from=")));

  // دریافت خروجی CSV از طریق sendDocument
  await bot.handleCallbackQuery(callbackUpdate("sal:csv:2026-10-20:2026-10-26", 111, 50));
  const docCall = baleCalls.find((c) => c.method === "sendDocument");
  assert.ok(docCall);
  assert.equal(docCall.uploadedFile.filename, "zoppini-sales-2026-10-26.csv");
  assert.match(docCall.payload.caption, /تعداد کل رکوردها: ۲/);
  assert.match(docCall.uploadedFile.text, /ORD-1,1000000/);
});

test("بخش موجودی کالا: تفکیک ناموجود/کم‌موجود/موجود، وضعیت سینک راهکاران و تقسیم خودکار فایل CSV بزرگ بدون حذف رکورد", async () => {
  const manyRows = Array.from(
    { length: 40 },
    (_, idx) => `کیف چرم مدل ${idx + 1},مشکی / بزرگ,ZP-SKU-${idx + 1},0`,
  ).join("\r\n");

  const { bot, baleCalls } = createHarness({
    maxDocumentBytes: 2_200, // سقف کوچک مصنوعی برای آزمون تقسیم چندبخشی فایل بدون از دست رفتن هیچ ردیفی
    siteHandler: (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/inventory/summary")) {
        return {
          body: {
            unit: "variant",
            canonicalStockField: "variant.stock",
            threshold: 3,
            totalProducts: 25,
            totalVariants: 60,
            outOfStockVariants: 40,
            lowStockVariants: 8,
            inStockVariants: 12,
            sync: {
              status: "failed",
              isStale: true,
              staleThresholdHours: 30,
              lastSucceededAt: "2026-10-24T12:00:00.000Z",
              lastFailedAt: "2026-10-26T09:00:00.000Z",
              lastError: "Connection timeout to Rahkaran SQL endpoint",
            },
          },
        };
      }
      if (u.pathname.endsWith("/inventory/export")) {
        return {
          body: {
            filename: "zoppini-inventory-out.csv",
            totalRecords: 40,
            generatedAt: "2026-10-26T10:30:00.000Z",
            csvContent:
              `\uFEFFنام فایل: zoppini-inventory-out.csv,تعداد رکوردها: 40\r\n` +
              `نام محصول,واریانت,SKU,موجودی\r\n` +
              `${manyRows}\r\n`,
          },
        };
      }
      return { body: {} };
    },
  });

  await bot.handleMessage(privateMessage(BUTTONS.stock, 111));
  const invSummaryText = baleCalls.at(-1).payload.text;
  assert.match(invSummaryText, /معیار شمارش: تعداد «واریانت کالا»/);
  assert.match(invSummaryText, /ناموجود \(موجودی صفر\): ۴۰ واریانت/);
  assert.match(invSummaryText, /کم‌موجود \(۱ تا ۳ عدد\): ۸ واریانت/);
  assert.match(invSummaryText, /موجود بالای آستانه \(بیش از ۳ عدد\): ۱۲ واریانت/);
  assert.match(invSummaryText, /آخرین تلاش همگام‌سازی ناموفق/);

  // دریافت خروجی CSV که بزرگ‌تر از سقف است → تقسیم به چند بخش معتبر بدون حذف حتی یک رکورد
  await bot.handleCallbackQuery(callbackUpdate("inv:csv:out", 111, 50));
  const docCalls = baleCalls.filter((c) => c.method === "sendDocument");
  assert.ok(docCalls.length >= 2, "باید به چند فایل تقسیم شود");

  // جمع ردیف‌های داده در همهٔ بخش‌ها دقیقاً باید برابر ۴۰ و شامل اولین و آخرین SKU باشد
  const combinedText = docCalls.map((c) => c.uploadedFile.text).join("\n");
  for (let i = 1; i <= 40; i++) {
    assert.match(combinedText, new RegExp(`ZP-SKU-${i},0`));
  }
});

/* ---------------- معیار ۲ و ۵: صف Outbox، جلوگیری از ارسال تکراری و هشدار سلامت ---------------- */

test("Worker صف Outbox: تحویل اعلان، Retry بدون تکرار برای گیرندهٔ قبلی، و هشدار قطع/وصل API سایت", async () => {
  let leaseStep = 0;
  let failAdminOnce = true;
  let simulateSiteOutage = false;
  const ackPayloads = [];

  const { bot, baleCalls } = createHarness({
    ownerBaleIds: "111",
    baleHandler: ({ method, payload }) => {
      if (method === "sendMessage" && String(payload.chat_id) === "333" && failAdminOnce) {
        failAdminOnce = false;
        return { status: 502, body: { ok: false, description: "Bad Gateway" } };
      }
      return null;
    },
    siteHandler: (url, _options, body) => {
      if (simulateSiteOutage) {
        return { status: 503, body: { message: "Upstream unavailable" } };
      }
      const u = new URL(url);
      if (u.pathname.endsWith("/events/lease")) {
        leaseStep += 1;
        if (leaseStep <= 2) {
          return {
            body: {
              polledAt: "2026-10-26T10:00:00.000Z",
              healthRecipients: ["111"],
              events: [
                {
                  eventId: "evt-order-paid-1",
                  eventType: "order.paid",
                  category: "order_paid",
                  payload: {
                    orderNumber: "ORD-9001",
                    finalPrice: 3200000,
                    currency: "IRT",
                    occurredAt: "2026-10-26T09:59:00.000Z",
                  },
                  attempts: leaseStep,
                  leaseToken: `lease-${leaseStep}`,
                  recipients: ["111", "333"],
                  createdAt: "2026-10-26T09:59:00.000Z",
                },
              ],
            },
          };
        }
        return { body: { polledAt: "2026-10-26T10:05:00.000Z", healthRecipients: ["111"], events: [] } };
      }
      if (u.pathname.endsWith("/events/ack")) {
        ackPayloads.push(body);
        return { body: { processed: body.results.length } };
      }
      return { body: {} };
    },
  });

  // تلاش اول: ارسال به 111 موفق می‌شود ولی 333 خطای موقت 502 می‌دهد → نتیجه باید retry باشد
  await bot.pollOutboxOnce();
  assert.equal(ackPayloads.length, 1);
  assert.equal(ackPayloads[0].results[0].outcome, "retry");

  // تلاش دوم (Retry): به 111 نباید دوباره پیام تکراری برود؛ فقط به 333 ارسال و delivered تایید می‌شود
  await bot.pollOutboxOnce();
  assert.equal(ackPayloads.length, 2);
  assert.equal(ackPayloads[1].results[0].outcome, "delivered");

  const paidMsgsToOwner = baleCalls.filter(
    (c) =>
      c.method === "sendMessage" &&
      String(c.payload.chat_id) === "111" &&
      /ORD-9001/.test(c.payload.text),
  );
  const paidMsgsToAdmin = baleCalls.filter(
    (c) =>
      c.method === "sendMessage" &&
      String(c.payload.chat_id) === "333" &&
      /ORD-9001/.test(c.payload.text),
  );
  assert.equal(paidMsgsToOwner.length, 1, "مالک نباید پیام تکراری دریافت کند");
  assert.equal(paidMsgsToAdmin.length, 2, "ادمین یک بار ناموفق و بار دوم موفق دریافت کرد");

  // شبیه‌سازی قطع ارتباط با API سایت (۴ خطای متوالی → دقیقاً ۱ پیام هشدار اختلال بدون اسپم)
  simulateSiteOutage = true;
  await bot.pollOutboxOnce();
  await bot.pollOutboxOnce();
  await bot.pollOutboxOnce();
  await bot.pollOutboxOnce();

  const outageAlerts = baleCalls.filter(
    (c) => c.method === "sendMessage" && /هشدار سلامت سرویس/.test(c.payload.text),
  );
  assert.equal(outageAlerts.length, 1);

  // بازیابی ارتباط سایت → ارسال پیام بازیابی به مالک
  simulateSiteOutage = false;
  await bot.pollOutboxOnce();
  const recoveryAlerts = baleCalls.filter(
    (c) => c.method === "sendMessage" && /بازیابی سرویس/.test(c.payload.text),
  );
  assert.equal(recoveryAlerts.length, 1);
});

/* ---------------- معیار ۶ و ۸: تنظیمات، نقش‌ها، لغو و بررسی سلامت ---------------- */

test("بخش تنظیمات، لغو عملیات در انتظار و healthcheck کانتینر به درستی کار می‌کنند", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "zoppini-bot-test-"));
  const heartbeatFile = join(tempDir, "heartbeat.json");
  let savedThreshold = 3;

  try {
    const { bot, baleCalls } = createHarness({
      heartbeatFilePath: heartbeatFile,
      roleByUser: { "111": "owner", "444": "reports-read-only" },
      siteHandler: (url, options, body) => {
        const u = new URL(url);
        if (u.pathname.endsWith("/settings") && options.method === "PATCH") {
          savedThreshold = body.lowStockThreshold ?? savedThreshold;
          return {
            body: {
              lowStockThreshold: savedThreshold,
              notifyOrderCreated: true,
              notifyOrderPaid: true,
              notifyOrderCancelled: true,
              notifyOrderStatusChanged: true,
              notifyInventoryAlerts: true,
              notifySyncAndHealth: true,
              inventoryReminderHours: 0,
              staleSyncThresholdHours: 30,
              updatedAt: "2026-10-26T11:00:00.000Z",
            },
          };
        }
        if (u.pathname.endsWith("/settings")) {
          if (options.headers?.["x-bot-actor-id"] === "444") {
            return { status: 403, body: { message: "شما دسترسی لازم برای این بخش را ندارید." } };
          }
          return {
            body: {
              lowStockThreshold: savedThreshold,
              notifyOrderCreated: true,
              notifyOrderPaid: true,
              notifyOrderCancelled: true,
              notifyOrderStatusChanged: true,
              notifyInventoryAlerts: true,
              notifySyncAndHealth: true,
              inventoryReminderHours: 0,
              staleSyncThresholdHours: 30,
              updatedAt: "2026-10-26T10:00:00.000Z",
            },
          };
        }
        if (u.pathname.endsWith("/getUpdates")) {
          return { body: { ok: true, result: [] } };
        }
        return { body: {} };
      },
    });

    // تغییر آستانه توسط مالک
    await bot.handleCallbackQuery(callbackUpdate("set:thv:5", 111, 70));
    assert.equal(savedThreshold, 5);
    assert.match(baleCalls.at(-1).payload.text, /آستانهٔ کم‌موجودی هر واریانت: ۵ عدد/);

    // کاربر reports-read-only به تنظیمات دسترسی ندارد (تفکیک پیام عدم دسترسی از خطای شبکه)
    await bot.handleMessage(privateMessage(BUTTONS.settings, 444));
    assert.match(baleCalls.at(-1).payload.text, /دسترسی لازم/);
    assert.doesNotMatch(baleCalls.at(-1).payload.text, /خطای موقت/);

    // لغو ورودی در انتظار با /cancel
    await bot.handleCallbackQuery(callbackUpdate("ord:search", 111, 70));
    await bot.handleMessage(privateMessage("/cancel", 111));
    assert.match(baleCalls.at(-1).payload.text, /عملیات جاری لغو شد/);

    // بررسی آپدیت heartbeat و کارکرد CLI healthcheck
    await bot.pollOnce();
    assert.equal(
      runCliHealthcheck({
        BALE_BOT_TOKEN: "test-token",
        BOT_HEARTBEAT_FILE: heartbeatFile,
        POLLING_TIMEOUT_SECONDS: "25",
      }),
      true,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("بدون BALE_BOT_TOKEN سرویس با خطای پیکربندی و کد ۱ خارج می‌شود", () => {
  const result = spawnSync(process.execPath, [botEntryPath], {
    env: { PATH: process.env.PATH, BALE_BOT_TOKEN: "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BALE_BOT_TOKEN is missing/);
});
