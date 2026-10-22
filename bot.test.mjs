/**
 * تست‌های ربات بله با `node --test` (بدون وابستگی خارجی):
 *   npm test
 *
 * API بله و API سایت با fetch جعلی شبیه‌سازی می‌شوند تا منطق پیام‌ها،
 * قرارداد گزارش‌ها و حالت‌های خطا بدون شبکه و توکن واقعی سنجیده شوند.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BUTTONS,
  commandName,
  createBot,
  dateInTehran,
  formatDateTimeFa,
  money,
  normalizeDigits,
  normalizeOrderNumber,
  orderStatusFa,
  parseAllowedBaleIds,
  readConfig,
  unwrapSiteResponse,
} from "./bot.mjs";

const BOT_DIR = fileURLToPath(new URL(".", import.meta.url));

/* ------------------------------------------------------------------ */
/* توابع کمکی خالص                                                     */
/* ------------------------------------------------------------------ */

test("ارقام فارسی و عربی در شماره سفارش به لاتین تبدیل می‌شوند", () => {
  assert.equal(normalizeDigits("ORD-۱۲۳۴"), "ORD-1234");
  assert.equal(normalizeDigits("ORD-١٢٣٤"), "ORD-1234");
  assert.equal(normalizeOrderNumber(" ORD - ۱۲۳ "), "ORD-123");
});

test("واحد پول تومان و ریال درست نمایش داده می‌شود", () => {
  assert.match(money(1500000, "IRT"), /تومان$/);
  assert.match(money(1500000, "IRR"), /ریال$/);
  assert.match(money(10, "USD"), /USD$/);
  assert.equal(money("نامعتبر"), "نامشخص");
});

test("وضعیت سفارش به فارسی ترجمه و ناشناخته دست‌نخورده می‌ماند", () => {
  assert.equal(orderStatusFa("paid"), "پرداخت‌شده");
  assert.equal(orderStatusFa("cancelled"), "لغوشده");
  assert.equal(orderStatusFa("weird"), "weird");
  assert.equal(orderStatusFa(null), "نامشخص");
});

test("شناسه‌های مجاز فقط از اعداد خوانده می‌شوند", () => {
  assert.deepEqual([...parseAllowedBaleIds(" 123, abc ,456,,12a")], ["123", "456"]);
  assert.equal(parseAllowedBaleIds("").size, 0);
  assert.equal(parseAllowedBaleIds(undefined).size, 0);
});

test("نام دستور از متن پیام استخراج می‌شود", () => {
  assert.equal(commandName("/start"), "start");
  assert.equal(commandName("/id@zoppini_bot"), "id");
  assert.equal(commandName("/sales امروز"), "sales");
  assert.equal(commandName("سلام"), null);
});

test("تاریخ «امروز» بر اساس تهران حساب می‌شود", () => {
  // ۲۱ اکتبر ساعت ۲۱ UTC یعنی ۲۲ اکتبر ساعت ۰۰:۳۰ تهران
  assert.equal(dateInTehran(new Date("2026-10-21T21:00:00Z")), "2026-10-22");
  assert.equal(formatDateTimeFa(null), "نامشخص");
  assert.notEqual(formatDateTimeFa("2026-10-21T08:30:00+03:30"), "نامشخص");
});

