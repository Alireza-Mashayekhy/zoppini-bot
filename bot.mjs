/**
 * ربات مدیریتی Zoppini روی پیام‌رسان بله (Bale).
 *
 * معماری:
 *   بله ← HTTPS polling ← این سرویس
 *   این سرویس ← HTTPS + service token ← API فقط‌خواندنی سایت (NestJS: ‎/api/bot/v1‎)
 *
 * ربات مستقیم به دیتابیس وصل نمی‌شود. توکن بله فقط برای API بله و service token
 * فقط برای API محدود سایت است. راهنمای کامل: README_FA.md همین پوشه.
 *
 * بدون هیچ وابستگی خارجی؛ فقط Node.js 22+ لازم است.
 */
import { pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ */
/* ثابت‌ها و متن‌های رابط کاربری                                       */
/* ------------------------------------------------------------------ */

export const BUTTONS = {
  sales: "📊 فروش",
  orders: "🧾 سفارش‌ها",
  stock: "📦 موجودی کالا",
  customers: "👥 مشتری‌ها",
  alerts: "🔔 هشدارها",
  settings: "⚙️ تنظیمات",
};

const mainKeyboard = {
  keyboard: [
    [{ text: BUTTONS.sales }, { text: BUTTONS.orders }],
    [{ text: BUTTONS.stock }, { text: BUTTONS.customers }],
    [{ text: BUTTONS.alerts }, { text: BUTTONS.settings }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  one_time_keyboard: false,
  input_field_placeholder: "یک بخش را انتخاب کنید",
};

/** برچسب فارسی وضعیت‌های سفارش سایت؛ وضعیت ناشناخته همان مقدار خام نمایش داده می‌شود */
const ORDER_STATUS_FA = {
  pending: "در انتظار پرداخت",
  paid: "پرداخت‌شده",
  shipped: "ارسال‌شده",
  delivered: "تحویل‌شده",
  cancelled: "لغوشده",
};

/** مهلت پاسخ به «شمارهٔ سفارش را بفرستید» */
const PENDING_INPUT_TTL_MS = 5 * 60 * 1000;

const SITE_API_TIMEOUT_MS = 12_000;

/* ------------------------------------------------------------------ */
/* توابع کمکی خالص (قابل تست)                                          */
/* ------------------------------------------------------------------ */

export function parseAllowedBaleIds(rawValue) {
  return new Set(
    String(rawValue ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => /^\d+$/.test(value)),
  );
}

/** تبدیل ارقام فارسی/عربی به لاتین؛ کاربران شماره سفارش را اغلب با کیبورد فارسی می‌فرستند */
export function normalizeDigits(value) {
  return String(value ?? "")
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

export function normalizeOrderNumber(value) {
  return normalizeDigits(value).replace(/\s+/g, "").trim();
}

export function formatNumberFa(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat("fa-IR").format(number)
    : "نامشخص";
}

/** مبالغ سایت به تومان ذخیره می‌شوند (`IRT`)؛ `IRR` هم برای سازگاری پشتیبانی می‌شود */
export function money(value, currency = "IRT") {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "نامشخص";
  const formatted = new Intl.NumberFormat("fa-IR").format(amount);
  const unit = currency === "IRT" ? "تومان" : currency === "IRR" ? "ریال" : currency;
  return `${formatted} ${unit}`;
}

export function orderStatusFa(status) {
  return ORDER_STATUS_FA[String(status ?? "").toLowerCase()] ?? status ?? "نامشخص";
}

export function dateInTehran(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** نمایش خوانای تاریخ ISO به وقت تهران؛ اگر ورودی نامفهوم بود همان رشته برگردانده می‌شود */
export function formatDateTimeFa(value) {
  if (!value) return "نامشخص";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/**
 * بک‌اند سایت برای این مسیرها پاسخ خام (بدون پاکت) برمی‌گرداند؛ اما اگر روزی
 * پاسخ داخل پاکت عمومی `{ status, message, data }` پیچیده شود، ربات همچنان
 * کار کند و خراب نشود.
 */
export function unwrapSiteResponse(payload) {
  if (
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    "status" in payload &&
    "message" in payload
  ) {
    return payload.data;
  }
  return payload;
}

export function commandName(text) {
  return text.match(/^\/(\w+)(?:@\w+)?(?:\s|$)/)?.[1]?.toLowerCase() ?? null;
}

export function isPrivateOneToOne(message) {
  return (
    message.chat?.type === "private" &&
    String(message.chat?.id) === String(message.from?.id)
  );
}

function requireFields(data, fields) {
  return fields.every((field) => data?.[field] !== undefined && data?.[field] !== null);
}

/* ------------------------------------------------------------------ */
/* خواندن تنظیمات از محیط                                              */
/* ------------------------------------------------------------------ */

export function readConfig(env = process.env) {
  return {
    baleToken: env.BALE_BOT_TOKEN?.trim() || "",
    baleApiBase: (env.BALE_API_BASE_URL?.trim() || "https://tapi.bale.ai").replace(/\/+$/, ""),
    siteApiBase: env.ZOPPINI_SITE_API_BASE_URL?.trim().replace(/\/+$/, "") || "",
    siteApiToken: env.ZOPPINI_BOT_SERVICE_TOKEN?.trim() || "",
    allowedBaleIds: parseAllowedBaleIds(env.ALLOWED_BALE_IDS),
    pollingTimeoutSeconds: Math.max(
      1,
      Math.min(50, Number.parseInt(env.POLLING_TIMEOUT_SECONDS ?? "25", 10) || 25),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* بدنهٔ ربات                                                          */
/* ------------------------------------------------------------------ */

export function createBot(config, { fetchImpl = fetch, logger = console } = {}) {
  const baleApi = `${config.baleApiBase}/bot${config.baleToken}`;
  const allowedBaleIds = config.allowedBaleIds ?? new Set();

  let nextUpdateOffset = 0;
  let stopping = false;
  let activePollController = null;
  const pendingInput = new Map(); // userId -> { kind, expiresAt }

  async function bale(method, payload, signal) {
    const response = await fetchImpl(`${baleApi}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
      const error = new Error(`Bale API ${method} failed (${response.status}).`);
      error.status = response.status;
      error.retryAfter = result?.parameters?.retry_after;
      throw error;
    }
    return result.result;
  }

  async function siteGet(path) {
    if (!config.siteApiBase || !config.siteApiToken) {
      throw new Error("Site report API is not configured yet.");
    }
    const response = await fetchImpl(`${config.siteApiBase}${path}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${config.siteApiToken}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(SITE_API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Site report API returned ${response.status}.`);
    return unwrapSiteResponse(await response.json());
  }

  async function sendMessage(chatId, text, replyMarkup = mainKeyboard) {
    return bale("sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup });
  }

  /* ------------------------------ گزارش‌ها ------------------------------ */

  async function showSales(chatId) {
    const today = dateInTehran();
    const report = await siteGet(
      `/reports/sales?from=${encodeURIComponent(today)}&to=${encodeURIComponent(today)}`,
    );
    if (!requireFields(report, ["paidOrders", "netSales", "currency"])) {
      throw new Error("Sales report response does not match the documented contract.");
    }
    const paidOrders = Number(report.paidOrders) || 0;
    await sendMessage(
      chatId,
      `📊 فروش امروز (${today})\n` +
        `سفارش‌های پرداخت‌شده: ${formatNumberFa(paidOrders)}\n` +
        `فروش خالص: ${money(report.netSales, report.currency)}\n` +
        (Number(report.refunds) > 0
          ? `مرجوعی/بازپرداخت: ${money(report.refunds, report.currency)}\n`
          : "") +
        (paidOrders > 0 && report.averageOrderValue !== undefined
          ? `میانگین سفارش: ${money(report.averageOrderValue, report.currency)}\n`
          : "") +
        `منطقهٔ زمانی: ${report.timezone ?? "Asia/Tehran"}`,
    );
  }

  async function showLowStock(chatId) {
    const report = await siteGet("/inventory/low-stock?threshold=3");
    const items = Array.isArray(report?.items) ? report.items : null;
    if (!items) throw new Error("Low-stock response does not match the documented contract.");
    const syncedAt = formatDateTimeFa(report.inventorySyncedAt);
    if (items.length === 0) {
      await sendMessage(chatId, `📦 کالایی با موجودی ۳ یا کمتر پیدا نشد.\nآخرین همگام‌سازی: ${syncedAt}`);
      return;
    }
    const lines = items
      .slice(0, 25)
      .map(
        (item) =>
          `• ${item.productName}${item.variant ? ` (${item.variant})` : ""}: ${formatNumberFa(item.stock)} عدد`,
      );
    const more = items.length > 25 ? `\nو ${formatNumberFa(items.length - 25)} مورد دیگر…` : "";
    await sendMessage(chatId, `📦 موجودی کم\n${lines.join("\n")}${more}\n\nآخرین همگام‌سازی: ${syncedAt}`);
  }

  async function showOrder(chatId, orderNumber) {
    const safeOrderNumber = encodeURIComponent(orderNumber);
    const result = await siteGet(`/orders/${safeOrderNumber}`);
    // بک‌اند برای «پیدا نشد» پاسخ ۲۰۰ با `notFound: true` می‌دهد (نه خطا)
    if (!result?.orderNumber || result.notFound) {
      await sendMessage(chatId, "سفارشی با این شماره پیدا نشد.");
      return;
    }
    const lines = Array.isArray(result.items)
      ? result.items
          .slice(0, 12)
          .map(
            (item) =>
              `• ${item.productName}${item.variant ? ` — ${item.variant}` : ""} × ${formatNumberFa(item.quantity)}: ${money(item.unitPrice, result.currency)}`,
          )
      : [];
    await sendMessage(
      chatId,
      `🧾 سفارش ${result.orderNumber}\n` +
        `وضعیت: ${orderStatusFa(result.status)}\n` +
        `تاریخ: ${formatDateTimeFa(result.createdAt)}\n` +
        `${lines.length ? `اقلام:\n${lines.join("\n")}\n` : ""}` +
        `مبلغ نهایی: ${money(result.total, result.currency ?? "IRT")}`,
    );
  }

  async function showCustomers(chatId) {
    const today = dateInTehran();
    const report = await siteGet(
      `/reports/customers?from=${encodeURIComponent(today)}&to=${encodeURIComponent(today)}`,
    );
    if (!requireFields(report, ["newCustomers", "repeatCustomers"])) {
      throw new Error("Customer report response does not match the documented contract.");
    }
    await sendMessage(
      chatId,
      `👥 مشتری‌های امروز (${today})\n` +
        `مشتری جدید: ${formatNumberFa(report.newCustomers)}\n` +
        `مشتری تکراری: ${formatNumberFa(report.repeatCustomers)}`,
    );
  }

  async function safely(chatId, task) {
    try {
      await task();
    } catch (error) {
      logger.error("Report request failed.", error?.message ?? "Unknown error");
      try {
        await sendMessage(chatId, "گرفتن گزارش فعلاً انجام نشد. لطفاً کمی بعد دوباره تلاش کنید.");
      } catch (sendError) {
        logger.error("Sending the error message failed too.", sendError?.message ?? "Unknown error");
      }
    }
  }

  /* --------------------------- پردازش پیام‌ها --------------------------- */

  function takePendingInput(userId) {
    const pending = pendingInput.get(userId);
    if (!pending) return null;
    pendingInput.delete(userId);
    return Date.now() <= pending.expiresAt ? pending.kind : null;
  }

  async function handleMessage(message) {
    if (!isPrivateOneToOne(message) || !message.from?.id) return;
    const userId = String(message.from.id);
    const chatId = message.chat.id;
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const command = commandName(text);

    // /id برای همه آزاد است تا مدیر تازه بتواند شناسه‌اش را برای فعال‌سازی بفرستد
    if (command === "id") {
      await sendMessage(
        chatId,
        `شناسه عددی بله شما:\n${userId}\n\nاین شناسه را فقط به مالک ربات بدهید تا دسترسی‌تان را فعال کند.`,
      );
      return;
    }

    if (!allowedBaleIds.has(userId)) {
      await sendMessage(chatId, "⛔ دسترسی این حساب هنوز برای ربات فعال نشده است.", {
        remove_keyboard: true,
      });
      return;
    }

    if (command === "cancel") {
      pendingInput.delete(userId);
      await sendMessage(chatId, "لغو شد. یک بخش را از منو انتخاب کنید:");
      return;
    }
    if (command === "start" || command === "menu") {
      pendingInput.delete(userId);
      await sendMessage(chatId, "به پنل مدیریت Zoppini خوش آمدید.\nیک بخش را انتخاب کنید:");
      return;
    }
    if (command === "help") {
      await sendMessage(
        chatId,
        "از دکمه‌های پایین صفحه استفاده کنید.\n" +
          "دستورها: /start منو، /sales فروش امروز، /stock موجودی کم، /orders جست‌وجوی سفارش، /customers مشتری‌های امروز، /id شناسهٔ بلهٔ شما",
      );
      return;
    }

    // دکمه‌های منو و معادل دستوری‌شان؛ انتخاب هرکدام ورودیِ در انتظار را لغو می‌کند
    if (text === BUTTONS.sales || command === "sales") {
      pendingInput.delete(userId);
      return safely(chatId, () => showSales(chatId));
    }
    if (text === BUTTONS.stock || command === "stock") {
      pendingInput.delete(userId);
      return safely(chatId, () => showLowStock(chatId));
    }
    if (text === BUTTONS.customers || command === "customers") {
      pendingInput.delete(userId);
      return safely(chatId, () => showCustomers(chatId));
    }
    if (text === BUTTONS.orders || command === "orders") {
      pendingInput.set(userId, { kind: "order-number", expiresAt: Date.now() + PENDING_INPUT_TTL_MS });
      await sendMessage(chatId, "شمارهٔ سفارش را بفرستید: (برای لغو /cancel)");
      return;
    }
    if (text === BUTTONS.alerts) {
      await sendMessage(chatId, "🔔 هشدارها پس از آماده‌شدن endpoint رویدادها در سایت فعال می‌شوند.");
      return;
    }
    if (text === BUTTONS.settings) {
      await sendMessage(chatId, "⚙️ تنظیمات فعلاً توسط مالک و از تنظیمات امن سرور انجام می‌شود.");
      return;
    }

    if (takePendingInput(userId) === "order-number") {
      const orderNumber = normalizeOrderNumber(text);
      if (!/^[\p{L}\p{N}-]{2,64}$/u.test(orderNumber)) {
        await sendMessage(chatId, "شمارهٔ سفارش معتبر به نظر نمی‌رسد. از منو دوباره سفارش‌ها را انتخاب کنید.");
        return;
      }
      await safely(chatId, () => showOrder(chatId, orderNumber));
      return;
    }

    await sendMessage(chatId, "برای ادامه یکی از دکمه‌های منو را انتخاب کنید.");
  }

  /* ------------------------------- polling ------------------------------ */

  async function pollOnce() {
    const controller = new AbortController();
    activePollController = controller;
    const timeout = setTimeout(
      () => controller.abort(),
      (config.pollingTimeoutSeconds + 10) * 1000,
    );
    try {
      const updates = await bale(
        "getUpdates",
        {
          offset: nextUpdateOffset,
          timeout: config.pollingTimeoutSeconds,
          allowed_updates: ["message"],
        },
        controller.signal,
      );
      for (const update of updates) {
        nextUpdateOffset = update.update_id + 1;
        try {
          if (update.message) await handleMessage(update.message);
        } catch (error) {
          logger.error("Message handling failed.", error?.message ?? "Unknown error");
        }
      }
    } finally {
      clearTimeout(timeout);
      if (activePollController === controller) activePollController = null;
    }
  }

  async function verifyBaleConnection() {
    try {
      const me = await bale("getMe", {});
      logger.log(
        `Connected to Bale${me?.username ? ` as @${me.username}` : ""}${me?.id ? ` (id: ${me.id})` : ""}.`,
      );
    } catch (error) {
      // getMe فقط برای اطمینانِ شروع است؛ نبودنش نباید جلوی polling را بگیرد
      logger.warn("Bale getMe check failed; continuing with polling.", error?.message ?? "");
    }
  }

  async function run() {
    logger.log("Zoppini Bale bot is starting in private-chat mode.");
    if (allowedBaleIds.size === 0) {
      logger.warn(
        "ALLOWED_BALE_IDS is empty: only /id will work until at least one Bale user ID is allowed.",
      );
    }
    if (!config.siteApiBase || !config.siteApiToken) {
      logger.warn(
        "Site report API is not configured (ZOPPINI_SITE_API_BASE_URL / ZOPPINI_BOT_SERVICE_TOKEN); reports are disabled until both are set.",
      );
    }
    await verifyBaleConnection();

    let consecutiveFailures = 0;
    while (!stopping) {
      try {
        await pollOnce();
        consecutiveFailures = 0;
      } catch (error) {
        if (stopping) break;
        consecutiveFailures += 1;
        const backoffSeconds = Math.min(30, 3 * consecutiveFailures);
        const retrySeconds = Number.isInteger(error?.retryAfter) ? error.retryAfter : backoffSeconds;
        if (error?.status === 409) {
          logger.error(
            "Bale returned 409 (conflict): another bot instance is polling or a webhook is set for this token.",
          );
        }
        logger.error(
          `Bale polling failed; retrying in ${retrySeconds} seconds.`,
          error?.message ?? "Unknown error",
        );
        await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000));
      }
    }
    logger.log("Zoppini Bale bot stopped.");
  }

  function stop(signal = "stop") {
    if (stopping) return;
    stopping = true;
    logger.log(`Received ${signal}; stopping…`);
    activePollController?.abort();
  }

  return { run, stop, pollOnce, handleMessage };
}

/* ------------------------------------------------------------------ */
/* نقطهٔ ورود                                                          */
/* ------------------------------------------------------------------ */

async function main() {
  const config = readConfig();
  if (!config.baleToken) {
    console.error("Configuration error: BALE_BOT_TOKEN is missing.");
    process.exit(1);
  }

  const bot = createBot(config);
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
  await bot.run();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error("Bale bot stopped unexpectedly.", error?.message ?? "Unknown error");
    process.exitCode = 1;
  });
}
