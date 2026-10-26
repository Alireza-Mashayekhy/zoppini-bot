export const ORDER_STATUS_FA = {
  pending: "در انتظار پرداخت",
  paid: "پرداخت‌شده (آماده ارسال)",
  shipped: "ارسال‌شده",
  delivered: "تحویل‌شده",
  cancelled: "لغوشده",
};

export const ROLE_FA = {
  owner: "مالک فروشگاه (owner)",
  admin: "مدیر فروشگاه (admin)",
  "orders-read-only": "مشاهدهٔ سفارش‌ها (orders-read-only)",
  "reports-read-only": "مشاهدهٔ گزارش‌ها (reports-read-only)",
};

export const SHIPPING_METHOD_FA = {
  post: "پست",
  courier: "پیک",
  tibax: "تیپاکس",
};

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

export function money(value, currency = "IRT") {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "نامشخص";
  const formatted = new Intl.NumberFormat("fa-IR").format(amount);
  const unit = currency === "IRT" ? "تومان" : currency === "IRR" ? "ریال" : currency;
  return `${formatted} ${unit}`;
}

export function orderStatusFa(status) {
  const raw = String(status ?? "").toLowerCase();
  if (raw === "paid") return "پرداخت‌شده";
  return ORDER_STATUS_FA[raw] ?? status ?? "نامشخص";
}

export function roleFa(role) {
  return ROLE_FA[String(role ?? "")] ?? role ?? "نامشخص";
}

export function shippingMethodFa(method) {
  if (!method) return "نامشخص";
  return SHIPPING_METHOD_FA[String(method).toLowerCase()] ?? method;
}

export function dateInTehran(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function addDaysIso(isoDate, deltaDays) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return utc.toISOString().slice(0, 10);
}

/**
 * محاسبهٔ بازه‌های استاندارد گزارش بر اساس منطقهٔ زمانی تهران و تقویم شمسی برای «ماه جاری».
 */
export function resolvePresetRange(rangeKey, now = new Date()) {
  const today = dateInTehran(now);

  switch (rangeKey) {
    case "yesterday": {
      const yesterday = addDaysIso(today, -1);
      return { key: "yesterday", label: "دیروز", from: yesterday, to: yesterday };
    }
    case "7d": {
      const from = addDaysIso(today, -6);
      return { key: "7d", label: "۷ روز اخیر", from, to: today };
    }
    case "month": {
      const persianParts = new Intl.DateTimeFormat("en-u-ca-persian", {
        timeZone: "Asia/Tehran",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now);
      const dayPart = Number(persianParts.find((p) => p.type === "day")?.value ?? "1");
      const offsetDays = Math.max(0, (Number.isFinite(dayPart) ? dayPart : 1) - 1);
      const from = addDaysIso(today, -offsetDays);
      return { key: "month", label: "ماه جاری شمسی", from, to: today };
    }
    case "today":
    default:
      return { key: "today", label: "امروز", from: today, to: today };
  }
}

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

export function formatDateFa(isoDate) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return String(isoDate ?? "نامشخص");
  const date = new Date(`${isoDate}T12:00:00+03:30`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    dateStyle: "medium",
  }).format(date);
}

export function formatSyncStatusLine(sync) {
  if (!sync) {
    return "وضعیت همگام‌سازی راهکاران: نامشخص";
  }

  const lastOk = sync.lastSucceededAt ?? sync.fallbackVariantUpdatedAt;
  const lastOkText = lastOk ? formatDateTimeFa(lastOk) : "ثبت نشده";

  if (sync.status === "failed") {
    const failTime = sync.lastFailedAt ? formatDateTimeFa(sync.lastFailedAt) : "نامشخص";
    const errText = sync.lastError ? `\nعلت آخرین خطا: ${sync.lastError}` : "";
    return (
      `❌ آخرین تلاش همگام‌سازی ناموفق (${failTime})\n` +
      `آخرین sync موفق قبلی: ${lastOkText}` +
      errText
    );
  }

  if (sync.isStale) {
    return (
      `⚠️ همگام‌سازی قدیمی است (بیش از ${formatNumberFa(sync.staleThresholdHours ?? 30)} ساعت گذشته)\n` +
      `آخرین همگام‌سازی موفق: ${lastOkText}`
    );
  }

  if (sync.status === "partial_error") {
    return (
      `⚠️ آخرین همگام‌سازی با خطای جزئی: ${lastOkText}` +
      (sync.lastError ? `\nتوضیح: ${sync.lastError}` : "")
    );
  }

  if (sync.status === "running") {
    return `🔄 همگام‌سازی در حال اجراست (آخرین موفق: ${lastOkText})`;
  }

  if (!lastOk) {
    return "ℹ️ همگام‌سازی راهکاران: هنوز زمان ثبت‌شده‌ای وجود ندارد";
  }

  return `✅ آخرین همگام‌سازی موفق: ${lastOkText}`;
}