test("پاکت عمومی پاسخ سایت باز می‌شود و پاسخ خام دست‌نخورده می‌ماند", () => {
  assert.deepEqual(unwrapSiteResponse({ status: 200, message: "success", data: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrapSiteResponse({ a: 1 }), { a: 1 });
  assert.equal(unwrapSiteResponse(null), null);
});

/* ------------------------------------------------------------------ */
/* پردازش پیام‌ها با fetch جعلی                                       */
/* ------------------------------------------------------------------ */

function fakeResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

/** ساخت ربات تستی + ثبت پیام‌های ارسالی و درخواست‌های سایت */
function createTestBot({ siteHandler, allowedIds = "111" } = {}) {
  const sentMessages = [];
  const siteRequests = [];
  const updatesQueue = [];

  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;

    if (url.includes("/sendMessage")) {
      sentMessages.push(body);
      return fakeResponse({ ok: true, result: { message_id: sentMessages.length } });
    }
    if (url.includes("/getMe")) {
      return fakeResponse({ ok: true, result: { id: 999, username: "zoppini_bot" } });
    }
    if (url.includes("/getUpdates")) {
      const updates = updatesQueue.splice(0, updatesQueue.length);
      sentMessages.push({ __getUpdatesBody: body });
      return fakeResponse({ ok: true, result: updates });
    }
    if (url.startsWith("http://site.test/")) {
      siteRequests.push({ url, headers: options.headers });
      return siteHandler(url, options);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const config = readConfig({
    BALE_BOT_TOKEN: "test-bale-token",
    BALE_API_BASE_URL: "http://bale.test",
    ALLOWED_BALE_IDS: allowedIds,
    ZOPPINI_SITE_API_BASE_URL: "http://site.test/api/bot/v1",
    ZOPPINI_BOT_SERVICE_TOKEN: "test-site-token",
    POLLING_TIMEOUT_SECONDS: "1",
  });

  const silentLogger = { log() {}, warn() {}, error() {} };
  const bot = createBot(config, { fetchImpl, logger: silentLogger });

  return { bot, sentMessages, siteRequests, updatesQueue };
}

function privateMessage(text, userId = 111) {
  return {
    message_id: 1,
    text,
    from: { id: userId },
    chat: { id: userId, type: "private" },
  };
}

function lastText(sentMessages) {
  const messages = sentMessages.filter((message) => typeof message.text === "string");
  return messages.at(-1)?.text ?? "";
}

test("/id برای کاربر بدون دسترسی هم کار می‌کند", async () => {
  const { bot, sentMessages } = createTestBot({ siteHandler: async () => fakeResponse({}) });

  await bot.handleMessage(privateMessage("/id", 222));

  assert.match(lastText(sentMessages), /شناسه عددی بله شما:\n222/);
});

test("کاربر بدون دسترسی برای بقیه پیام‌ها رد می‌شود و پیام گروهی نادیده گرفته می‌شود", async () => {
  const { bot, sentMessages } = createTestBot({ siteHandler: async () => fakeResponse({}) });

  await bot.handleMessage(privateMessage("/start", 222));
  assert.match(lastText(sentMessages), /دسترسی این حساب هنوز برای ربات فعال نشده است/);
  assert.equal(sentMessages.at(-1).reply_markup.remove_keyboard, true);

  const before = sentMessages.length;
  await bot.handleMessage({
    message_id: 2,
    text: "/start",
    from: { id: 111 },
    chat: { id: -555, type: "group" },
  });
  assert.equal(sentMessages.length, before);
});

test("گزارش فروش از سایت خوانده و به تومان نمایش داده می‌شود", async () => {
  const { bot, sentMessages, siteRequests } = createTestBot({
    siteHandler: async () =>
      fakeResponse({
        paidOrders: 3,
        grossSales: 1500000,
        refunds: 0,
        netSales: 1500000,
        averageOrderValue: 500000,
        currency: "IRT",
        timezone: "Asia/Tehran",
      }),
  });

  await bot.handleMessage(privateMessage(BUTTONS.sales));

  assert.equal(siteRequests.length, 1);
  assert.match(siteRequests[0].url, /\/reports\/sales\?from=\d{4}-\d{2}-\d{2}&to=/);
  assert.equal(siteRequests[0].headers.authorization, "Bearer test-site-token");
  const text = lastText(sentMessages);
  assert.match(text, /فروش خالص: .* تومان/);
  assert.doesNotMatch(text, /مرجوعی/); // refund صفر است و خطش نمی‌آید
  assert.match(text, /میانگین سفارش/);
});

test("جریان جست‌وجوی سفارش: دکمه، شماره با ارقام فارسی، پاسخ خوانا", async () => {
  const { bot, sentMessages, siteRequests } = createTestBot({
    siteHandler: async () =>
      fakeResponse({
        orderNumber: "ORD-1234",
        status: "paid",
        createdAt: "2026-10-21T10:05:03+03:30",
        currency: "IRT",
        total: 250000,
        items: [{ productName: "کت تک", variant: "مشکی / L", quantity: 1, unitPrice: 250000 }],
      }),
  });

  await bot.handleMessage(privateMessage(BUTTONS.orders));
  assert.match(lastText(sentMessages), /شمارهٔ سفارش را بفرستید/);

  await bot.handleMessage(privateMessage("ORD-۱۲۳۴"));
  assert.ok(siteRequests[0].url.endsWith("/orders/ORD-1234"));
  const text = lastText(sentMessages);
  assert.match(text, /سفارش ORD-1234/);
  assert.match(text, /وضعیت: پرداخت‌شده/);
  assert.match(text, /کت تک — مشکی \/ L/);
  assert.match(text, /مبلغ نهایی: .* تومان/);
});

test("سفارش ناموجود (notFound) پیام «پیدا نشد» می‌دهد، نه جزئیات خالی", async () => {
  const { bot, sentMessages } = createTestBot({
    siteHandler: async () => fakeResponse({ orderNumber: "ORD-9999", notFound: true }),
  });

  await bot.handleMessage(privateMessage(BUTTONS.orders));
  await bot.handleMessage(privateMessage("ORD-9999"));

  assert.match(lastText(sentMessages), /سفارشی با این شماره پیدا نشد/);
});

test("شماره سفارش نامعتبر رد و انتخاب دکمهٔ دیگر ورودی در انتظار را لغو می‌کند", async () => {
  const { bot, sentMessages } = createTestBot({
    siteHandler: async () =>
      fakeResponse({ paidOrders: 0, netSales: 0, currency: "IRT" }),
  });

  await bot.handleMessage(privateMessage(BUTTONS.orders));
  await bot.handleMessage(privateMessage("!!!"));
  assert.match(lastText(sentMessages), /معتبر به نظر نمی‌رسد/);

  await bot.handleMessage(privateMessage(BUTTONS.orders));
  await bot.handleMessage(privateMessage(BUTTONS.sales));
  assert.match(lastText(sentMessages), /فروش امروز/);
});

test("موجودی کم: حالت خالی و بریدن فهرست بلند", async () => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    productName: `محصول ${index + 1}`,
    variant: null,
    sku: null,
    stock: 1,
  }));
  let items = [];
  const { bot, sentMessages } = createTestBot({
    siteHandler: async () => fakeResponse({ threshold: 3, inventorySyncedAt: null, items }),
  });

  await bot.handleMessage(privateMessage(BUTTONS.stock));
  assert.match(lastText(sentMessages), /کالایی با موجودی ۳ یا کمتر پیدا نشد/);

  items = many;
  await bot.handleMessage(privateMessage(BUTTONS.stock));
  assert.match(lastText(sentMessages), /و ۵ مورد دیگر/);
});

