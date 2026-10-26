/**
 * ربات مدیریتی Zoppini روی پیام‌رسان بله (Bale).
 *
 * معماری امن:
 *   بله ← HTTPS long-polling (بدون پورت ورودی عمومی) ← این سرویس
 *   این سرویس ← HTTPS + Bearer Service Token + امضای HMAC هویت کاربر بله ← API اختصاصی NestJS (‎/api/bot/v1‎)
 *
 * اصول امنیتی:
 *   - عدم اتصال مستقیم به MySQL، Redis یا کوکی/نشست پنل وب
 *   - پاسخ‌گویی صرفاً در چت خصوصی (private chat) و رد کامل چت‌های گروهی/کانال
 *   - احراز هویت دوطرفه سرویس + امضای رمزنگاری‌شدهٔ شناسهٔ کاربر بله برای اعمال RBAC در سمت سرور
 *   - تحویل اعلان‌های خودکار از صف پایدار Outbox سایت با Lease / Ack، Retry و جلوگیری از تکرار
 *   - بدون هیچ وابستگی خارجی npm (فقط Node.js 22+)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, deriveActorSigningKey, signSiteApiRequest } from "./src/auth.mjs";
import {
  DEFAULT_MAX_BALE_DOCUMENT_BYTES,
  prepareCsvDocumentsForBale,
} from "./src/csv.mjs";
import {
  dateInTehran,
  formatDateFa,
  formatDateTimeFa,
  formatNumberFa,
  formatOutboxEventMessage,
  formatSyncStatusLine,
  money,
  normalizeDigits,
  normalizeOrderNumber,
  orderStatusFa,
  resolvePresetRange,
  roleFa,
  shippingMethodFa,
} from "./src/formatters.mjs";

export {
  canonicalJson,
  dateInTehran,
  deriveActorSigningKey,
  formatDateTimeFa,
  formatNumberFa,
  money,
  normalizeDigits,
  normalizeOrderNumber,
  orderStatusFa,
  prepareCsvDocumentsForBale,
  resolvePresetRange,
  signSiteApiRequest,
};

/* ------------------------------------------------------------------ */
/* ثابت‌ها و کیبوردهای رابط کاربری                                     */
/* ------------------------------------------------------------------ */

export const BUTTONS = {
  sales: "📊 فروش",
  orders: "🧾 سفارش‌ها",
  stock: "📦 موجودی کالا",
  customers: "👥 مشتری‌ها",
  alerts: "🔔 هشدارها",
  settings: "⚙️ تنظیمات",
};

export const mainKeyboard = {
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

const PENDING_INPUT_TTL_MS = 5 * 60 * 1000;
const SITE_API_TIMEOUT_MS = 15_000;
const CALLER_CACHE_TTL_MS = 20_000;
const MAX_DELIVERED_CACHE = 5_000;
const MAX_ORDER_REF_CACHE = 500;
const OUTAGE_CONSECUTIVE_FAILURES_THRESHOLD = 3;

const SETTING_TOGGLE_CODES = {
  oc: { field: "notifyOrderCreated", label: "سفارش جدید" },
  op: { field: "notifyOrderPaid", label: "پرداخت موفق" },
  ox: { field: "notifyOrderCancelled", label: "لغو و بازپرداخت" },
  os: { field: "notifyOrderStatusChanged", label: "تغییر وضعیت ارسال" },
  iv: { field: "notifyInventoryAlerts", label: "هشدار موجودی کالا" },
  sh: { field: "notifySyncAndHealth", label: "سلامت و همگام‌سازی" },
};

const ROLE_CODES = {
  ow: "owner",
  ad: "admin",
  or: "orders-read-only",
  rr: "reports-read-only",
};

/* ------------------------------------------------------------------ */
/* توابع کمکی خالص و خطاهای استاندارد                                  */
/* ------------------------------------------------------------------ */

export class SiteApiError extends Error {
  constructor(message, { status = 0, bodyMessage = "" } = {}) {
    super(message);
    this.name = "SiteApiError";
    this.status = status;
    this.bodyMessage = bodyMessage;
  }
}

export function parseAllowedBaleIds(rawValue) {
  return new Set(
    String(rawValue ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => /^\d+$/.test(value)),
  );
}

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
  return String(text ?? "").match(/^\/(\w+)(?:@\w+)?(?:\s|$)/)?.[1]?.toLowerCase() ?? null;
}

export function isPrivateOneToOne(message) {
  return (
    message?.chat?.type === "private" &&
    message?.from?.id !== undefined &&
    String(message.chat?.id) === String(message.from?.id)
  );
}

function isCancelText(text) {
  const normalized = String(text ?? "").trim();
  const cmd = commandName(normalized);
  return (
    cmd === "cancel" ||
    normalized === "لغو" ||
    normalized === "انصراف" ||
    normalized === "❌ لغو" ||
    normalized === "بازگشت"
  );
}