export function formatOutboxEventMessage(event) {
  const payload = event?.payload ?? {};
  const type = event?.eventType;

  switch (type) {
    case "order.created": {
      const orderNumber = payload.orderNumber ?? "نامشخص";
      const total = money(payload.finalPrice ?? 0, payload.currency ?? "IRT");
      const status = orderStatusFa(payload.status ?? "pending");
      const time = formatDateTimeFa(payload.occurredAt ?? event.createdAt);
      const itemsLine =
        Number(payload.itemsCount) > 0
          ? `تعداد اقلام: ${formatNumberFa(payload.itemsCount)}\n`
          : "";
      return {
        text:
          `🆕 ثبت سفارش جدید\n` +
          `شماره سفارش: ${orderNumber}\n` +
          `وضعیت: ${status}\n` +
          itemsLine +
          `مبلغ سفارش: ${total}\n` +
          `زمان: ${time}`,
        inlineKeyboard: [
          [{ text: "🧾 مشاهده جزئیات سفارش", callback_data: `ord:d:${orderNumber}:0:1:all:all` }],
        ],
      };
    }

    case "order.paid": {
      const orderNumber = payload.orderNumber ?? "نامشخص";
      const total = money(payload.finalPrice ?? 0, payload.currency ?? "IRT");
      const time = formatDateTimeFa(payload.occurredAt ?? event.createdAt);
      return {
        text:
          `💳 پرداخت موفق سفارش\n` +
          `شماره سفارش: ${orderNumber}\n` +
          `وضعیت: پرداخت‌شده (آماده پردازش/ارسال)\n` +
          `مبلغ پرداخت‌شده: ${total}\n` +
          `زمان تأیید: ${time}`,
        inlineKeyboard: [
          [{ text: "🧾 مشاهده جزئیات سفارش", callback_data: `ord:d:${orderNumber}:0:1:all:all` }],
        ],
      };
    }

    case "order.cancelled": {
      const orderNumber = payload.orderNumber ?? "نامشخص";
      const prev = payload.previousStatus ? orderStatusFa(payload.previousStatus) : null;
      const total = money(payload.finalPrice ?? 0, payload.currency ?? "IRT");
      const sourceMap = {
        customer: "توسط مشتری",
        admin: "توسط ادمین",
        payment_failed: "عدم موفقیت پرداخت درگاه",
      };
      const reasonText = sourceMap[payload.source] ?? "سیستم";
      return {
        text:
          `❌ لغو سفارش\n` +
          `شماره سفارش: ${orderNumber}\n` +
          (prev ? `تغییر وضعیت: ${prev} ← لغوشده\n` : "وضعیت: لغوشده\n") +
          `منشأ لغو: ${reasonText}\n` +
          `مبلغ سفارش: ${total}\n` +
          `زمان: ${formatDateTimeFa(payload.occurredAt ?? event.createdAt)}`,
        inlineKeyboard: [
          [{ text: "🧾 مشاهده جزئیات سفارش", callback_data: `ord:d:${orderNumber}:0:1:all:all` }],
        ],
      };
    }

    case "order.refunded": {
      const orderNumber = payload.orderNumber ?? "نامشخص";
      const refunded = money(payload.refundedAmount ?? 0, payload.currency ?? "IRT");
      return {
        text:
          `↩️ بازپرداخت به کیف‌پول مشتری\n` +
          `شماره سفارش: ${orderNumber}\n` +
          `مبلغ عودت‌یافته: ${refunded}\n` +
          `زمان: ${formatDateTimeFa(payload.occurredAt ?? event.createdAt)}`,
        inlineKeyboard: [
          [{ text: "🧾 مشاهده جزئیات سفارش", callback_data: `ord:d:${orderNumber}:0:1:all:all` }],
        ],
      };
    }

    case "order.status_changed": {
      const orderNumber = payload.orderNumber ?? "نامشخص";
      const prev = orderStatusFa(payload.previousStatus);
      const next = orderStatusFa(payload.status);
      const total = money(payload.finalPrice ?? 0, payload.currency ?? "IRT");
      return {
        text:
          `🚚 تغییر وضعیت سفارش\n` +
          `شماره سفارش: ${orderNumber}\n` +
          `وضعیت: ${prev} ← ${next}\n` +
          `مبلغ سفارش: ${total}\n` +
          `زمان: ${formatDateTimeFa(payload.occurredAt ?? event.createdAt)}`,
        inlineKeyboard: [
          [{ text: "🧾 مشاهده جزئیات سفارش", callback_data: `ord:d:${orderNumber}:0:1:all:all` }],
        ],
      };
    }

    case "inventory.out_of_stock":
    case "inventory.low_stock": {
      const isOut = type === "inventory.out_of_stock";
      const icon = isOut ? "🔴 ناموجودشدن کالا" : "🟡 هشدار کم‌موجودی کالا";
      const variantLine = payload.variant ? `واریانت: ${payload.variant}\n` : "";
      const skuLine = payload.sku ? `SKU: ${payload.sku}\n` : "";
      const syncText = payload.syncedAt ? formatDateTimeFa(payload.syncedAt) : "ثبت نشده";
      return {
        text:
          `${icon}\n` +
          `محصول: ${payload.productName ?? "نامشخص"}\n` +
          variantLine +
          skuLine +
          `موجودی فعلی: ${formatNumberFa(payload.currentStock ?? 0)} عدد (قبلی: ${formatNumberFa(payload.previousStock ?? 0)})\n` +
          `آستانهٔ هشدار: ${formatNumberFa(payload.threshold ?? 3)} عدد\n` +
          `آخرین همگام‌سازی: ${syncText}`,
        inlineKeyboard: [
          [{ text: "📦 مشاهده وضعیت موجودی", callback_data: "inv:sum" }],
        ],
      };
    }

    case "sync.failed": {
      return {
        text:
          `🚨 خطا در همگام‌سازی موجودی راهکاران\n` +
          `علت: ${payload.errorSummary ?? "خطای ارتباط با راهکاران"}\n` +
          `به‌روزرسانی‌شده قبل از توقف: ${formatNumberFa(payload.updatedBeforeFailure ?? 0)}\n` +
          `زمان وقوع: ${formatDateTimeFa(payload.occurredAt ?? event.createdAt)}`,
        inlineKeyboard: [[{ text: "🔔 بررسی سلامت سیستم", callback_data: "alt:sum" }]],
      };
    }

    case "sync.recovered": {
      return {
        text:
          `✅ بازیابی همگام‌سازی راهکاران\n` +
          `همگام‌سازی مجدداً با موفقیت انجام شد.\n` +
          `تطبیق‌یافته: ${formatNumberFa(payload.matched ?? 0)} | به‌روزشده: ${formatNumberFa(payload.updated ?? 0)}\n` +
          `زمان: ${formatDateTimeFa(payload.occurredAt ?? event.createdAt)}`,
        inlineKeyboard: [[{ text: "📦 خلاصه موجودی", callback_data: "inv:sum" }]],
      };
    }

    case "sync.stale": {
      return {
        text:
          `⏰ هشدار قدیمی‌شدن همگام‌سازی موجودی\n` +
          `بیش از ${formatNumberFa(payload.staleThresholdHours ?? 30)} ساعت از آخرین همگام‌سازی موفق راهکاران گذشته است.\n` +
          `آخرین زمان ثبت‌شده: ${payload.lastSyncedAt ? formatDateTimeFa(payload.lastSyncedAt) : "نامشخص"}`,
        inlineKeyboard: [[{ text: "🔔 وضعیت سرویس", callback_data: "alt:sum" }]],
      };
    }

    default:
      return {
        text: `🔔 رویداد سیستم (${type ?? "unknown"})\nزمان: ${formatDateTimeFa(event?.createdAt)}`,
        inlineKeyboard: [[{ text: "🏠 منوی اصلی", callback_data: "menu:home" }]],
      };
  }
}