test("پاسخ مشتری‌ها حتی داخل پاکت عمومی سایت هم خوانده می‌شود", async () => {
  const { bot, sentMessages } = createTestBot({
    siteHandler: async () =>
      fakeResponse({
        status: 200,
        message: "success",
        data: { newCustomers: 4, repeatCustomers: 1 },
      }),
  });

  await bot.handleMessage(privateMessage(BUTTONS.customers));

  assert.match(lastText(sentMessages), /مشتری جدید: ۴/);
  assert.match(lastText(sentMessages), /مشتری تکراری: ۱/);
});

test("خطای سایت به پیام محترمانه تبدیل می‌شود و ربات نمی‌میرد", async () => {
  const { bot, sentMessages } = createTestBot({
    siteHandler: async () => fakeResponse({}, { ok: false, status: 500 }),
  });

  await bot.handleMessage(privateMessage(BUTTONS.sales));
  assert.match(lastText(sentMessages), /گرفتن گزارش فعلاً انجام نشد/);

  await bot.handleMessage(privateMessage("/start"));
  assert.match(lastText(sentMessages), /به پنل مدیریت Zoppini خوش آمدید/);
});

test("pollOnce آپدیت‌ها را پردازش و offset را جلو می‌برد", async () => {
  const { bot, sentMessages, updatesQueue } = createTestBot({
    siteHandler: async () => fakeResponse({}),
  });

  updatesQueue.push(
    { update_id: 10, message: privateMessage("/start") },
    { update_id: 11, message: privateMessage("/id", 333) },
  );
  await bot.pollOnce();
  await bot.pollOnce();

  const pollBodies = sentMessages
    .filter((message) => message.__getUpdatesBody)
    .map((message) => message.__getUpdatesBody);
  assert.equal(pollBodies[0].offset, 0);
  assert.equal(pollBodies[1].offset, 12);
  assert.match(lastText(sentMessages), /شناسه عددی بله شما:\n333/);
});

/* ------------------------------------------------------------------ */
/* نقطهٔ ورود                                                          */
/* ------------------------------------------------------------------ */

test("بدون BALE_BOT_TOKEN سرویس با خطای پیکربندی و کد ۱ خارج می‌شود", () => {
  const result = spawnSync(process.execPath, ["bot.mjs"], {
    cwd: BOT_DIR,
    env: {},
    encoding: "utf8",
    timeout: 15_000,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /BALE_BOT_TOKEN is missing/);
});