function sanitizeLogReason(error) {
  const msg = String(error?.message ?? "Unknown error");
  return msg
    .replace(/bot[^\s/]+/gi, "bot[REDACTED]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .slice(0, 200);
}

/* ------------------------------------------------------------------ */
/* خواندن پیکربندی از متغیرهای محیطی                                   */
/* ------------------------------------------------------------------ */

export function readConfig(env = process.env) {
  return {
    baleToken: env.BALE_BOT_TOKEN?.trim() || "",
    baleApiBase: (env.BALE_API_BASE_URL?.trim() || "https://tapi.bale.ai").replace(/\/+$/, ""),
    siteApiBase: env.ZOPPINI_SITE_API_BASE_URL?.trim().replace(/\/+$/, "") || "",
    siteApiToken: env.ZOPPINI_BOT_SERVICE_TOKEN?.trim() || "",
    siteSigningSecret: env.ZOPPINI_BOT_SIGNING_SECRET?.trim() || "",
    allowedBaleIds: parseAllowedBaleIds(env.ALLOWED_BALE_IDS),
    ownerBaleIds: parseAllowedBaleIds(env.OWNER_BALE_IDS || env.ALLOWED_BALE_IDS),
    pollingTimeoutSeconds: Math.max(
      1,
      Math.min(50, Number.parseInt(env.POLLING_TIMEOUT_SECONDS ?? "25", 10) || 25),
    ),
    outboxPollIntervalMs: Math.max(
      500,
      Math.min(60_000, Number.parseInt(env.OUTBOX_POLL_INTERVAL_MS ?? "5000", 10) || 5_000),
    ),
    maxDocumentBytes: Math.max(
      2_048,
      Number.parseInt(
        env.BALE_MAX_DOCUMENT_BYTES ?? String(DEFAULT_MAX_BALE_DOCUMENT_BYTES),
        10,
      ) || DEFAULT_MAX_BALE_DOCUMENT_BYTES,
    ),
    stateFilePath: env.BOT_STATE_FILE?.trim() || "",
    heartbeatFilePath: env.BOT_HEARTBEAT_FILE?.trim() || "",
  };
}

/* ------------------------------------------------------------------ */
/* سازندهٔ سرویس ربات                                                  */
/* ------------------------------------------------------------------ */

export function createBot(config, { fetchImpl = fetch, logger = console } = {}) {
  const baleApi = `${config.baleApiBase}/bot${config.baleToken}`;
  const localAllowedIds = config.allowedBaleIds ?? new Set();
  const knownHealthRecipients = new Set(config.ownerBaleIds ?? []);

  let nextUpdateOffset = 0;
  let stopping = false;
  let activePollController = null;
  let outboxTimer = null;
  let outboxBusy = false;

  const pendingInput = new Map(); // userId -> { kind, meta, expiresAt }
  const callerProfileCache = new Map(); // userId -> { profile, expiresAt }
  const userInventorySearch = new Map(); // userId -> last search string
  const orderRefToNumber = new Map(); // shortKey -> orderNumber
  let orderRefSeq = 0;

  // کش جلوگیری از ارسال تکراری در retryهای عادی: key = `${eventId}:${recipientId}`
  const deliveredRecipientPairs = new Set();

  // پایش سلامت اتصال ربات به API سایت
  let consecutiveSiteApiFailures = 0;
  let siteApiOutageOpen = false;

  loadPersistedBotState();

  function loadPersistedBotState() {
    if (!config.stateFilePath || !existsSync(config.stateFilePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(config.stateFilePath, "utf8"));
      if (Number.isInteger(parsed?.nextUpdateOffset) && parsed.nextUpdateOffset > 0) {
        nextUpdateOffset = parsed.nextUpdateOffset;
      }
      if (Array.isArray(parsed?.deliveredPairs)) {
        for (const key of parsed.deliveredPairs.slice(-MAX_DELIVERED_CACHE)) {
          if (typeof key === "string") deliveredRecipientPairs.add(key);
        }
      }
      if (Array.isArray(parsed?.healthRecipients)) {
        for (const id of parsed.healthRecipients) {
          if (/^\d+$/.test(String(id))) knownHealthRecipients.add(String(id));
        }
      }
    } catch (error) {
      logger.warn("Reading BOT_STATE_FILE failed; continuing with clean memory state.", sanitizeLogReason(error));
    }
  }

  function persistBotState() {
    if (!config.stateFilePath) return;
    try {
      mkdirSync(dirname(config.stateFilePath), { recursive: true });
      writeFileSync(
        config.stateFilePath,
        JSON.stringify({
          nextUpdateOffset,
          deliveredPairs: [...deliveredRecipientPairs].slice(-MAX_DELIVERED_CACHE),
          healthRecipients: [...knownHealthRecipients],
          savedAt: new Date().toISOString(),
        }),
        "utf8",
      );
    } catch (error) {
      logger.warn("Writing BOT_STATE_FILE failed.", sanitizeLogReason(error));
    }
  }

  function writeHeartbeat(status = "ok") {
    if (!config.heartbeatFilePath) return;
    try {
      mkdirSync(dirname(config.heartbeatFilePath), { recursive: true });
      writeFileSync(
        config.heartbeatFilePath,
        JSON.stringify({ status, updatedAt: Date.now() }),
        "utf8",
      );
    } catch {
      // نادیده‌گرفتن خطای فایل heartbeat تا سرویس اصلی متوقف نشود
    }
  }

  function recordDeliveredPair(eventId, recipientId) {
    const key = `${eventId}:${recipientId}`;
    if (deliveredRecipientPairs.size >= MAX_DELIVERED_CACHE) {
      const oldest = deliveredRecipientPairs.values().next().value;
      if (oldest) deliveredRecipientPairs.delete(oldest);
    }
    deliveredRecipientPairs.add(key);
  }

  function encodeOrderDetailCallback(orderNumber, piiFlag = 0, page = 1, status = "all", range = "all") {
    const direct = `ord:d:${orderNumber}:${piiFlag}:${page}:${status}:${range}`;
    if (Buffer.byteLength(direct, "utf8") <= 62) {
      return direct;
    }
    orderRefSeq = (orderRefSeq % MAX_ORDER_REF_CACHE) + 1;
    const refKey = `r${orderRefSeq}`;
    orderRefToNumber.set(refKey, orderNumber);
    return `ord:dr:${refKey}:${piiFlag}:${page}:${status}:${range}`;
  }

  /* --------------------------- کلاینت API بله --------------------------- */

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
      error.description = result?.description || "";
      throw error;
    }
    return result.result;
  }

  async function sendDocumentToBale(chatId, { filename, buffer, mimeType, caption }) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) {
      form.set("caption", caption);
    }
    const blob = new Blob([buffer], { type: mimeType || "text/csv; charset=utf-8" });
    form.set("document", blob, filename);

    const response = await fetchImpl(`${baleApi}/sendDocument`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
      const error = new Error(`Bale API sendDocument failed (${response.status}).`);
      error.status = response.status;
      error.retryAfter = result?.parameters?.retry_after;
      throw error;
    }
    return result.result;
  }

  async function sendMessage(chatId, text, replyMarkup = mainKeyboard) {
    return bale("sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup });
  }

  async function sendOrEditView(context, text, inlineRows) {
    const replyMarkup = inlineRows ? { inline_keyboard: inlineRows } : mainKeyboard;
    if (context.messageId && inlineRows) {
      try {
        return await bale("editMessageText", {
          chat_id: context.chatId,
          message_id: context.messageId,
          text,
          reply_markup: replyMarkup,
        });
      } catch {
        // اگر پیام قابل ویرایش نبود (مثلاً متن یکسان یا پیام قدیمی)، پیام تازه ارسال می‌شود
      }
    }
    return sendMessage(context.chatId, text, replyMarkup);
  }

  async function answerCallback(callbackQueryId, text = undefined) {
    if (!callbackQueryId) return;
    try {
      await bale("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      });
    } catch {
      // پاسخ به اسپینر دکمه نباید جریان اصلی را متوقف کند
    }
  }

  /* ------------------------- کلاینت امن API سایت ------------------------- */

  async function siteRequest(method, path, { actorId, chatType = "private", body = undefined } = {}) {
    if (!config.siteApiBase || !config.siteApiToken) {
      throw new SiteApiError("Site API is not configured.", { status: 503 });
    }

    const fullUrl = `${config.siteApiBase}${path}`;
    const upperMethod = method.toUpperCase();
    const serializedBody =
      body !== undefined && upperMethod !== "GET" && upperMethod !== "HEAD"
        ? canonicalJson(body)
        : "";

    const signedHeaders = signSiteApiRequest({
      serviceToken: config.siteApiToken,
      signingSecret: config.siteSigningSecret,
      method: upperMethod,
      fullUrl,
      actorId: actorId ?? "system",
      chatType,
      serializedBody,
    });

    const headers = {
      ...signedHeaders,
      accept: "application/json",
      ...(serializedBody ? { "content-type": "application/json" } : {}),
    };

    const response = await fetchImpl(fullUrl, {
      method: upperMethod,
      headers,
      ...(serializedBody ? { body: serializedBody } : {}),
      signal: AbortSignal.timeout(SITE_API_TIMEOUT_MS),
    });

    const jsonBody = await response.json().catch(() => null);

    if (!response.ok) {
      const serverMsg =
        typeof jsonBody?.message === "string"
          ? jsonBody.message
          : Array.isArray(jsonBody?.message)
            ? jsonBody.message.join("، ")
            : "";
      throw new SiteApiError(`Site report API returned ${response.status}.`, {
        status: response.status,
        bodyMessage: serverMsg,
      });
    }

    return unwrapSiteResponse(jsonBody);
  }

  /* ------------------------- کنترل دسترسی کاربر ------------------------- */

  async function resolveUserAccess(userId) {
    const now = Date.now();
    const cached = callerProfileCache.get(userId);
    if (cached && cached.expiresAt > now) {
      return cached.profile;
    }

    // اگر API سایت تنظیم نشده باشد، فقط از allowlist محلی تصمیم گرفته می‌شود
    if (!config.siteApiBase || !config.siteApiToken) {
      const authorized = localAllowedIds.has(userId);
      return {
        authorized,
        role: authorized ? "owner" : null,
        permissions: [],
      };
    }

    try {
      const profile = await siteRequest("GET", "/me", {
        actorId: userId,
        chatType: "private",
      });

      // اگر پاسخ سرور مشخصاً شامل فیلد authorized بود، منبع حقیقت همان RBAC سرور است
      if (profile && typeof profile === "object" && "authorized" in profile) {
        const normalized = {
          authorized: Boolean(profile.authorized),
          role: profile.role ?? null,
          permissions: Array.isArray(profile.permissions) ? profile.permissions : [],
        };
        callerProfileCache.set(userId, {
          profile: normalized,
          expiresAt: now + CALLER_CACHE_TTL_MS,
        });
        return normalized;
      }

      // سازگاری با تست‌ها یا سرورهای ساده‌تر که /me اختصاصی ندارند
      const fallbackAuthorized = localAllowedIds.has(userId);
      return {
        authorized: fallbackAuthorized,
        role: fallbackAuthorized ? "owner" : null,
        permissions: [],
      };
    } catch (error) {
      if (error instanceof SiteApiError && error.status === 403) {
        return { authorized: false, role: null, permissions: [] };
      }
      // در خطای موقت شبکه به سایت، اگر کاربر در allowlist محلی است اجازه ورود به منو می‌دهیم تا پیام خطای موقت مناسب ببیند
      if (localAllowedIds.has(userId)) {
        return { authorized: true, role: "owner", permissions: [] };
      }
      throw error;
    }
  }

  /* ---------------------------- ۱. بخش سفارش‌ها ---------------------------- */

  async function showOrdersSummary(ctx) {
    const today = dateInTehran();
    const summary = await siteRequest(
      "GET",
      `/orders/summary?date=${encodeURIComponent(today)}`,
      { actorId: ctx.userId },
    );

    const cats = summary?.categories ?? {};
    const total = Number(summary?.totalOrders ?? 0);
    const refundedAfterPay = Number(cats.refundedOrCancelledAfterPayment ?? 0);

    const text =
      `🧾 خلاصهٔ سفارش‌های امروز (${formatDateFa(today)} — ${today})\n` +
      `منطقهٔ زمانی: ${summary?.timezone ?? "Asia/Tehran"}\n\n` +
      `• کل سفارش‌های ثبت‌شده امروز: ${formatNumberFa(total)}\n` +
      `• 🆕 جدید / در انتظار پرداخت (pending): ${formatNumberFa(cats.pending ?? 0)}\n` +
      `• 💳 پرداخت‌شده / آماده پردازش و ارسال (paid): ${formatNumberFa(cats.paid ?? 0)}\n` +
      `• 🚚 در مسیر ارسال / ارسال‌شده (shipped): ${formatNumberFa(cats.shipped ?? 0)}\n` +
      `• ✅ تحویل‌شده / بسته‌شده (delivered): ${formatNumberFa(cats.delivered ?? 0)}\n` +
      `• ❌ لغوشده (cancelled): ${formatNumberFa(cats.cancelled ?? 0)}\n` +
      `• ↩️ لغو پس از پرداخت / عودت کیف‌پول: ${formatNumberFa(refundedAfterPay)}\n\n` +
      `ℹ️ راهنمای وضعیت‌ها: در سیستم وضعیت مجزایی به نام processing یا refunded در جدول سفارش وجود ندارد؛ سفارش‌های پرداخت‌شده با وضعیت paid در صف ارسال قرار دارند و عودت‌های کیف‌پول جداگانه محاسبه می‌شوند.`;

    const keyboard = [
      [{ text: "📋 آخرین سفارش‌ها (از جدیدترین)", callback_data: "ord:l:1:all:all" }],
      [
        { text: "💳 پرداخت‌شده‌ها", callback_data: "ord:l:1:paid:all" },
        { text: "🆕 در انتظار پرداخت", callback_data: "ord:l:1:pending:all" },
      ],
      [
        { text: "🚚 ارسال‌شده‌ها", callback_data: "ord:l:1:shipped:all" },
        { text: "✅ تحویل‌شده‌ها", callback_data: "ord:l:1:delivered:all" },
      ],
      [
        { text: "❌ لغوشده‌ها", callback_data: "ord:l:1:cancelled:all" },
        { text: "🔍 جست‌وجو با شماره سفارش", callback_data: "ord:search" },
      ],
      [
        { text: "🔄 بروزرسانی", callback_data: "ord:sum" },
        { text: "🏠 منوی اصلی", callback_data: "menu:home" },
      ],
    ];

    await sendOrEditView(ctx, text, keyboard);
  }

  async function showOrdersList(ctx, { page = 1, status = "all", rangeKey = "all" } = {}) {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", "10");

    if (status && status !== "all") {
      params.set("status", status);
    }

    let rangeLabel = "همهٔ تاریخ‌ها";
    if (rangeKey && rangeKey !== "all") {
      const preset = resolvePresetRange(rangeKey);
      params.set("from", preset.from);
      params.set("to", preset.to);
      rangeLabel = `${preset.label} (${preset.from} تا ${preset.to})`;
    }

    const result = await siteRequest("GET", `/orders?${params.toString()}`, {
      actorId: ctx.userId,
    });

    const items = Array.isArray(result?.items) ? result.items : [];
    const pagination = result?.pagination ?? { page: 1, total: 0, totalPages: 0 };
    const statusTitle = status === "all" ? "همهٔ وضعیت‌ها" : orderStatusFa(status);

    let bodyLines;
    if (items.length === 0) {
      bodyLines = "📭 هیچ سفارشی با این فیلتر یافت نشد.";
    } else {
      bodyLines = items
        .map((item, idx) => {
          const rowNum = (pagination.page - 1) * (pagination.limit || 10) + idx + 1;
          return (
            `${formatNumberFa(rowNum)}. ${item.orderNumber} | ${orderStatusFa(item.status)}\n` +
            `   💰 ${money(item.finalPrice, item.currency)} | 🕒 ${formatDateTimeFa(item.createdAt)}`
          );
        })
        .join("\n");
    }

    const text =
      `📋 فهرست آخرین سفارش‌ها\n` +
      `فیلتر وضعیت: ${statusTitle} | بازه: ${rangeLabel}\n` +
      `تعداد کل نتایج: ${formatNumberFa(pagination.total)} (صفحه ${formatNumberFa(pagination.page)} از ${formatNumberFa(Math.max(1, pagination.totalPages))})\n\n` +
      `${bodyLines}\n\n` +
      (items.length > 0 ? "برای مشاهدهٔ جزئیات کامل، روی دکمهٔ سفارش موردنظر بزنید:" : "");

    const keyboard = [];

    // دکمه‌های انتخاب مستقیم هر سفارش (۲ سفارش در هر ردیف)
    for (let i = 0; i < items.length; i += 2) {
      const row = items.slice(i, i + 2).map((item) => ({
        text: `🧾 ${item.orderNumber}`,
        callback_data: encodeOrderDetailCallback(item.orderNumber, 0, pagination.page, status, rangeKey),
      }));
      keyboard.push(row);
    }

    // ردیف صفحه‌بندی پایدار
    const navRow = [];
    if (pagination.page > 1) {
      navRow.push({
        text: "⬅️ قبلی",
        callback_data: `ord:l:${pagination.page - 1}:${status}:${rangeKey}`,
      });
    }
    if (pagination.totalPages > 1) {
      navRow.push({
        text: `${formatNumberFa(pagination.page)} / ${formatNumberFa(pagination.totalPages)}`,
        callback_data: `ord:l:${pagination.page}:${status}:${rangeKey}`,
      });
    }
    if (pagination.page < pagination.totalPages) {
      navRow.push({
        text: "بعدی ➡️",
        callback_data: `ord:l:${pagination.page + 1}:${status}:${rangeKey}`,
      });
    }
    if (navRow.length > 0) keyboard.push(navRow);

    // فیلتر بازهٔ زمانی
    keyboard.push([
      { text: rangeKey === "all" ? "• همه زمان‌ها" : "همه زمان‌ها", callback_data: `ord:l:1:${status}:all` },
      { text: rangeKey === "today" ? "• امروز" : "امروز", callback_data: `ord:l:1:${status}:today` },
      { text: rangeKey === "7d" ? "• ۷ روز" : "۷ روز", callback_data: `ord:l:1:${status}:7d` },
      { text: rangeKey === "month" ? "• ماه جاری" : "ماه جاری", callback_data: `ord:l:1:${status}:month` },
    ]);

    // فیلتر وضعیت
    keyboard.push([
      { text: status === "all" ? "• همه" : "همه", callback_data: `ord:l:1:all:${rangeKey}` },
      { text: status === "paid" ? "• پرداخت‌شده" : "پرداخت‌شده", callback_data: `ord:l:1:paid:${rangeKey}` },
      { text: status === "pending" ? "• در انتظار" : "در انتظار", callback_data: `ord:l:1:pending:${rangeKey}` },
      { text: status === "cancelled" ? "• لغو" : "لغو", callback_data: `ord:l:1:cancelled:${rangeKey}` },
    ]);

    keyboard.push([
      { text: "🔍 جست‌وجو با شماره", callback_data: "ord:search" },
      { text: "🔙 خلاصه سفارش‌ها", callback_data: "ord:sum" },
      { text: "🏠 منوی اصلی", callback_data: "menu:home" },
    ]);

    await sendOrEditView(ctx, text, keyboard);
  }

  async function showOrderDetail(
    ctx,
    orderNumber,
    { includeCustomer = false, backPage = 1, backStatus = "all", backRange = "all" } = {},
  ) {
    const safeOrderNumber = encodeURIComponent(orderNumber);
    const querySuffix = includeCustomer ? "?includeCustomer=true" : "";
    const result = await siteRequest("GET", `/orders/${safeOrderNumber}${querySuffix}`, {
      actorId: ctx.userId,
    });

    if (!result?.orderNumber || result.notFound) {
      await sendOrEditView(ctx, "📭 سفارشی با این شماره پیدا نشد.", [
        [
          { text: "🔍 جست‌وجوی مجدد", callback_data: "ord:search" },
          { text: "📋 آخرین سفارش‌ها", callback_data: "ord:l:1:all:all" },
        ],
        [
          { text: "🔙 خلاصه سفارش‌ها", callback_data: "ord:sum" },
          { text: "🏠 منوی اصلی", callback_data: "menu:home" },
        ],
      ]);
      return;
    }

    const currency = result.currency ?? "IRT";
    const items = Array.isArray(result.items) ? result.items : [];
    const itemLines = items.slice(0, 20).map((item, idx) => {
      const variantPart = item.variant ? ` — ${item.variant}` : "";
      const skuPart = item.sku ? ` [SKU: ${item.sku}]` : "";
      const lineTotal =
        item.lineTotal !== undefined ? item.lineTotal : Number(item.unitPrice || 0) * Number(item.quantity || 0);
      const origNote =
        item.originalUnitPrice && item.originalUnitPrice > item.unitPrice
          ? ` (قبل از تخفیف: ${money(item.originalUnitPrice, currency)})`
          : "";
      return (
        `${formatNumberFa(idx + 1)}. ${item.productName}${variantPart}${skuPart}\n` +
        `   تعداد: ${formatNumberFa(item.quantity)} × ${money(item.unitPrice, currency)}${origNote} = ${money(lineTotal, currency)}`
      );
    });
    if (items.length > 20) {
      itemLines.push(`… و ${formatNumberFa(items.length - 20)} قلم دیگر`);
    }

    const finalAmount = result.finalPrice ?? result.total ?? 0;
    const subtotalLine =
      result.itemsSubtotal !== undefined
        ? `جمع اقلام: ${money(result.itemsSubtotal, currency)}\n`
        : "";
    const discountLine =
      Number(result.discount) > 0 ? `تخفیف کل: ${money(result.discount, currency)}\n` : "";
    const shippingLine =
      result.shippingCost !== undefined
        ? `هزینهٔ ارسال (${shippingMethodFa(result.shippingMethod)}): ${money(result.shippingCost, currency)}\n`
        : "";
    const refundLine =
      Number(result.refundedAmount) > 0
        ? `↩️ مبلغ عودت‌یافته به کیف‌پول: ${money(result.refundedAmount, currency)}\n`
        : "";

    let customerBlock = "";
    if (result.customerAccessDenied) {
      customerBlock = "\n👤 اطلاعات مشتری: برای نمایش این اطلاعات دسترسی لازم را ندارید.";
    } else if (includeCustomer && result.customer) {
      const c = result.customer;
      const loc = [c.province, c.city].filter(Boolean).join("، ");
      customerBlock =
        `\n👤 اطلاعات تحویل مشتری (گفت‌وگوی خصوصی):\n` +
        `نام: ${c.fullName || "نامشخص"}\n` +
        `تلفن: ${c.phone || "نامشخص"}\n` +
        (loc ? `استان/شهر: ${loc}\n` : "") +
        (c.address ? `نشانی: ${c.address}\n` : "") +
        (c.postalCode ? `کدپستی: ${c.postalCode}` : "");
    } else if (result.canViewCustomer && result.customerSummary) {
      const s = result.customerSummary;
      const loc = [s.province, s.city].filter(Boolean).join("، ");
      customerBlock =
        `\n👤 مشتری: ${s.fullName || "ثبت‌شده"}` +
        (loc ? ` (${loc})` : "") +
        "\n(تلفن و نشانی کامل به صورت پیش‌فرض پنهان است)";
    }

    const updatedLine =
      result.updatedAt && result.updatedAt !== result.createdAt
        ? `آخرین تغییر وضعیت/بروزرسانی: ${formatDateTimeFa(result.updatedAt)}\n`
        : `آخرین تغییر ثبت‌شده: ${formatDateTimeFa(result.updatedAt ?? result.createdAt)}\n`;

    const text =
      `🧾 جزئیات سفارش ${result.orderNumber}\n` +
      `وضعیت: ${orderStatusFa(result.status)}\n` +
      `تاریخ ثبت: ${formatDateTimeFa(result.createdAt)}\n` +
      updatedLine +
      `\n🛍 اقلام سفارش:\n${itemLines.length ? itemLines.join("\n") : "بدون قلم ثبت‌شده"}\n\n` +
      `💳 جزئیات مالی:\n` +
      subtotalLine +
      discountLine +
      shippingLine +
      refundLine +
      `مبلغ نهایی سفارش: ${money(finalAmount, currency)}` +
      customerBlock;

    const keyboard = [];
    if (result.canViewCustomer) {
      if (includeCustomer) {
        keyboard.push([
          {
            text: "🙈 مخفی‌کردن تلفن و نشانی",
            callback_data: encodeOrderDetailCallback(result.orderNumber, 0, backPage, backStatus, backRange),
          },
        ]);
      } else {
        keyboard.push([
          {
            text: "👤 نمایش تلفن و نشانی تحویل",
            callback_data: encodeOrderDetailCallback(result.orderNumber, 1, backPage, backStatus, backRange),
          },
        ]);
      }
    }

    keyboard.push([
      {
        text: "🔙 بازگشت به فهرست سفارش‌ها",
        callback_data: `ord:l:${backPage}:${backStatus}:${backRange}`,
      },
    ]);
    keyboard.push([
      { text: "🧾 خلاصه سفارش‌ها", callback_data: "ord:sum" },
      { text: "🏠 منوی اصلی", callback_data: "menu:home" },
    ]);

    await sendOrEditView(ctx, text, keyboard);
  }

  async function promptOrderNumberSearch(ctx) {
    pendingInput.set(ctx.userId, {
      kind: "order-number",
      expiresAt: Date.now() + PENDING_INPUT_TTL_MS,
    });
    await sendOrEditView(
      ctx,
      "🔍 شمارهٔ سفارش را بفرستید (مثال: ORD-12345678-0001):\nبرای انصراف /cancel یا دکمهٔ لغو را بزنید.",
      [
        [
          { text: "❌ لغو عملیات", callback_data: "nav:cancel" },
          { text: "🔙 بازگشت به سفارش‌ها", callback_data: "ord:sum" },
        ],
      ],
    );
  }

  /* ---------------------------- ۲. بخش گزارش فروش ---------------------------- */

  async function showSalesReport(ctx, rangeInput = "today") {
    const range =
      typeof rangeInput === "object" && rangeInput.from && rangeInput.to
        ? rangeInput
        : resolvePresetRange(rangeInput);

    const report = await siteRequest(
      "GET",
      `/reports/sales?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      { actorId: ctx.userId },
    );

    const currency = report?.currency ?? "IRT";
    const unitLabel = currency === "IRT" ? "تومان (IRT)" : currency === "IRR" ? "ریال (IRR)" : currency;
    const paidOrders = Number(report?.paidOrders ?? 0);
    const totalOrders = Number(report?.totalOrders ?? paidOrders);
    const grossSales = Number(report?.grossSales ?? report?.netSales ?? 0);
    const discounts = Number(report?.discounts ?? 0);
    const refunds = Number(report?.refunds ?? 0);
    const netSales = Number(report?.netSales ?? 0);
    const shippingTotal = Number(report?.shippingTotal ?? 0);
    const finalPaidTotal = Number(report?.finalPaidTotal ?? netSales + shippingTotal);
    const aov = Number(report?.averageOrderValue ?? 0);

    const dailyRows = Array.isArray(report?.dailyBreakdown) ? report.dailyBreakdown : [];
    const dailySection =
      dailyRows.length > 1
        ? "\n📅 روند روزانه (فروش خالص):\n" +
          dailyRows
            .slice(-7)
            .map(
              (d) =>
                `• ${d.date}: ${formatNumberFa(d.paidOrders)} سفارش — ${money(d.netSales, currency)}`,
            )
            .join("\n") +
          "\n"
        : "";

    const rangeTitle =
      range.from === range.to
        ? `${range.label ?? ""} (${formatDateFa(range.from)} — ${range.from})`.trim()
        : `${range.label ?? "بازه انتخابی"} (${range.from} تا ${range.to})`;

    const text =
      `📊 گزارش فروش — ${rangeTitle}\n` +
      `واحد پول: ${unitLabel} | منطقهٔ زمانی: ${report?.timezone ?? "Asia/Tehran"}\n\n` +
      `• کل سفارش‌های ثبت‌شده: ${formatNumberFa(totalOrders)}\n` +
      `• سفارش‌های پرداخت موفق: ${formatNumberFa(paidOrders)}` +
      (report?.pendingOrders !== undefined
        ? ` (در انتظار: ${formatNumberFa(report.pendingOrders)} | لغوشده: ${formatNumberFa(report.cancelledOrders ?? 0)})`
        : "") +
      `\n\n` +
      `• فروش ناخالص اقلام (بدون ارسال): ${money(grossSales, currency)}\n` +
      `• تخفیف‌ها: ${money(discounts, currency)}\n` +
      `• بازپرداخت / لغو پس از پرداخت: ${money(refunds, currency)}` +
      (Number(report?.refundedOrders) > 0
        ? ` (${formatNumberFa(report.refundedOrders)} سفارش)`
        : "") +
      `\n` +
      `• فروش خالص کالاها: ${money(netSales, currency)}\n` +
      (report?.shippingTotal !== undefined
        ? `• هزینهٔ ارسال سفارش‌های موفق: ${money(shippingTotal, currency)}\n` +
          `• جمع کل پرداختی نهایی (با ارسال): ${money(finalPaidTotal, currency)}\n`
        : "") +
      `• میانگین مبلغ سفارش موفق: ${money(aov, currency)}\n` +
      dailySection +
      `\n🕒 زمان تولید گزارش: ${formatDateTimeFa(report?.generatedAt ?? new Date().toISOString())}`;

    const activeKey = range.key ?? "custom";
    const keyboard = [
      [
        { text: activeKey === "today" ? "• امروز" : "امروز", callback_data: "sal:r:today" },
        { text: activeKey === "yesterday" ? "• دیروز" : "دیروز", callback_data: "sal:r:yesterday" },
      ],
      [
        { text: activeKey === "7d" ? "• ۷ روز اخیر" : "۷ روز اخیر", callback_data: "sal:r:7d" },
        { text: activeKey === "month" ? "• ماه جاری" : "ماه جاری", callback_data: "sal:r:month" },
      ],
      [{ text: "📥 دریافت فایل CSV تفصیلی این بازه", callback_data: `sal:csv:${range.from}:${range.to}` }],
      [
        { text: "📅 بازهٔ تاریخ دلخواه", callback_data: "sal:custom" },
        { text: "🏠 منوی اصلی", callback_data: "menu:home" },
      ],
    ];

    await sendOrEditView(ctx, text, keyboard);
  }

  async function exportAndSendSalesCsv(ctx, from, to) {
    const exportData = await siteRequest(
      "GET",
      `/reports/sales/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { actorId: ctx.userId },
    );

    await deliverCsvExportToChat(ctx.chatId, exportData, `گزارش تفصیلی فروش (${from} تا ${to})`);
  }

  /* ---------------------------- ۳. بخش موجودی کالا ---------------------------- */

  async function showInventorySummary(ctx) {
    const summary = await siteRequest("GET", "/inventory/summary", {
      actorId: ctx.userId,
    });

    const threshold = Number(summary?.threshold ?? 3);
    const outCount = Number(summary?.outOfStockVariants ?? 0);
    const lowCount = Number(summary?.lowStockVariants ?? 0);
    const inCount = Number(summary?.inStockVariants ?? 0);
    const totalVariants = Number(summary?.totalVariants ?? outCount + lowCount + inCount);
    const totalProducts = Number(summary?.totalProducts ?? 0);

    const text =
      `📦 خلاصهٔ وضعیت موجودی کالا\n` +
      `معیار شمارش: تعداد «واریانت کالا» (رنگ/سایز) بر اساس فیلد موجودی فروش آنلاین (variant.stock)\n\n` +
      `• کل واریانت‌ها: ${formatNumberFa(totalVariants)} واریانت (در ${formatNumberFa(totalProducts)} محصول مادر)\n` +
      `• 🔴 ناموجود (موجودی صفر): ${formatNumberFa(outCount)} واریانت\n` +
      `• 🟡 کم‌موجود (۱ تا ${formatNumberFa(threshold)} عدد): ${formatNumberFa(lowCount)} واریانت\n` +
      `• 🟢 موجود بالای آستانه (بیش از ${formatNumberFa(threshold)} عدد): ${formatNumberFa(inCount)} واریانت\n\n` +
      `${formatSyncStatusLine(summary?.sync)}`;

    const keyboard = [
      [
        { text: `🔴 ناموجودها (${formatNumberFa(outCount)})`, callback_data: "inv:l:out:1" },
        { text: `🟡 کم‌موجودها (${formatNumberFa(lowCount)})`, callback_data: "inv:l:low:1" },
      ],
      [
        { text: `🟢 موجودها (${formatNumberFa(inCount)})`, callback_data: "inv:l:in:1" },
        { text: "🔍 جست‌وجوی نام یا SKU", callback_data: "inv:search" },
      ],
      [
        { text: "📥 CSV ناموجودها", callback_data: "inv:csv:out" },
        { text: "📥 CSV کم‌موجودها", callback_data: "inv:csv:low" },
      ],
      [{ text: "📥 دریافت فایل CSV کل موجودی", callback_data: "inv:csv:all" }],
      [
        { text: "🔄 بروزرسانی", callback_data: "inv:sum" },
        { text: "🏠 منوی اصلی", callback_data: "menu:home" },
      ],
    ];

    await sendOrEditView(ctx, text, keyboard);
  }

  async function showInventoryList(ctx, { category = "low", page = 1, query = "" } = {}) {
    const params = new URLSearchParams();
    params.set("category", category);
    params.set("page", String(page));
    params.set("limit", "15");
    if (query) {
      params.set("query", query);
      userInventorySearch.set(ctx.userId, query);
    }

    const data = await siteRequest("GET", `/inventory?${params.toString()}`, {
      actorId: ctx.userId,
    });

    const items = Array.isArray(data?.items) ? data.items : [];
    const pagination = data?.pagination ?? { page: 1, limit: 15, total: 0, totalPages: 0 };
    const threshold = Number(data?.threshold ?? 3);

    const catTitle = query
      ? `نتایج جست‌وجو برای «${query}»`
      : category === "out"
        ? "واریانت‌های ناموجود (موجودی ۰)"
        : category === "low"
          ? `واریانت‌های کم‌موجود (۱ تا ${formatNumberFa(threshold)} عدد)`
          : category === "in"
            ? `واریانت‌های موجود (بالای ${formatNumberFa(threshold)} عدد)`
            : "همهٔ واریانت‌ها";

    const lines =
      items.length === 0
        ? "📭 موردی در این فهرست وجود ندارد."
        : items
            .map((item, idx) => {
              const rowNum = (pagination.page - 1) * (pagination.limit || 15) + idx + 1;
              const variantText = item.variant ? ` (${item.variant})` : "";
              const skuText = item.sku ? ` | SKU: ${item.sku}` : "";
              return `${formatNumberFa(rowNum)}. ${item.productName}${variantText}${skuText} — موجودی: ${formatNumberFa(item.stock)} عدد`;
            })
            .join("\n");

    const text =
      `📦 ${catTitle}\n` +
      `معیار: واریانت کالا | کل نتایج: ${formatNumberFa(pagination.total)} (صفحه ${formatNumberFa(pagination.page)} از ${formatNumberFa(Math.max(1, pagination.totalPages))})\n\n` +
      `${lines}\n\n` +
      `${formatSyncStatusLine(data?.sync)}`;

    const keyboard = [];
    const navRow = [];
    const pagePrefix = query ? "inv:q:" : `inv:l:${category}:`;

    if (pagination.page > 1) {
      navRow.push({
        text: "⬅️ قبلی",
        callback_data: `${pagePrefix}${pagination.page - 1}`,
      });
    }
    if (pagination.totalPages > 1) {
      navRow.push({
        text: `${formatNumberFa(pagination.page)} / ${formatNumberFa(pagination.totalPages)}`,
        callback_data: `${pagePrefix}${pagination.page}`,
      });
    }
    if (pagination.page < pagination.totalPages) {
      navRow.push({
        text: "بعدی ➡️",
        callback_data: `${pagePrefix}${pagination.page + 1}`,
      });
    }
    if (navRow.length > 0) keyboard.push(navRow);

    if (pagination.total > 0) {
      keyboard.push([
        {
          text: `📥 دریافت فایل CSV کامل (${formatNumberFa(pagination.total)} رکورد)`,
          callback_data: query ? "inv:csv:q" : `inv:csv:${category}`,
        },
      ]);
    }

    keyboard.push([
      { text: "🔍 جست‌وجوی کالا/SKU", callback_data: "inv:search" },
      { text: "🔙 خلاصه موجودی", callback_data: "inv:sum" },
    ]);
    keyboard.push([{ text: "🏠 منوی اصلی", callback_data: "menu:home" }]);

    await sendOrEditView(ctx, text, keyboard);
  }

  async function promptInventorySearch(ctx) {
    pendingInput.set(ctx.userId, {
      kind: "inventory-search",
      expiresAt: Date.now() + PENDING_INPUT_TTL_MS,
    });
    await sendOrEditView(
      ctx,
      "🔍 نام محصول، کد محصول یا SKU موردنظر را بفرستید:\nبرای انصراف /cancel یا دکمهٔ لغو را بزنید.",
      [
        [
          { text: "❌ لغو عملیات", callback_data: "nav:cancel" },
          { text: "🔙 بازگشت به موجودی", callback_data: "inv:sum" },
        ],
      ],
    );
  }

  async function exportAndSendInventoryCsv(ctx, categoryOrSearch) {
    const params = new URLSearchParams();
    if (categoryOrSearch === "q") {
      const savedQuery = userInventorySearch.get(ctx.userId) || "";
      params.set("category", "all");
      if (savedQuery) params.set("query", savedQuery);
    } else {
      params.set("category", categoryOrSearch);
    }

    const exportData = await siteRequest("GET", `/inventory/export?${params.toString()}`, {
      actorId: ctx.userId,
    });

    await deliverCsvExportToChat(ctx.chatId, exportData, "گزارش موجودی واریانت‌های فروشگاه");
  }

  async function deliverCsvExportToChat(chatId, exportData, reportTitle) {
    const totalRecords = Number(exportData?.totalRecords ?? 0);
    const filename = exportData?.filename || `zoppini-export-${dateInTehran()}.csv`;
    const csvContent = String(exportData?.csvContent ?? "");

    if (!csvContent) {
      await sendMessage(chatId, "📭 داده‌ای برای ساخت فایل خروجی یافت نشد.");
      return;
    }

    const parts = prepareCsvDocumentsForBale({
      filename,
      csvContent,
      totalRecords,
      maxBytes: config.maxDocumentBytes,
    });

    const genTime = formatDateTimeFa(exportData?.generatedAt ?? new Date().toISOString());

    for (const part of parts) {
      const partNote =
        part.totalParts > 1
          ? `\nبخش ${formatNumberFa(part.partIndex)} از ${formatNumberFa(part.totalParts)} (شامل ${formatNumberFa(part.partRecords)} رکورد در این فایل)`
          : part.compressed
            ? "\nفایل به علت حجم بالا به‌صورت فشرده (gzip) ارسال شد."
            : "";

      const caption =
        `📄 ${reportTitle}\n` +
        `تعداد کل رکوردها: ${formatNumberFa(part.totalRecords)}\n` +
        `زمان گزارش: ${genTime} (Asia/Tehran)` +
        partNote;

      await sendDocumentToBale(chatId, {
        filename: part.filename,
        buffer: part.buffer,
        mimeType: part.mimeType,
        caption,
      });
    }
  }

  /* ---------------------------- ۴. بخش مشتری‌ها ---------------------------- */

  async function showCustomersReport(ctx, rangeKey = "today") {
    const range = resolvePresetRange(rangeKey);
    const report = await siteRequest(
      "GET",
      `/reports/customers?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      { actorId: ctx.userId },
    );

    const extraBuyers =
      report?.activeBuyers !== undefined
        ? `• کل خریداران موفق در بازه: ${formatNumberFa(report.activeBuyers)}\n` +
          `• خریداران بار اول: ${formatNumberFa(report.firstTimeBuyers ?? 0)}\n`
        : "";

    const text =
      `👥 گزارش تجمیعی مشتری‌ها — ${range.label} (${range.from} تا ${range.to})\n` +
      `منطقهٔ زمانی: ${report?.timezone ?? "Asia/Tehran"}\n\n` +
      `• مشتری جدید ثبت‌نام‌شده: ${formatNumberFa(report?.newCustomers ?? 0)}\n` +
      `• مشتری تکراری (خرید مجدد): ${formatNumberFa(report?.repeatCustomers ?? 0)}\n` +
      extraBuyers +
      `\nℹ️ مطابق اصل کمینه‌سازی داده، اطلاعات هویتی مشتریان در این گزارش نمایش داده نمی‌شود.`;

    const keyboard = [
      [
        { text: rangeKey === "today" ? "• امروز" : "امروز", callback_data: "cus:r:today" },
        { text: rangeKey === "yesterday" ? "• دیروز" : "دیروز", callback_data: "cus:r:yesterday" },
      ],
      [
        { text: rangeKey === "7d" ? "• ۷ روز اخیر" : "۷ روز اخیر", callback_data: "cus:r:7d" },
        { text: rangeKey === "month" ? "• ماه جاری" : "ماه جاری", callback_data: "cus:r:month" },
      ],
      [{ text: "🏠 منوی اصلی", callback_data: "menu:home" }],
    ];

    await sendOrEditView(ctx, text, keyboard);
  }

  /* ---------------------------- ۵. بخش هشدارها و سلامت ---------------------------- */

  async function showAlertsCenter(ctx) {
    const [health, access] = await Promise.all([
      siteRequest("GET", "/system/health", { actorId: ctx.userId }),
      resolveUserAccess(ctx.userId),
    ]);

    let settings = null;
    try {
      settings = await siteRequest("GET", "/settings", { actorId: ctx.userId });
    } catch {
      // برای نقش‌هایی مثل reports-read-only که مجوز settings:read ندارند
    }

    const outbox = health?.outbox ?? {};
    const dbText = health?.database === "up" ? "✅ متصل و سالم" : "❌ خطای اتصال دیتابیس";
    const overallText = health?.ok ? "✅ سالم" : "⚠️ نیازمند بررسی";

    const settingsSection = settings
      ? `\n⚙️ وضعیت دسته‌های اعلان:\n` +
        `• سفارش جدید: ${settings.notifyOrderCreated ? "فعال ✅" : "خاموش ⛔"}\n` +
        `• پرداخت موفق: ${settings.notifyOrderPaid ? "فعال ✅" : "خاموش ⛔"}\n` +
        `• لغو و بازپرداخت: ${settings.notifyOrderCancelled ? "فعال ✅" : "خاموش ⛔"}\n` +
        `• تغییر وضعیت ارسال: ${settings.notifyOrderStatusChanged ? "فعال ✅" : "خاموش ⛔"}\n` +
        `• هشدار موجودی (آستانه ≤ ${formatNumberFa(settings.lowStockThreshold)}): ${settings.notifyInventoryAlerts ? "فعال ✅" : "خاموش ⛔"}\n` +
        `• سلامت و همگام‌سازی: ${settings.notifySyncAndHealth ? "فعال ✅" : "خاموش ⛔"}\n`
      : "";

    const text =
      `🔔 مرکز اعلان‌ها و سلامت سرویس\n` +
      `وضعیت کلی: ${overallText} | دیتابیس: ${dbText}\n` +
      `${formatSyncStatusLine(health?.sync)}\n\n` +
      `📬 وضعیت صف اعلان‌ها (Outbox):\n` +
      `• در انتظار تحویل: ${formatNumberFa(outbox.pending ?? 0)}\n` +
      `• در حال ارسال: ${formatNumberFa(outbox.leased ?? 0)}\n` +
      `• تحویل‌شده (۲۴ ساعت اخیر): ${formatNumberFa(outbox.deliveredLast24h ?? 0)}\n` +
      `• ناموفق (نیازمند بررسی): ${formatNumberFa(outbox.failed ?? 0)}\n` +
      settingsSection +
      `\n🕒 آخرین بررسی: ${formatDateTimeFa(health?.checkedAt)}`;

    const keyboard = [
      [
        { text: "📜 آخرین رویدادها", callback_data: "alt:list:all:1" },
        { text: `⚠️ رویدادهای ناموفق (${formatNumberFa(outbox.failed ?? 0)})`, callback_data: "alt:list:failed:1" },
      ],
    ];

    if (access.role === "owner" && Number(outbox.failed ?? 0) > 0) {
      keyboard.push([
        { text: "🔄 تلاش مجدد ارسال همهٔ رویدادهای ناموفق", callback_data: "alt:retry" },
      ]);
    }

    if (access.role === "owner") {
      keyboard.push([{ text: "⚙️ تنظیمات اعلان‌ها و آستانه", callback_data: "set:sum" }]);
    }

    keyboard.push([
      { text: "🩺 بررسی مجدد سلامت", callback_data: "alt:sum" },
      { text: "🏠 منوی اصلی", callback_data: "menu:home" },
    ]);

    await sendOrEditView(ctx, text, keyboard);
  }

  async function showOutboxEventsList(ctx, { filter = "all", page = 1 } = {}) {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", "10");
    if (filter === "failed") {
      params.set("status", "failed");
    }

    const [data, access] = await Promise.all([
      siteRequest("GET", `/events/recent?${params.toString()}`, { actorId: ctx.userId }),
      resolveUserAccess(ctx.userId),
    ]);

    const items = Array.isArray(data?.items) ? data.items : [];
    const pagination = data?.pagination ?? { page: 1, total: 0, totalPages: 0 };

    const lines =
      items.length === 0
        ? filter === "failed"
          ? "✅ هیچ رویداد ناموفقی در صف وجود ندارد."
          : "📭 هنوز رویدادی ثبت نشده است."
        : items
            .map((evt, idx) => {
              const rowNum = (pagination.page - 1) * 10 + idx + 1;
              const statusIcon =
                evt.status === "delivered"
                  ? "✅"
                  : evt.status === "failed"
                    ? "❌"
                    : evt.status === "skipped"
                      ? "⏭️"
                      : "⏳";
              const ref = evt.payload?.orderNumber || evt.payload?.sku || evt.payload?.productName || "";
              const errNote = evt.lastError ? `\n   خطا: ${evt.lastError}` : "";
              return (
                `${formatNumberFa(rowNum)}. ${statusIcon} ${evt.eventType}${ref ? ` (${ref})` : ""}\n` +
                `   وضعیت: ${evt.status} | تلاش: ${formatNumberFa(evt.attempts)}/${formatNumberFa(evt.maxAttempts)} | ${formatDateTimeFa(evt.createdAt)}${errNote}`
              );
            })
            .join("\n");

    const title = filter === "failed" ? "⚠️ فهرست رویدادهای ناموفق" : "📜 آخرین رویدادهای ثبت‌شده";
    const text =
      `${title}\n` +
      `تعداد کل: ${formatNumberFa(pagination.total)} (صفحه ${formatNumberFa(pagination.page)} از ${formatNumberFa(Math.max(1, pagination.totalPages))})\n\n` +
      lines;

    const keyboard = [];
    const navRow = [];
    if (pagination.page > 1) {
      navRow.push({ text: "⬅️ قبلی", callback_data: `alt:list:${filter}:${pagination.page - 1}` });
    }
    if (pagination.page < pagination.totalPages) {
      navRow.push({ text: "بعدی ➡️", callback_data: `alt:list:${filter}:${pagination.page + 1}` });
    }
    if (navRow.length > 0) keyboard.push(navRow);

    if (filter === "failed" && items.length > 0 && access.role === "owner") {
      keyboard.push([
        { text: "🔄 بازیابی و ارسال مجدد ناموفق‌ها", callback_data: "alt:retry" },
      ]);
    }

    keyboard.push([
      { text: "🔙 مرکز هشدارها", callback_data: "alt:sum" },
      { text: "🏠 منوی اصلی", callback_data: "menu:home" },
    ]);

    await sendOrEditView(ctx, text, keyboard);
  }

  /* ---------------------------- ۶. بخش تنظیمات و نقش‌ها ---------------------------- */

  async function showSettingsMenu(ctx) {
    const [settings, access] = await Promise.all([
      siteRequest("GET", "/settings", { actorId: ctx.userId }),
      resolveUserAccess(ctx.userId),
    ]);

    const isOwner = access.role === "owner";

    const text =
      `⚙️ تنظیمات ربات مدیریتی\n` +
      `نقش فعلی شما: ${roleFa(access.role)}\n\n` +
      `• آستانهٔ کم‌موجودی هر واریانت: ${formatNumberFa(settings.lowStockThreshold)} عدد\n` +
      `• آستانهٔ هشدار قدیمی‌شدن سینک: ${formatNumberFa(settings.staleSyncThresholdHours)} ساعت\n\n` +
      `🔔 دسته‌های اعلان خودکار:\n` +
      `• سفارش جدید: ${settings.notifyOrderCreated ? "روشن ✅" : "خاموش ⛔"}\n` +
      `• پرداخت موفق: ${settings.notifyOrderPaid ? "روشن ✅" : "خاموش ⛔"}\n` +
      `• لغو و بازپرداخت: ${settings.notifyOrderCancelled ? "روشن ✅" : "خاموش ⛔"}\n` +
      `• تغییر وضعیت ارسال/تحویل: ${settings.notifyOrderStatusChanged ? "روشن ✅" : "خاموش ⛔"}\n` +
      `• افت موجودی و ناموجودی: ${settings.notifyInventoryAlerts ? "روشن ✅" : "خاموش ⛔"}\n` +
      `• سلامت سرویس و سینک راهکاران: ${settings.notifySyncAndHealth ? "روشن ✅" : "خاموش ⛔"}\n\n` +
      (settings.updatedAt
        ? `آخرین ذخیره: ${formatDateTimeFa(settings.updatedAt)}\n`
        : "") +
      (isOwner
        ? "برای تغییر هر مورد از دکمه‌های زیر استفاده کنید (تغییرات پایدار در دیتابیس ذخیره می‌شوند):"
        : "🔒 تغییر تنظیمات و مدیریت نقش‌ها فقط برای نقش مالک (owner) مجاز است.");

    const keyboard = [];

    if (isOwner) {
      keyboard.push([
        {
          text: `📏 تغییر آستانه کم‌موجودی (فعلی: ${formatNumberFa(settings.lowStockThreshold)})`,
          callback_data: "set:thr",
        },
      ]);
      keyboard.push([
        {
          text: `${settings.notifyOrderCreated ? "✅" : "⛔"} سفارش جدید`,
          callback_data: "set:tog:oc",
        },
        {
          text: `${settings.notifyOrderPaid ? "✅" : "⛔"} پرداخت موفق`,
          callback_data: "set:tog:op",
        },
      ]);
      keyboard.push([
        {
          text: `${settings.notifyOrderCancelled ? "✅" : "⛔"} لغو/بازپرداخت`,
          callback_data: "set:tog:ox",
        },
        {
          text: `${settings.notifyOrderStatusChanged ? "✅" : "⛔"} وضعیت ارسال`,
          callback_data: "set:tog:os",
        },
      ]);
      keyboard.push([
        {
          text: `${settings.notifyInventoryAlerts ? "✅" : "⛔"} هشدار موجودی`,
          callback_data: "set:tog:iv",
        },
        {
          text: `${settings.notifySyncAndHealth ? "✅" : "⛔"} سلامت و سینک`,
          callback_data: "set:tog:sh",
        },
      ]);
      keyboard.push([
        { text: "👥 مدیریت نقش‌ها و گیرندگان مجاز", callback_data: "set:ops" },
      ]);
    }

    keyboard.push([{ text: "🏠 منوی اصلی", callback_data: "menu:home" }]);

    await sendOrEditView(ctx, text, keyboard);
  }

  async function showThresholdPicker(ctx) {
    const settings = await siteRequest("GET", "/settings", { actorId: ctx.userId });
    const current = Number(settings?.lowStockThreshold ?? 3);

    const text =
      `📏 تنظیم آستانهٔ کم‌موجودی واریانت\n` +
      `مقدار فعلی: ${formatNumberFa(current)} عدد\n\n` +
      `وقتی موجودی قابل فروش یک واریانت از بالای آستانه به این عدد یا کمتر برسد، هشدار کم‌موجودی ثبت می‌شود (موجودی صفر هم هشدار ناموجودی جداگانه دارد).`;

    const presets = [1, 2, 3, 5, 10];
    const keyboard = [
      presets.map((n) => ({
        text: n === current ? `• ${formatNumberFa(n)}` : formatNumberFa(n),
        callback_data: `set:thv:${n}`,
      })),
      [{ text: "✏️ واردکردن عدد دلخواه (۱ تا ۱۰۰۰)", callback_data: "set:thc" }],
      [
        { text: "🔙 بازگشت به تنظیمات", callback_data: "set:sum" },
        { text: "🏠 منوی اصلی", callback_data: "menu:home" },
      ],
    ];

    await sendOrEditView(ctx, text, keyboard);
  }

  async function showOperatorsMenu(ctx) {
    const res = await siteRequest("GET", "/settings/operators", { actorId: ctx.userId });
    const operators = Array.isArray(res?.operators) ? res.operators : [];

    const lines =
      operators.length === 0
        ? "هیچ اپراتوری ثبت نشده است."
        : operators
            .map((op, i) => {
              const statusIcon = op.isActive ? "🟢" : "⚪";
              const pinNote = op.isEnvPinned ? " [تنظیم سرور]" : "";
              return `${formatNumberFa(i + 1)}. ${statusIcon} ${op.baleUserId} — ${roleFa(op.role)}${pinNote}`;
            })
            .join("\n");

    const text =
      `👥 مدیریت نقش‌ها و گیرندگان اعلان\n\n` +
      `${lines}\n\n` +
      `نقش‌های قابل اختصاص:\n` +
      `• owner: دسترسی کامل + اطلاعات مشتری + تنظیمات\n` +
      `• admin: گزارش‌ها + سفارش‌ها و اطلاعات تحویل مشتری (بدون تغییر تنظیمات)\n` +
      `• orders-read-only: فقط سفارش‌ها بدون اطلاعات شخصی مشتری\n` +
      `• reports-read-only: گزارش‌های فروش/موجودی بدون اطلاعات شخصی مشتری`;

    const keyboard = operators
      .slice(0, 12)
      .map((op) => [
        {
          text: `👤 ${op.baleUserId} (${op.role})`,
          callback_data: `set:op:${op.baleUserId}`,
        },
      ]);

    keyboard.push([
      { text: "➕ افزودن / تغییر نقش شناسهٔ بله", callback_data: "set:opadd" },
    ]);
    keyboard.push([
      { text: "🔙 بازگشت به تنظیمات", callback_data: "set:sum" },
      { text: "🏠 منوی اصلی", callback_data: "menu:home" },
    ]);

    await sendOrEditView(ctx, text, keyboard);
  }

  async function showSingleOperatorDetail(ctx, targetBaleId) {
    const res = await siteRequest("GET", "/settings/operators", { actorId: ctx.userId });
    const operators = Array.isArray(res?.operators) ? res.operators : [];
    const op = operators.find((item) => item.baleUserId === targetBaleId);

    if (!op) {
      await showOperatorsMenu(ctx);
      return;
    }

    const text =
      `👤 جزئیات دسترسی کاربر بله: ${op.baleUserId}\n` +
      `وضعیت: ${op.isActive ? "فعال 🟢" : "غیرفعال ⚪"}${op.isEnvPinned ? " (تعریف‌شده در env سرور)" : ""}\n` +
      `نقش فعلی: ${roleFa(op.role)}\n\n` +
      `گیرندهٔ اعلان‌های خودکار:\n` +
      `• اعلان سفارش‌ها: ${op.receiveOrderAlerts ? "روشن ✅" : "خاموش ⛔"}\n` +
      `• اعلان موجودی: ${op.receiveInventoryAlerts ? "روشن ✅" : "خاموش ⛔"}\n` +
      `• اعلان سلامت سیستم: ${op.receiveHealthAlerts ? "روشن ✅" : "خاموش ⛔"}`;

    const keyboard = [
      [
        { text: "نقش: owner", callback_data: `set:opr:${targetBaleId}:ow` },
        { text: "نقش: admin", callback_data: `set:opr:${targetBaleId}:ad` },
      ],
      [
        { text: "orders-read-only", callback_data: `set:opr:${targetBaleId}:or` },
        { text: "reports-read-only", callback_data: `set:opr:${targetBaleId}:rr` },
      ],
      [
        {
          text: `${op.receiveOrderAlerts ? "✅" : "⛔"} اعلان سفارش`,
          callback_data: `set:opt:${targetBaleId}:ord:${op.receiveOrderAlerts ? 0 : 1}`,
        },
        {
          text: `${op.receiveInventoryAlerts ? "✅" : "⛔"} اعلان موجودی`,
          callback_data: `set:opt:${targetBaleId}:inv:${op.receiveInventoryAlerts ? 0 : 1}`,
        },
      ],
    ];

    if (op.isActive && !op.isEnvPinned && targetBaleId !== ctx.userId) {
      keyboard.push([
        { text: "🚫 غیرفعال‌کردن دسترسی این کاربر", callback_data: `set:opdel:${targetBaleId}` },
      ]);
    } else if (!op.isActive) {
      keyboard.push([
        { text: "✅ فعال‌سازی مجدد کاربر", callback_data: `set:opt:${targetBaleId}:act:1` },
      ]);
    }

    keyboard.push([
      { text: "🔙 فهرست اپراتورها", callback_data: "set:ops" },
      { text: "🏠 منوی اصلی", callback_data: "menu:home" },
    ]);

    await sendOrEditView(ctx, text, keyboard);
  }

  /* ----------------------- مدیریت خطای یکپارچه ----------------------- */

  async function safely(ctx, task) {
    try {
      await task();
    } catch (error) {
      if (error instanceof SiteApiError) {
        if (error.status === 403) {
          await sendOrEditView(
            ctx,
            `⛔ ${error.bodyMessage || "شما دسترسی لازم برای مشاهدهٔ این بخش یا انجام این عملیات را ندارید."}`,
            [[{ text: "🏠 منوی اصلی", callback_data: "menu:home" }]],
          );
          return;
        }
        if (error.status === 400) {
          await sendOrEditView(
            ctx,
            `⚠️ درخواست معتبر نیست: ${error.bodyMessage || "پارامترهای ورودی را بررسی کنید."}`,
            [[{ text: "🏠 منوی اصلی", callback_data: "menu:home" }]],
          );
          return;
        }
      }

      logger.error("Report/menu action failed.", sanitizeLogReason(error));
      try {
        await sendMessage(
          ctx.chatId,
          "⚠️ گرفتن گزارش فعلاً انجام نشد (خطای موقت سرویس یا ارتباط). لطفاً کمی بعد دوباره تلاش کنید.",
        );
      } catch (sendError) {
        logger.error("Sending error reply failed.", sanitizeLogReason(sendError));
      }
    }
  }

  /* ----------------------- پردازش ورودی‌های متنی ----------------------- */

  function takePendingInput(userId) {
    const pending = pendingInput.get(userId);
    if (!pending) return null;
    pendingInput.delete(userId);
    return Date.now() <= pending.expiresAt ? pending : null;
  }

  async function handleMessage(message) {
    // فقط گفت‌وگوی خصوصی یک‌به‌یک؛ چت گروهی و کانال مطلقاً نادیده گرفته می‌شوند
    if (!isPrivateOneToOne(message)) return;

    const userId = String(message.from.id);
    const chatId = message.chat.id;
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const command = commandName(text);
    const ctx = { userId, chatId, messageId: null };

    if (command === "id") {
      await sendMessage(
        chatId,
        `شناسه عددی بله شما:\n${userId}\n\nاین شناسه را فقط به مالک ربات بدهید تا نقش مناسب را برایتان فعال کند.`,
      );
      return;
    }

    let access;
    try {
      access = await resolveUserAccess(userId);
    } catch (error) {
      logger.error("Access check failed.", sanitizeLogReason(error));
      await sendMessage(
        chatId,
        "⚠️ بررسی دسترسی موقتاً به دلیل خطای ارتباط با سایت انجام نشد. لطفاً لحظاتی دیگر تلاش کنید.",
      );
      return;
    }

    if (!access.authorized) {
      await sendMessage(chatId, "⛔ دسترسی این حساب هنوز برای ربات فعال نشده است.", {
        remove_keyboard: true,
      });
      return;
    }

    if (isCancelText(text)) {
      pendingInput.delete(userId);
      await sendMessage(chatId, "✅ عملیات جاری لغو شد. یک بخش را از منو انتخاب کنید:");
      return;
    }

    if (command === "start" || command === "menu") {
      pendingInput.delete(userId);
      await sendMessage(
        chatId,
        `به پنل مدیریت Zoppini خوش آمدید.\nنقش شما: ${roleFa(access.role)}\nیک بخش را از دکمه‌های پایین انتخاب کنید:`,
      );
      return;
    }

    if (command === "help") {
      await sendMessage(
        chatId,
        "راهنمای ربات مدیریتی Zoppini:\n" +
          "• 📊 فروش: خلاصه و خروجی CSV فروش امروز، دیروز، ۷ روز اخیر و ماه جاری\n" +
          "• 🧾 سفارش‌ها: خلاصهٔ امروز، آخرین سفارش‌ها با صفحه‌بندی، فیلتر و جزئیات\n" +
          "• 📦 موجودی کالا: تفکیک ناموجود و کم‌موجود، جست‌وجوی SKU و فایل CSV\n" +
          "• 👥 مشتری‌ها: آمار مشتریان جدید و تکراری\n" +
          "• 🔔 هشدارها: وضعیت سلامت سرویس و صف اعلان‌های خودکار\n" +
          "• ⚙️ تنظیمات: آستانهٔ موجودی کم، اعلان‌ها و مدیریت نقش‌ها\n" +
          "• /cancel: لغو عملیات جاری | /id: نمایش شناسهٔ بلهٔ شما",
      );
      return;
    }

    // انتخاب هر دکمهٔ اصلی منو، عملیات متنیِ در انتظار را لغو می‌کند
    if (text === BUTTONS.sales || command === "sales") {
      pendingInput.delete(userId);
      return safely(ctx, () => showSalesReport(ctx, "today"));
    }
    if (text === BUTTONS.orders || command === "orders") {
      pendingInput.delete(userId);
      return safely(ctx, () => showOrdersSummary(ctx));
    }
    if (text === BUTTONS.stock || command === "stock") {
      pendingInput.delete(userId);
      return safely(ctx, () => showInventorySummary(ctx));
    }
    if (text === BUTTONS.customers || command === "customers") {
      pendingInput.delete(userId);
      return safely(ctx, () => showCustomersReport(ctx, "today"));
    }
    if (text === BUTTONS.alerts || command === "alerts") {
      pendingInput.delete(userId);
      return safely(ctx, () => showAlertsCenter(ctx));
    }
    if (text === BUTTONS.settings || command === "settings") {
      pendingInput.delete(userId);
      return safely(ctx, () => showSettingsMenu(ctx));
    }

    const pending = takePendingInput(userId);
    if (pending) {
      if (pending.kind === "order-number") {
        const orderNumber = normalizeOrderNumber(text);
        if (!/^[\p{L}\p{N}-]{2,64}$/u.test(orderNumber)) {
          await sendMessage(
            chatId,
            "⚠️ شمارهٔ سفارش معتبر به نظر نمی‌رسد. دوباره از بخش سفارش‌ها تلاش کنید.",
          );
          return;
        }
        return safely(ctx, () => showOrderDetail(ctx, orderNumber));
      }

      if (pending.kind === "inventory-search") {
        const normalized = normalizeDigits(text).trim();
        if (!normalized || normalized.length > 100 || /[\u0000-\u001f\u007f]/.test(normalized)) {
          await sendMessage(chatId, "⚠️ عبارت جست‌وجو معتبر نیست (حداکثر ۱۰۰ کاراکتر).");
          return;
        }
        return safely(ctx, () => showInventoryList(ctx, { category: "all", page: 1, query: normalized }));
      }

      if (pending.kind === "custom-sales-range") {
        const normalized = normalizeDigits(text).trim();
        const match = normalized.match(/^(\d{4}-\d{2}-\d{2})\s+(?:تا\s+|to\s+)?(\d{4}-\d{2}-\d{2})$/i);
        if (!match) {
          await sendMessage(
            chatId,
            "⚠️ فرمت بازه معتبر نیست. مثال صحیح:\n2026-10-01 2026-10-26",
          );
          return;
        }
        return safely(ctx, () =>
          showSalesReport(ctx, {
            key: "custom",
            label: "بازهٔ دلخواه",
            from: match[1],
            to: match[2],
          }),
        );
      }

      if (pending.kind === "custom-threshold") {
        const num = Number(normalizeDigits(text).trim());
        if (!Number.isInteger(num) || num < 1 || num > 1000) {
          await sendMessage(chatId, "⚠️ آستانه باید یک عدد صحیح بین ۱ تا ۱۰۰۰ باشد.");
          return;
        }
        return safely(ctx, async () => {
          await siteRequest("PATCH", "/settings", {
            actorId: userId,
            body: { lowStockThreshold: num },
          });
          await showSettingsMenu(ctx);
        });
      }

      if (pending.kind === "add-operator-id") {
        const targetId = normalizeDigits(text).trim();
        if (!/^\d{1,20}$/.test(targetId)) {
          await sendMessage(chatId, "⚠️ شناسهٔ بله باید فقط عدد مثبت باشد (مثال: 123456789).");
          return;
        }
        return safely(ctx, async () => {
          await sendOrEditView(
            ctx,
            `نقش موردنظر برای شناسهٔ بله ${targetId} را انتخاب کنید:`,
            [
              [
                { text: "مدیر (admin)", callback_data: `set:opr:${targetId}:ad` },
                { text: "مالک (owner)", callback_data: `set:opr:${targetId}:ow` },
              ],
              [
                { text: "فقط سفارش‌ها (orders-read-only)", callback_data: `set:opr:${targetId}:or` },
                { text: "فقط گزارش‌ها (reports-read-only)", callback_data: `set:opr:${targetId}:rr` },
              ],
              [{ text: "❌ لغو", callback_data: "set:ops" }],
            ],
          );
        });
      }
    }

    await sendMessage(chatId, "برای ادامه یکی از دکمه‌های منوی پایین صفحه را انتخاب کنید.");
  }

  /* -------------------- پردازش دکمه‌های شیشه‌ای (Callback) -------------------- */

  async function handleCallbackQuery(callbackQuery) {
    const msg = callbackQuery?.message;
    const from = callbackQuery?.from;
    if (
      !msg ||
      msg.chat?.type !== "private" ||
      !from?.id ||
      String(msg.chat.id) !== String(from.id)
    ) {
      return;
    }

    const userId = String(from.id);
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const data = String(callbackQuery.data ?? "");
    const ctx = { userId, chatId, messageId };

    let access;
    try {
      access = await resolveUserAccess(userId);
    } catch {
      await answerCallback(callbackQuery.id, "خطای موقت در بررسی دسترسی");
      return;
    }

    if (!access.authorized) {
      await answerCallback(callbackQuery.id, "دسترسی غیرمجاز");
      return;
    }

    await answerCallback(callbackQuery.id);

    if (data === "menu:home") {
      pendingInput.delete(userId);
      await sendMessage(chatId, "منوی اصلی مدیریت Zoppini — یک بخش را انتخاب کنید:", mainKeyboard);
      return;
    }

    if (data === "nav:cancel") {
      pendingInput.delete(userId);
      await sendMessage(chatId, "✅ عملیات لغو شد.", mainKeyboard);
      return;
    }

    // سفارش‌ها
    if (data === "ord:sum") {
      pendingInput.delete(userId);
      return safely(ctx, () => showOrdersSummary(ctx));
    }
    if (data === "ord:search") {
      return safely(ctx, () => promptOrderNumberSearch(ctx));
    }
    if (data.startsWith("ord:l:")) {
      pendingInput.delete(userId);
      const [, , rawPage, status = "all", rangeKey = "all"] = data.split(":");
      return safely(ctx, () =>
        showOrdersList(ctx, { page: Number(rawPage) || 1, status, rangeKey }),
      );
    }
    if (data.startsWith("ord:d:") || data.startsWith("ord:dr:")) {
      pendingInput.delete(userId);
      const parts = data.split(":");
      const isRef = parts[1] === "dr";
      const orderNumber = isRef ? orderRefToNumber.get(parts[2]) : parts[2];
      const piiFlag = parts[3] === "1";
      const backPage = Number(parts[4]) || 1;
      const backStatus = parts[5] || "all";
      const backRange = parts[6] || "all";
      if (!orderNumber) {
        return safely(ctx, () => showOrdersList(ctx));
      }
      return safely(ctx, () =>
        showOrderDetail(ctx, orderNumber, {
          includeCustomer: piiFlag,
          backPage,
          backStatus,
          backRange,
        }),
      );
    }

    // فروش
    if (data.startsWith("sal:r:")) {
      pendingInput.delete(userId);
      const rangeKey = data.slice("sal:r:".length);
      return safely(ctx, () => showSalesReport(ctx, rangeKey));
    }
    if (data === "sal:custom") {
      pendingInput.set(userId, {
        kind: "custom-sales-range",
        expiresAt: Date.now() + PENDING_INPUT_TTL_MS,
      });
      return sendOrEditView(
        ctx,
        "📅 بازهٔ تاریخ میلادی را به صورت زیر بفرستید:\nYYYY-MM-DD YYYY-MM-DD\nمثال: 2026-10-01 2026-10-26",
        [[{ text: "❌ لغو", callback_data: "sal:r:today" }]],
      );
    }
    if (data.startsWith("sal:csv:")) {
      const [, , from, to] = data.split(":");
      return safely({ userId, chatId, messageId: null }, () =>
        exportAndSendSalesCsv({ userId, chatId }, from, to),
      );
    }

    // موجودی کالا
    if (data === "inv:sum") {
      pendingInput.delete(userId);
      return safely(ctx, () => showInventorySummary(ctx));
    }
    if (data === "inv:search") {
      return safely(ctx, () => promptInventorySearch(ctx));
    }
    if (data.startsWith("inv:l:")) {
      pendingInput.delete(userId);
      const [, , category, rawPage] = data.split(":");
      return safely(ctx, () =>
        showInventoryList(ctx, { category, page: Number(rawPage) || 1 }),
      );
    }
    if (data.startsWith("inv:q:")) {
      const rawPage = data.slice("inv:q:".length);
      const savedQuery = userInventorySearch.get(userId) || "";
      return safely(ctx, () =>
        showInventoryList(ctx, {
          category: "all",
          page: Number(rawPage) || 1,
          query: savedQuery,
        }),
      );
    }
    if (data.startsWith("inv:csv:")) {
      const target = data.slice("inv:csv:".length);
      return safely({ userId, chatId, messageId: null }, () =>
        exportAndSendInventoryCsv({ userId, chatId }, target),
      );
    }

    // مشتری‌ها
    if (data.startsWith("cus:r:")) {
      const rangeKey = data.slice("cus:r:".length);
      return safely(ctx, () => showCustomersReport(ctx, rangeKey));
    }

    // هشدارها و سلامت
    if (data === "alt:sum") {
      return safely(ctx, () => showAlertsCenter(ctx));
    }
    if (data.startsWith("alt:list:")) {
      const [, , filter, rawPage] = data.split(":");
      return safely(ctx, () =>
        showOutboxEventsList(ctx, { filter, page: Number(rawPage) || 1 }),
      );
    }
    if (data === "alt:retry") {
      return safely(ctx, async () => {
        const res = await siteRequest("POST", "/events/retry-failed", {
          actorId: userId,
          body: {},
        });
        await sendMessage(
          chatId,
          `🔄 تعداد ${formatNumberFa(res?.requeued ?? 0)} رویداد ناموفق برای ارسال مجدد در صف قرار گرفت.`,
        );
        await showAlertsCenter({ userId, chatId, messageId: null });
      });
    }

    // تنظیمات و نقش‌ها
    if (data === "set:sum") {
      pendingInput.delete(userId);
      return safely(ctx, () => showSettingsMenu(ctx));
    }
    if (data === "set:thr") {
      return safely(ctx, () => showThresholdPicker(ctx));
    }
    if (data.startsWith("set:thv:")) {
      const val = Number(data.slice("set:thv:".length));
      return safely(ctx, async () => {
        await siteRequest("PATCH", "/settings", {
          actorId: userId,
          body: { lowStockThreshold: val },
        });
        await showSettingsMenu(ctx);
      });
    }
    if (data === "set:thc") {
      pendingInput.set(userId, {
        kind: "custom-threshold",
        expiresAt: Date.now() + PENDING_INPUT_TTL_MS,
      });
      return sendOrEditView(
        ctx,
        "✏️ عدد جدید آستانهٔ کم‌موجودی (بین ۱ تا ۱۰۰۰) را ارسال کنید:",
        [[{ text: "❌ لغو", callback_data: "set:sum" }]],
      );
    }
    if (data.startsWith("set:tog:")) {
      const code = data.slice("set:tog:".length);
      const meta = SETTING_TOGGLE_CODES[code];
      if (!meta) return;
      return safely(ctx, async () => {
        const current = await siteRequest("GET", "/settings", { actorId: userId });
        const nextVal = !current?.[meta.field];
        await siteRequest("PATCH", "/settings", {
          actorId: userId,
          body: { [meta.field]: nextVal },
        });
        await showSettingsMenu(ctx);
      });
    }
    if (data === "set:ops") {
      return safely(ctx, () => showOperatorsMenu(ctx));
    }
    if (data === "set:opadd") {
      pendingInput.set(userId, {
        kind: "add-operator-id",
        expiresAt: Date.now() + PENDING_INPUT_TTL_MS,
      });
      return sendOrEditView(
        ctx,
        "👤 شناسهٔ عددی بلهٔ کاربر جدید را ارسال کنید (کاربر می‌تواند با ارسال /id به ربات شناسه‌اش را دریافت کند):",
        [[{ text: "❌ لغو", callback_data: "set:ops" }]],
      );
    }
    if (data.startsWith("set:op:")) {
      const targetId = data.slice("set:op:".length);
      return safely(ctx, () => showSingleOperatorDetail(ctx, targetId));
    }
    if (data.startsWith("set:opr:")) {
      const [, , targetId, roleCode] = data.split(":");
      const mappedRole = ROLE_CODES[roleCode];
      if (!mappedRole) return;
      return safely(ctx, async () => {
        await siteRequest("PUT", `/settings/operators/${encodeURIComponent(targetId)}`, {
          actorId: userId,
          body: { role: mappedRole, isActive: true },
        });
        callerProfileCache.delete(targetId);
        await showSingleOperatorDetail(ctx, targetId);
      });
    }
    if (data.startsWith("set:opt:")) {
      const [, , targetId, flagKey, rawFlagVal] = data.split(":");
      const boolVal = rawFlagVal === "1";
      const patch =
        flagKey === "ord"
          ? { receiveOrderAlerts: boolVal }
          : flagKey === "inv"
            ? { receiveInventoryAlerts: boolVal }
            : flagKey === "act"
              ? { isActive: boolVal }
              : null;
      if (!patch) return;
      return safely(ctx, async () => {
        await siteRequest("PUT", `/settings/operators/${encodeURIComponent(targetId)}`, {
          actorId: userId,
          body: patch,
        });
        callerProfileCache.delete(targetId);
        await showSingleOperatorDetail(ctx, targetId);
      });
    }
    if (data.startsWith("set:opdel:")) {
      const targetId = data.slice("set:opdel:".length);
      return safely(ctx, async () => {
        await siteRequest("DELETE", `/settings/operators/${encodeURIComponent(targetId)}`, {
          actorId: userId,
        });
        callerProfileCache.delete(targetId);
        await showOperatorsMenu(ctx);
      });
    }
  }

  async function handleUpdate(update) {
    if (update?.message) {
      await handleMessage(update.message);
    } else if (update?.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  }

  /* -------------- Worker صف اعلان‌ها (Outbox Lease / Ack) و سلامت -------------- */

  async function notifyHealthRecipientsDirectly(messageText) {
    for (const recipientId of knownHealthRecipients) {
      if (!/^\d+$/.test(recipientId)) continue;
      try {
        await sendMessage(recipientId, messageText);
      } catch (error) {
        logger.warn("Direct health notification to owner failed.", sanitizeLogReason(error));
      }
    }
  }

  async function pollOutboxOnce() {
    if (!config.siteApiBase || !config.siteApiToken || outboxBusy) {
      return { leased: 0, delivered: 0 };
    }

    outboxBusy = true;
    try {
      const leaseResponse = await siteRequest("POST", "/events/lease", {
        actorId: "system",
        chatType: "system",
        body: { workerId: "zoppini-bale-bot", limit: 10 },
      });

      if (Array.isArray(leaseResponse?.healthRecipients)) {
        for (const id of leaseResponse.healthRecipients) {
          if (/^\d+$/.test(String(id))) knownHealthRecipients.add(String(id));
        }
      }

      if (siteApiOutageOpen) {
        siteApiOutageOpen = false;
        consecutiveSiteApiFailures = 0;
        await notifyHealthRecipientsDirectly(
          `✅ بازیابی سرویس: ارتباط ربات با API سایت مجدداً برقرار شد.\nزمان: ${formatDateTimeFa(new Date().toISOString())}`,
        );
      } else {
        consecutiveSiteApiFailures = 0;
      }

      const events = Array.isArray(leaseResponse?.events) ? leaseResponse.events : [];
      if (events.length === 0) {
        return { leased: 0, delivered: 0 };
      }

      const ackResults = [];
      let deliveredCount = 0;

      for (const evt of events) {
        const recipients = Array.isArray(evt.recipients)
          ? evt.recipients.filter((id) => /^\d+$/.test(String(id)))
          : [];

        if (recipients.length === 0) {
          ackResults.push({
            eventId: evt.eventId,
            leaseToken: evt.leaseToken,
            outcome: "delivered",
          });
          continue;
        }

        const formatted = formatOutboxEventMessage(evt);
        const markup = formatted.inlineKeyboard
          ? { inline_keyboard: formatted.inlineKeyboard }
          : mainKeyboard;

        let transientFailures = 0;
        let permanentFailures = 0;
        let lastErrorMessage = "";

        for (const recipientId of recipients) {
          const dedupKey = `${evt.eventId}:${recipientId}`;
          if (deliveredRecipientPairs.has(dedupKey)) {
            continue;
          }

          try {
            await sendMessage(recipientId, formatted.text, markup);
            recordDeliveredPair(evt.eventId, recipientId);
          } catch (error) {
            lastErrorMessage = sanitizeLogReason(error);
            const status = Number(error?.status ?? 0);
            if (status === 400 || status === 403 || status === 404) {
              // خطای دائمی این چت خاص (مثلاً کاربر ربات را بلاک کرده)؛ سایر گیرنده‌ها معطل نمی‌شوند
              permanentFailures += 1;
              logger.warn(
                `Permanent Bale delivery failure for event ${evt.eventId}.`,
                lastErrorMessage,
              );
            } else {
              transientFailures += 1;
            }
          }
        }

        if (transientFailures > 0) {
          ackResults.push({
            eventId: evt.eventId,
            leaseToken: evt.leaseToken,
            outcome: "retry",
            error: lastErrorMessage,
          });
        } else if (permanentFailures === recipients.length) {
          ackResults.push({
            eventId: evt.eventId,
            leaseToken: evt.leaseToken,
            outcome: "failed",
            error: lastErrorMessage || "تحویل به هیچ‌یک از گیرندگان ممکن نشد.",
          });
        } else {
          deliveredCount += 1;
          ackResults.push({
            eventId: evt.eventId,
            leaseToken: evt.leaseToken,
            outcome: "delivered",
          });
        }
      }

      if (ackResults.length > 0) {
        await siteRequest("POST", "/events/ack", {
          actorId: "system",
          chatType: "system",
          body: { results: ackResults },
        });
      }

      persistBotState();
      return { leased: events.length, delivered: deliveredCount };
    } catch (error) {
      consecutiveSiteApiFailures += 1;
      logger.error(
        `Outbox polling failed (count=${consecutiveSiteApiFailures}).`,
        sanitizeLogReason(error),
      );

      if (
        consecutiveSiteApiFailures >= OUTAGE_CONSECUTIVE_FAILURES_THRESHOLD &&
        !siteApiOutageOpen
      ) {
        siteApiOutageOpen = true;
        await notifyHealthRecipientsDirectly(
          `🚨 هشدار سلامت سرویس: ارتباط ربات با API سایت دچار اختلال شده است.\n` +
            `تعداد خطاهای متوالی: ${formatNumberFa(consecutiveSiteApiFailures)}\n` +
            `خلاصه وضعیت: ${sanitizeLogReason(error)}\n` +
            `زمان: ${formatDateTimeFa(new Date().toISOString())}\n` +
            `(تا رفع مشکل پیام تکراری ارسال نخواهد شد)`,
        );
      }

      return { leased: 0, delivered: 0, error: sanitizeLogReason(error) };
    } finally {
      outboxBusy = false;
    }
  }

  /* --------------------------- حلقهٔ Polling بله --------------------------- */

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
          allowed_updates: ["message", "callback_query"],
        },
        controller.signal,
      );
      writeHeartbeat("ok");
      const safeUpdates = Array.isArray(updates) ? updates : [];
      for (const update of safeUpdates) {
        nextUpdateOffset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (error) {
          logger.error("Update handling failed.", sanitizeLogReason(error));
        }
      }
      if (safeUpdates.length > 0) {
        persistBotState();
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
      logger.warn("Bale getMe check failed; continuing with polling.", sanitizeLogReason(error));
    }
  }

  async function run() {
    logger.log("Zoppini Bale management bot starting in private-chat mode.");
    if (!config.siteApiBase || !config.siteApiToken) {
      logger.warn(
        "Site API is not configured (ZOPPINI_SITE_API_BASE_URL / ZOPPINI_BOT_SERVICE_TOKEN).",
      );
    }
    await verifyBaleConnection();
    writeHeartbeat("starting");

    if (config.siteApiBase && config.siteApiToken) {
      outboxTimer = setInterval(() => {
        void pollOutboxOnce();
      }, config.outboxPollIntervalMs);
      outboxTimer.unref?.();
      void pollOutboxOnce();
    }

    let consecutiveFailures = 0;
    while (!stopping) {
      try {
        await pollOnce();
        consecutiveFailures = 0;
      } catch (error) {
        if (stopping) break;
        consecutiveFailures += 1;
        writeHeartbeat("degraded");
        const backoffSeconds = Math.min(30, 3 * consecutiveFailures);
        const retrySeconds = Number.isInteger(error?.retryAfter) ? error.retryAfter : backoffSeconds;
        if (error?.status === 409) {
          logger.error(
            "Bale returned 409 (conflict): another bot instance is polling or a webhook is active.",
          );
        }
        logger.error(
          `Bale polling failed; retrying in ${retrySeconds}s.`,
          sanitizeLogReason(error),
        );
        await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000));
      }
    }
    if (outboxTimer) {
      clearInterval(outboxTimer);
      outboxTimer = null;
    }
    persistBotState();
    logger.log("Zoppini Bale bot stopped cleanly.");
  }

  function stop(signal = "stop") {
    if (stopping) return;
    stopping = true;
    logger.log(`Received ${signal}; stopping…`);
    if (outboxTimer) {
      clearInterval(outboxTimer);
      outboxTimer = null;
    }
    activePollController?.abort();
  }

  return {
    run,
    stop,
    pollOnce,
    pollOutboxOnce,
    handleMessage,
    handleCallbackQuery,
    handleUpdate,
  };
}

/* ------------------------------------------------------------------ */
/* نقطهٔ ورود و بررسی سلامت کانتینر (--healthcheck)                   */
/* ------------------------------------------------------------------ */

export function runCliHealthcheck(env = process.env) {
  const cfg = readConfig(env);
  if (!cfg.heartbeatFilePath) {
    return Boolean(cfg.baleToken);
  }
  if (!existsSync(cfg.heartbeatFilePath)) {
    return false;
  }
  const data = JSON.parse(readFileSync(cfg.heartbeatFilePath, "utf8"));
  const maxAgeMs = (cfg.pollingTimeoutSeconds + 60) * 1000;
  return Number.isFinite(data?.updatedAt) && Date.now() - data.updatedAt <= maxAgeMs;
}

async function main() {
  if (process.argv.includes("--healthcheck")) {
    const healthy = runCliHealthcheck();
    process.exit(healthy ? 0 : 1);
  }

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
