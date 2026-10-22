const BALE_TOKEN = process.env.BALE_BOT_TOKEN?.trim();
const SITE_API_BASE = process.env.ZOPPINI_SITE_API_BASE_URL?.trim().replace(/\/+$/, "");
const SITE_API_TOKEN = process.env.ZOPPINI_BOT_SERVICE_TOKEN?.trim();
const POLLING_TIMEOUT_SECONDS = Math.max(
  1,
  Math.min(50, Number.parseInt(process.env.POLLING_TIMEOUT_SECONDS ?? "25", 10) || 25),
);

const allowedBaleIds = new Set(
  (process.env.ALLOWED_BALE_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^\d+$/.test(value)),
);

if (!BALE_TOKEN) {
  console.error("Configuration error: BALE_BOT_TOKEN is missing.");
  process.exit(1);
}

const baleApi = `https://tapi.bale.ai/bot${BALE_TOKEN}`;
let nextUpdateOffset = 0;
let stopping = false;
const pendingInput = new Map();

const mainKeyboard = {
  keyboard: [
    [{ text: "📊 فروش" }, { text: "🧾 سفارش‌ها" }],
    [{ text: "📦 موجودی کالا" }, { text: "👥 مشتری‌ها" }],
    [{ text: "🔔 هشدارها" }, { text: "⚙️ تنظیمات" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  one_time_keyboard: false,
  input_field_placeholder: "یک بخش را انتخاب کنید",
};

async function bale(method, payload, signal) {
  const response = await fetch(`${baleApi}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    const error = new Error(`Bale API ${method} failed (${response.status}).`);
    error.retryAfter = result?.parameters?.retry_after;
    throw error;
  }
  return result.result;
}

async function siteGet(path) {
  if (!SITE_API_BASE || !SITE_API_TOKEN) {
    throw new Error("Site report API is not configured yet.");
  }
  const response = await fetch(`${SITE_API_BASE}${path}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${SITE_API_TOKEN}`,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Site report API returned ${response.status}.`);
  return response.json();
}

async function sendMessage(chatId, text, replyMarkup = mainKeyboard) {
  return bale("sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup });
}

function commandName(text) {
  return text.match(/^\/(\w+)(?:@\w+)?(?:\s|$)/)?.[1]?.toLowerCase() ?? null;
}

function isPrivateOneToOne(message) {
  return message.chat?.type === "private" && String(message.chat?.id) === String(message.from?.id);
}

function dateInTehran(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function money(value, currency = "IRR") {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "نامشخص";
  const formatted = new Intl.NumberFormat("fa-IR").format(amount);
  return `${formatted} ${currency === "IRR" ? "ریال" : currency}`;
}

function requireFields(data, fields) {
  return fields.every((field) => data?.[field] !== undefined && data?.[field] !== null);
}

async function showSales(chatId) {
  const today = dateInTehran();
  const report = await siteGet(`/reports/sales?from=${encodeURIComponent(today)}&to=${encodeURIComponent(today)}`);
  if (!requireFields(report, ["paidOrders", "netSales", "currency"])) {
    throw new Error("Sales report response does not match the documented contract.");
  }
  await sendMessage(chatId,
    `📊 فروش امروز (${today})\n` +
    `سفارش‌های پرداخت‌شده: ${new Intl.NumberFormat("fa-IR").format(report.paidOrders)}\n` +
    `فروش خالص: ${money(report.netSales, report.currency)}\n` +
    (report.refunds !== undefined ? `مرجوعی/بازپرداخت: ${money(report.refunds, report.currency)}\n` : "") +
    (report.averageOrderValue !== undefined ? `میانگین سفارش: ${money(report.averageOrderValue, report.currency)}\n` : "") +
    `منطقهٔ زمانی: ${report.timezone ?? "Asia/Tehran"}`);
}

async function showLowStock(chatId) {
  const report = await siteGet("/inventory/low-stock?threshold=3");
  const items = Array.isArray(report?.items) ? report.items : null;
  if (!items) throw new Error("Low-stock response does not match the documented contract.");
  if (items.length === 0) {
    await sendMessage(chatId, `📦 کالایی با موجودی ۳ یا کمتر پیدا نشد.\nآخرین همگام‌سازی: ${report.inventorySyncedAt ?? "نامشخص"}`);
    return;
  }
  const lines = items.slice(0, 25).map((item) =>
    `• ${item.productName}${item.variant ? ` (${item.variant})` : ""}: ${new Intl.NumberFormat("fa-IR").format(item.stock)} عدد`,
  );
  const more = items.length > 25 ? `\nو ${new Intl.NumberFormat("fa-IR").format(items.length - 25)} مورد دیگر…` : "";
  await sendMessage(chatId, `📦 موجودی کم\n${lines.join("\n")}${more}\n\nآخرین همگام‌سازی: ${report.inventorySyncedAt ?? "نامشخص"}`);
}

async function showOrder(chatId, orderNumber) {
  const safeOrderNumber = encodeURIComponent(orderNumber.trim());
  const result = await siteGet(`/orders/${safeOrderNumber}`);
  if (!result?.orderNumber) {
    await sendMessage(chatId, "سفارشی با این شماره پیدا نشد.");
    return;
  }
  const lines = Array.isArray(result.items)
    ? result.items.slice(0, 12).map((item) => `• ${item.productName}${item.variant ? ` — ${item.variant}` : ""} × ${item.quantity}: ${money(item.unitPrice, result.currency)}`)
    : [];
  await sendMessage(chatId,
    `🧾 سفارش ${result.orderNumber}\n` +
    `وضعیت: ${result.status ?? "نامشخص"}\n` +
    `تاریخ: ${result.createdAt ?? "نامشخص"}\n` +
    `${lines.length ? `اقلام:\n${lines.join("\n")}\n` : ""}` +
    `مبلغ نهایی: ${money(result.total, result.currency ?? "IRR")}`);
}

async function showCustomers(chatId) {
  const today = dateInTehran();
  const report = await siteGet(`/reports/customers?from=${encodeURIComponent(today)}&to=${encodeURIComponent(today)}`);
  if (!requireFields(report, ["newCustomers", "repeatCustomers"])) {
    throw new Error("Customer report response does not match the documented contract.");
  }
  await sendMessage(chatId,
    `👥 مشتری‌های امروز (${today})\n` +
    `مشتری جدید: ${new Intl.NumberFormat("fa-IR").format(report.newCustomers)}\n` +
    `مشتری تکراری: ${new Intl.NumberFormat("fa-IR").format(report.repeatCustomers)}`);
}

async function safely(chatId, task) {
  try {
    await task();
  } catch (error) {
    console.error("Report request failed.", error?.message ?? "Unknown error");
    await sendMessage(chatId, "گرفتن گزارش فعلاً انجام نشد. لطفاً کمی بعد دوباره تلاش کنید.");
  }
}

async function handleMessage(message) {
  if (!isPrivateOneToOne(message) || !message.from?.id) return;
  const userId = String(message.from.id);
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const command = commandName(text);

  if (command === "id") {
    await sendMessage(message.chat.id, `شناسه عددی بله شما:\n${userId}\n\nاین شناسه را فقط به مالک ربات بدهید تا دسترسی‌تان را فعال کند.`);
    return;
  }

  if (!allowedBaleIds.has(userId)) {
    await sendMessage(message.chat.id, "⛔ دسترسی این حساب هنوز برای ربات فعال نشده است.", { remove_keyboard: true });
    return;
  }

  if (command === "start" || command === "menu") {
    await sendMessage(message.chat.id, "به پنل مدیریت Zoppini خوش آمدید.\nیک بخش را انتخاب کنید:");
    return;
  }
  if (command === "help") {
    await sendMessage(message.chat.id, "از دکمه‌های پایین صفحه استفاده کنید. برای منوی اصلی /start را بفرستید.");
    return;
  }

  if (pendingInput.get(userId) === "order-number") {
    pendingInput.delete(userId);
    if (!/^[\p{L}\p{N}-]{2,64}$/u.test(text)) {
      await sendMessage(message.chat.id, "شمارهٔ سفارش معتبر به نظر نمی‌رسد. از منو دوباره سفارش‌ها را انتخاب کنید.");
      return;
    }
    await safely(message.chat.id, () => showOrder(message.chat.id, text));
    return;
  }

  if (text === "📊 فروش") return safely(message.chat.id, () => showSales(message.chat.id));
  if (text === "📦 موجودی کالا") return safely(message.chat.id, () => showLowStock(message.chat.id));
  if (text === "🧾 سفارش‌ها") {
    pendingInput.set(userId, "order-number");
    await sendMessage(message.chat.id, "شمارهٔ سفارش را بفرستید:");
    return;
  }
  if (text === "👥 مشتری‌ها") return safely(message.chat.id, () => showCustomers(message.chat.id));
  if (text === "🔔 هشدارها") {
    await sendMessage(message.chat.id, "🔔 هشدارها پس از آماده‌شدن endpoint رویدادها در سایت فعال می‌شوند.");
    return;
  }
  if (text === "⚙️ تنظیمات") {
    await sendMessage(message.chat.id, "⚙️ تنظیمات فعلاً توسط مالک و از تنظیمات امن سرور انجام می‌شود.");
    return;
  }
  await sendMessage(message.chat.id, "برای ادامه یکی از دکمه‌های منو را انتخاب کنید.");
}

async function pollOnce() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), (POLLING_TIMEOUT_SECONDS + 10) * 1000);
  try {
    const updates = await bale("getUpdates", {
      offset: nextUpdateOffset,
      timeout: POLLING_TIMEOUT_SECONDS,
      allowed_updates: ["message"],
    }, controller.signal);
    for (const update of updates) {
      nextUpdateOffset = update.update_id + 1;
      try {
        if (update.message) await handleMessage(update.message);
      } catch (error) {
        console.error("Message handling failed.", error?.message ?? "Unknown error");
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function run() {
  console.log("Zoppini Bale bot is starting in private-chat mode.");
  while (!stopping) {
    try {
      await pollOnce();
    } catch (error) {
      if (stopping) break;
      const retrySeconds = Number.isInteger(error?.retryAfter) ? error.retryAfter : 3;
      console.error(`Bale polling failed; retrying in ${retrySeconds} seconds.`, error?.message ?? "Unknown error");
      await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000));
    }
  }
}

function stop(signal) {
  stopping = true;
  console.log(`Received ${signal}; stopping after the current polling request.`);
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

run().catch((error) => {
  console.error("Bale bot stopped unexpectedly.", error?.message ?? "Unknown error");
  process.exitCode = 1;
});
