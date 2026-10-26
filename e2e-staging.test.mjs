/**
 * آزمون End-to-End یکپارچه (Staging Verification Harness):
 *   - اجرای واقعی سرور HTTP بک‌اند NestJS (کامپایل‌شده در `back/dist`) روی پورت محلی
 *   - اجرای واقعی سرور شبیه‌ساز HTTP بله (`sendMessage`، `editMessageText`، آپلود فایل `sendDocument`)
 *   - اجرای واقعی `createBot` از `bot/bot.mjs` روی پروتکل واقعی HTTP + امضای HMAC
 *   - پوشش کامل معیارهای پذیرش ۱ تا ۹ با داده‌های مصنوعی بی‌نام (بدون دادهٔ واقعی مشتری)
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BUTTONS, createBot, dateInTehran, readConfig } from "./bot.mjs";

const requireFromBack = createRequire(
  fileURLToPath(new URL("../back/package.json", import.meta.url)),
);

requireFromBack("reflect-metadata");
const { ValidationPipe } = requireFromBack("@nestjs/common");
const { ConfigService } = requireFromBack("@nestjs/config");
const { Reflector } = requireFromBack("@nestjs/core");
const { Test } = requireFromBack("@nestjs/testing");
const { getRepositoryToken } = requireFromBack("@nestjs/typeorm");
const { DataSource } = requireFromBack("typeorm");

const { ResponseInterceptor } = requireFromBack(
  "./dist/src/common/interceptors/response.interceptor.js",
);
const { Variant } = requireFromBack("./dist/src/products/entities/variant.entity.js");
const { BotAccessService } = requireFromBack(
  "./dist/src/bot-reports/bot-access.service.js",
);
const { BOT_REPORTS_READER } = requireFromBack(
  "./dist/src/bot-reports/bot-reports.contract.js",
);
const { BotEventsService } = requireFromBack(
  "./dist/src/bot-reports/bot-events.service.js",
);
const { BotReportsController } = requireFromBack(
  "./dist/src/bot-reports/bot-reports.controller.js",
);
const { BotRoleGuard } = requireFromBack("./dist/src/bot-reports/bot-role.guard.js");
const { BotServiceKeyGuard } = requireFromBack(
  "./dist/src/bot-reports/bot-service-key.guard.js",
);
const { BotSettingsService } = requireFromBack(
  "./dist/src/bot-reports/bot-settings.service.js",
);
const { buildUtf8Csv } = requireFromBack("./dist/src/bot-reports/bot-csv.util.js");
const { BotInventoryAlertState } = requireFromBack(
  "./dist/src/bot-reports/entities/bot-inventory-alert-state.entity.js",
);
const { BotOperator } = requireFromBack(
  "./dist/src/bot-reports/entities/bot-operator.entity.js",
);
const { BotOutboxEvent, BotOutboxStatus } = requireFromBack(
  "./dist/src/bot-reports/entities/bot-outbox-event.entity.js",
);
const { BotSetting } = requireFromBack(
  "./dist/src/bot-reports/entities/bot-setting.entity.js",
);

function createStatefulMemoryRepo(seed = []) {
  const rows = [...seed];
  let seq = rows.length + 1;

  const matches = (row, where) => {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && "_type" in v) {
        if (v._type === "in") return v._value.includes(row[k]);
        if (v._type === "lessThan") return row[k] < v._value;
      }
      return row[k] === v;
    });
  };

  return {
    rows,
    create: (partial) => ({ ...partial }),
    save: async (entity) => {
      const now = new Date();
      if (!entity.id) {
        entity.id = seq++;
        entity.createdAt = entity.createdAt ?? now;
      }
      entity.updatedAt = now;
      const idx = rows.findIndex((r) => r.id === entity.id);
      if (idx >= 0) {
        rows[idx] = { ...rows[idx], ...entity };
        return rows[idx];
      }
      rows.push(entity);
      return entity;
    },
    findOne: async ({ where } = {}) => rows.find((r) => matches(r, where)) ?? null,
    find: async ({ where } = {}) => rows.filter((r) => matches(r, where)),
    count: async ({ where } = {}) => rows.filter((r) => matches(r, where)).length,
    createQueryBuilder: () => {
      let statusFilter = null;
      let maxAvailableAt = null;
      let checkLeasedExpiredNow = null;
      let takeLimit = 50;
      let skipOffset = 0;

      const filterRows = () =>
        rows.filter((r) => {
          if (statusFilter !== null && r.status !== statusFilter) return false;
          if (checkLeasedExpiredNow !== null) {
            return (
              r.leasedUntil != null &&
              new Date(r.leasedUntil) <= checkLeasedExpiredNow
            );
          }
          if (maxAvailableAt !== null && new Date(r.availableAt) > maxAvailableAt) {
            return false;
          }
          return true;
        });

      return {
        select: () => ({
          getRawOne: async () => ({ lastSyncedAt: "2026-10-26T07:30:00.000Z" }),
        }),
        where(expr, params) {
          if (params?.status) statusFilter = params.status;
          if (params?.leased) statusFilter = params.leased;
          return this;
        },
        andWhere(expr, params) {
          if (params?.status) statusFilter = params.status;
          if (String(expr).includes("leasedUntil") && params?.now) {
            checkLeasedExpiredNow = params.now;
          } else if (params?.now) {
            maxAvailableAt = params.now;
          }
          return this;
        },
        orderBy() {
          return this;
        },
        addOrderBy() {
          return this;
        },
        skip(n) {
          skipOffset = n;
          return this;
        },
        take(n) {
          takeLimit = n;
          return this;
        },
        getCount: async () => filterRows().length,
        getMany: async () => filterRows().slice(skipOffset, skipOffset + takeLimit),
        getManyAndCount: async () => {
          const all = filterRows();
          return [all.slice(skipOffset, skipOffset + takeLimit), all.length];
        },
        update: () => {
          let patchObj = {};
          let whereParams = {};
          const builder = {
            set(patch) {
              patchObj = patch;
              return builder;
            },
            where(_expr, params = {}) {
              Object.assign(whereParams, params);
              return builder;
            },
            andWhere(_expr, params = {}) {
              Object.assign(whereParams, params);
              return builder;
            },
            execute: async () => {
              let affected = 0;
              for (const r of rows) {
                if (
                  whereParams.id !== undefined &&
                  r.id === whereParams.id &&
                  whereParams.pending !== undefined &&
                  r.status === whereParams.pending
                ) {
                  for (const [k, v] of Object.entries(patchObj)) {
                    if (k === "attempts" && typeof v === "function") {
                      r.attempts = (r.attempts || 0) + 1;
                    } else {
                      r[k] = v;
                    }
                  }
                  affected += 1;
                } else if (
                  whereParams.leasedStatus &&
                  r.status === whereParams.leasedStatus &&
                  whereParams.now &&
                  r.leasedUntil &&
                  new Date(r.leasedUntil) < whereParams.now
                ) {
                  r.status = BotOutboxStatus.PENDING;
                  r.leaseOwner = null;
                  r.leaseToken = null;
                  r.leasedUntil = null;
                  affected += 1;
                }
              }
              return { affected };
            },
          };
          return builder;
        },
      };
    },
  };
}

async function startSimulatedBaleServer(state) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBuffer = Buffer.concat(chunks);
    const method = req.url.split("/").pop();

    if (method === "sendDocument") {
      const rawText = rawBuffer.toString("utf8");
      const filenameMatch = rawText.match(/filename="([^"]+)"/);
      state.documents.push({
        filename: filenameMatch?.[1] ?? "unknown.csv",
        rawMultipart: rawText,
        byteLength: rawBuffer.byteLength,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: ++state.msgSeq } }));
      return;
    }

    const body = rawBuffer.length > 0 ? JSON.parse(rawBuffer.toString("utf8")) : {};
    state.calls.push({ method, body });

    if (
      method === "sendMessage" &&
      state.failNextForRecipient &&
      String(body.chat_id) === String(state.failNextForRecipient)
    ) {
      state.failNextForRecipient = null;
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, description: "Simulated transient Bale 502" }));
      return;
    }

    const result = method === "getUpdates" ? [] : { message_id: ++state.msgSeq };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
  };
}

test("آزمون جامع سرتاسری (Live NestJS HTTP + Bale HTTP + Bot Worker) برای معیارهای پذیرش ۱ تا ۹", async () => {
  const today = dateInTehran();
  const serviceToken = "staging-service-secret-9876543210abcdef";

  // فیکسچر مصنوعی بی‌نام سفارش‌ها و واریانت‌ها
  const syntheticOrders = Array.from({ length: 14 }, (_, idx) => {
    const num = idx + 1;
    return {
      id: num,
      orderNumber: `ORD-STG-${String(num).padStart(4, "0")}`,
      status: num === 1 ? "pending" : num === 2 ? "cancelled" : num <= 10 ? "paid" : "shipped",
      finalPrice: 1_500_000 + num * 50_000,
      itemsSubtotal: 1_500_000 + num * 50_000,
      discount: 50_000,
      shippingCost: 50_000,
      shippingMethod: "post",
      refundedAmount: num === 2 ? 1_550_000 : 0,
      currency: "IRT",
      itemsCount: 2,
      createdAt: `${today}T08:${String(10 + idx).padStart(2, "0")}:00.000Z`,
      updatedAt: `${today}T09:${String(10 + idx).padStart(2, "0")}:00.000Z`,
      items: [
        {
          productName: `کیف چرم مصنوعی مدل ${num}`,
          variant: "مشکی / متوسط",
          sku: `STG-SKU-${num}`,
          quantity: 1,
          unitPrice: 1_500_000 + num * 50_000,
          lineTotal: 1_500_000 + num * 50_000,
        },
      ],
    };
  });

  const syntheticVariants = [
    { productName: "کیف دوشی کلاسیک", variant: "مشکی / بزرگ", sku: "ZP-OUT-1", stock: 0 },
    { productName: "کیف دوشی کلاسیک", variant: "قهوه‌ای / متوسط", sku: "ZP-LOW-1", stock: 2 },
    { productName: "کفش رسمی مردانه", variant: "عسلی / ۴۲", sku: "ZP-IN-1", stock: 12 },
  ];

  const operatorRepo = createStatefulMemoryRepo([
    {
      id: 1,
      baleUserId: "111",
      role: "owner",
      isActive: true,
      receiveOrderAlerts: true,
      receiveInventoryAlerts: true,
      receiveHealthAlerts: true,
    },
    {
      id: 2,
      baleUserId: "333",
      role: "admin",
      isActive: true,
      receiveOrderAlerts: true,
      receiveInventoryAlerts: true,
      receiveHealthAlerts: true,
    },
  ]);
  const settingRepo = createStatefulMemoryRepo();
  const outboxRepo = createStatefulMemoryRepo();
  const alertStateRepo = createStatefulMemoryRepo();
  const variantEntityRepo = createStatefulMemoryRepo();

  let settingsServiceRef = null;

  const syntheticReader = {
    getOrdersTodaySummary: async (date) => ({
      date,
      timezone: "Asia/Tehran",
      totalOrders: syntheticOrders.length,
      categories: {
        pending: 1,
        paid: 8,
        shipped: 4,
        delivered: 0,
        cancelled: 1,
        refundedOrCancelledAfterPayment: 1,
      },
    }),
    listOrders: async ({ page = 1, limit = 10, status }) => {
      const filtered = status
        ? syntheticOrders.filter((o) => o.status === status)
        : syntheticOrders;
      const ordered = [...filtered].reverse();
      const slice = ordered.slice((page - 1) * limit, page * limit);
      return {
        items: slice,
        pagination: {
          page,
          limit,
          total: ordered.length,
          totalPages: Math.ceil(ordered.length / limit),
        },
        timezone: "Asia/Tehran",
      };
    },
    getOrderDetail: async (orderNumber, { canViewCustomer, includeCustomer }) => {
      const found = syntheticOrders.find((o) => o.orderNumber === orderNumber);
      if (!found) return null;
      return {
        ...found,
        total: found.finalPrice,
        canViewCustomer,
        customerAccessDenied: !canViewCustomer,
        ...(canViewCustomer
          ? {
              customerSummary: {
                fullName: "مشتری آزمایشی فیکسچر",
                province: "تهران",
                city: "تهران",
              },
            }
          : {}),
        ...(canViewCustomer && includeCustomer
          ? {
              customer: {
                fullName: "مشتری آزمایشی فیکسچر",
                phone: "09990000000",
                province: "تهران",
                city: "تهران",
                address: "نشانی تستی بدون داده واقعی",
                postalCode: "1000000000",
              },
            }
          : {}),
      };
    },
    getSalesSummary: async ({ from, to }) => ({
      from,
      to,
      timezone: "Asia/Tehran",
      generatedAt: new Date().toISOString(),
      totalOrders: 14,
      paidOrders: 12,
      pendingOrders: 1,
      cancelledOrders: 1,
      refundedOrders: 1,
      grossSales: 22_000_000,
      discounts: 700_000,
      refunds: 1_550_000,
      netSales: 19_750_000,
      shippingTotal: 600_000,
      finalPaidTotal: 20_350_000,
      averageOrderValue: 1_645_833,
      currency: "IRT",
      dailyBreakdown: [{ date: today, paidOrders: 12, netSales: 19_750_000 }],
    }),
    exportSalesCsv: async ({ from, to }) => ({
      filename: `zoppini-sales-${from}-${to}.csv`,
      totalRecords: syntheticOrders.length,
      generatedAt: new Date().toISOString(),
      csvContent: buildUtf8Csv({
        metadataCells: [`نام فایل: zoppini-sales-${from}-${to}.csv`, `تعداد رکوردها: ${syntheticOrders.length}`],
        headers: ["شماره سفارش", "وضعیت", "مبلغ نهایی (تومان)"],
        rows: syntheticOrders.map((o) => [o.orderNumber, o.status, o.finalPrice]),
      }),
    }),
    getCustomerSummary: async ({ from, to }) => ({
      from,
      to,
      timezone: "Asia/Tehran",
      generatedAt: new Date().toISOString(),
      newCustomers: 5,
      repeatCustomers: 3,
      activeBuyers: 8,
      firstTimeBuyers: 5,
    }),
    getInventorySummary: async () => {
      const dto = await settingsServiceRef.getSettingsDto();
      const sync = await settingsServiceRef.getSyncHealthDto();
      const thr = dto.lowStockThreshold;
      return {
        unit: "variant",
        canonicalStockField: "variant.stock",
        threshold: thr,
        totalProducts: 2,
        totalVariants: syntheticVariants.length,
        outOfStockVariants: syntheticVariants.filter((v) => v.stock === 0).length,
        lowStockVariants: syntheticVariants.filter((v) => v.stock > 0 && v.stock <= thr).length,
        inStockVariants: syntheticVariants.filter((v) => v.stock > thr).length,
        sync,
      };
    },
    listInventory: async ({ category = "low", query, page = 1, limit = 15 }) => {
      const dto = await settingsServiceRef.getSettingsDto();
      const sync = await settingsServiceRef.getSyncHealthDto();
      const thr = dto.lowStockThreshold;
      const filtered = syntheticVariants.filter((v) => {
        if (category === "out" && v.stock !== 0) return false;
        if (category === "low" && !(v.stock > 0 && v.stock <= thr)) return false;
        if (category === "in" && !(v.stock > thr)) return false;
        if (query && !`${v.productName} ${v.sku}`.includes(query)) return false;
        return true;
      });
      return {
        unit: "variant",
        threshold: thr,
        items: filtered.slice((page - 1) * limit, page * limit),
        pagination: { page, limit, total: filtered.length, totalPages: Math.max(1, Math.ceil(filtered.length / limit)) },
        sync,
      };
    },
    exportInventoryCsv: async ({ category = "all" }) => {
      const rows =
        category === "out"
          ? syntheticVariants.filter((v) => v.stock === 0)
          : syntheticVariants;
      return {
        filename: `zoppini-inventory-${category}-${today}.csv`,
        totalRecords: rows.length,
        generatedAt: new Date().toISOString(),
        csvContent: buildUtf8Csv({
          metadataCells: [`نام فایل: zoppini-inventory-${category}-${today}.csv`, `تعداد رکوردها: ${rows.length}`],
          headers: ["نام محصول", "واریانت", "SKU", "موجودی"],
          rows: rows.map((v) => [v.productName, v.variant, v.sku, v.stock]),
        }),
      };
    },
    getLowStock: async (threshold) => ({
      threshold,
      items: syntheticVariants.filter((v) => v.stock <= threshold),
      sync: await settingsServiceRef.getSyncHealthDto(),
    }),
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [BotReportsController],
    providers: [
      BotServiceKeyGuard,
      BotRoleGuard,
      BotAccessService,
      BotSettingsService,
      BotEventsService,
      { provide: BOT_REPORTS_READER, useValue: syntheticReader },
      { provide: getRepositoryToken(BotOperator), useValue: operatorRepo },
      { provide: getRepositoryToken(BotSetting), useValue: settingRepo },
      { provide: getRepositoryToken(BotOutboxEvent), useValue: outboxRepo },
      { provide: getRepositoryToken(BotInventoryAlertState), useValue: alertStateRepo },
      { provide: getRepositoryToken(Variant), useValue: variantEntityRepo },
      { provide: DataSource, useValue: { query: async () => [{ ok: 1 }] } },
      {
        provide: ConfigService,
        useValue: {
          get: (key) => {
            if (key === "ZOPPINI_BOT_SERVICE_TOKEN") return serviceToken;
            if (key === "ZOPPINI_BOT_OWNER_BALE_IDS") return "111";
            return "";
          },
        },
      },
    ],
  }).compile();

  settingsServiceRef = moduleRef.get(BotSettingsService);
  const eventsService = moduleRef.get(BotEventsService);

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api");
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
  await app.listen(0, "127.0.0.1");

  const nestAddr = app.getHttpServer().address();
  const siteApiBase = `http://127.0.0.1:${nestAddr.port}/api/bot/v1`;

  const baleState = {
    msgSeq: 100,
    calls: [],
    documents: [],
    failNextForRecipient: null,
  };
  const baleServer = await startSimulatedBaleServer(baleState);

  const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

  const makeBotInstance = () =>
    createBot(
      readConfig({
        BALE_BOT_TOKEN: "e2e-bale-token",
        BALE_API_BASE_URL: baleServer.baseUrl,
        ZOPPINI_SITE_API_BASE_URL: siteApiBase,
        ZOPPINI_BOT_SERVICE_TOKEN: serviceToken,
        OWNER_BALE_IDS: "111",
        ALLOWED_BALE_IDS: "111",
      }),
      { logger: silentLogger },
    );

  let bot = makeBotInstance();

  try {
    // --- معیار ۶: امنیت چت خصوصی و رد کاربر غیرمجاز ---
    await bot.handleMessage({
      message_id: 1,
      from: { id: 999 },
      chat: { id: 999, type: "private" },
      text: BUTTONS.sales,
    });
    assert.match(baleState.calls.at(-1).body.text, /دسترسی این حساب هنوز برای ربات فعال نشده/);

    const countBeforeGroup = baleState.calls.length;
    await bot.handleMessage({
      message_id: 2,
      from: { id: 111 },
      chat: { id: -10077, type: "group" },
      text: BUTTONS.orders,
    });
    assert.equal(baleState.calls.length, countBeforeGroup, "پیام گروهی نباید هیچ پاسخی بگیرد");

    // --- معیار ۷: مدیریت نقش و ماندگاری تنظیمات بین ری‌استارت ربات ---
    // افزودن اپراتور orders-read-only با شناسه 222 و تغییر آستانه به 4 توسط مالک (111)
    await bot.handleCallbackQuery({
      id: "cb-op",
      from: { id: 111 },
      message: { message_id: 10, chat: { id: 111, type: "private" } },
      data: "set:opr:222:or",
    });
    await bot.handleMessage({
      message_id: 3,
      from: { id: 111 },
      chat: { id: 111, type: "private" },
      text: BUTTONS.settings,
    });
    await bot.handleCallbackQuery({
      id: "cb-thc",
      from: { id: 111 },
      message: { message_id: 11, chat: { id: 111, type: "private" } },
      data: "set:thc",
    });
    await bot.handleMessage({
      message_id: 4,
      from: { id: 111 },
      chat: { id: 111, type: "private" },
      text: "۴",
    });

    // شبیه‌سازی ری‌استارت کامل ربات با نمونهٔ جدید
    bot = makeBotInstance();
    await bot.handleMessage({
      message_id: 5,
      from: { id: 111 },
      chat: { id: 111, type: "private" },
      text: BUTTONS.settings,
    });
    assert.match(baleState.calls.at(-1).body.text, /آستانهٔ کم‌موجودی هر واریانت: ۴ عدد/);

    // --- معیار ۱: سفارش‌ها (خلاصه امروز + صفحه‌بندی ۱ و ۲ + جزئیات + محدودیت نقش) ---
    await bot.handleMessage({
      message_id: 6,
      from: { id: 111 },
      chat: { id: 111, type: "private" },
      text: BUTTONS.orders,
    });
    assert.match(baleState.calls.at(-1).body.text, /خلاصهٔ سفارش‌های امروز/);
    assert.match(baleState.calls.at(-1).body.text, /کل سفارش‌های ثبت‌شده امروز: ۱۴/);

    // صفحه ۱ آخرین سفارش‌ها (از جدیدترین: ORD-STG-0014) و صفحه ۲ (ORD-STG-0004)
    await bot.handleCallbackQuery({
      id: "cb-ord-p1",
      from: { id: 111 },
      message: { message_id: 20, chat: { id: 111, type: "private" } },
      data: "ord:l:1:all:all",
    });
    assert.match(baleState.calls.at(-1).body.text, /ORD-STG-0014/);

    await bot.handleCallbackQuery({
      id: "cb-ord-p2",
      from: { id: 111 },
      message: { message_id: 20, chat: { id: 111, type: "private" } },
      data: "ord:l:2:all:all",
    });
    assert.match(baleState.calls.at(-1).body.text, /ORD-STG-0004/);

    // مشاهده سفارش توسط نقش orders-read-only (کاربر 222) → بدون داده شخصی مشتری
    await bot.handleCallbackQuery({
      id: "cb-ro-detail",
      from: { id: 222 },
      message: { message_id: 21, chat: { id: 222, type: "private" } },
      data: "ord:d:ORD-STG-0010:0:1:all:all",
    });
    assert.match(
      baleState.calls.at(-1).body.text,
      /برای نمایش این اطلاعات دسترسی لازم را ندارید/,
    );
    assert.doesNotMatch(baleState.calls.at(-1).body.text, /09990000000/);

    // کاربر 222 به گزارش فروش دسترسی ندارد
    await bot.handleMessage({
      message_id: 7,
      from: { id: 222 },
      chat: { id: 222, type: "private" },
      text: BUTTONS.sales,
    });
    assert.match(baleState.calls.at(-1).body.text, /مجوز دسترسی|دسترسی لازم/);

    // --- معیار ۴: گزارش فروش چهار بازه و فایل CSV ---
    for (const rk of ["today", "yesterday", "7d", "month"]) {
      await bot.handleCallbackQuery({
        id: `cb-sal-${rk}`,
        from: { id: 111 },
        message: { message_id: 30, chat: { id: 111, type: "private" } },
        data: `sal:r:${rk}`,
      });
      assert.match(baleState.calls.at(-1).body.text, /تومان \(IRT\)/);
      assert.match(baleState.calls.at(-1).body.text, /۱۹٬۷۵۰٬۰۰۰ تومان/);
    }

    await bot.handleCallbackQuery({
      id: "cb-sal-csv",
      from: { id: 111 },
      message: { message_id: 30, chat: { id: 111, type: "private" } },
      data: `sal:csv:${today}:${today}`,
    });
    assert.equal(baleState.documents.length, 1);
    assert.match(baleState.documents[0].rawMultipart, /ORD-STG-0014/);

    // --- معیار ۳: موجودی کالا، جست‌وجوی SKU و فایل CSV ---
    await bot.handleMessage({
      message_id: 8,
      from: { id: 111 },
      chat: { id: 111, type: "private" },
      text: BUTTONS.stock,
    });
    assert.match(baleState.calls.at(-1).body.text, /ناموجود \(موجودی صفر\): ۱ واریانت/);
    assert.match(baleState.calls.at(-1).body.text, /کم‌موجود \(۱ تا ۴ عدد\): ۱ واریانت/);

    await bot.handleCallbackQuery({
      id: "cb-inv-search",
      from: { id: 111 },
      message: { message_id: 31, chat: { id: 111, type: "private" } },
      data: "inv:search",
    });
    await bot.handleMessage({
      message_id: 9,
      from: { id: 111 },
      chat: { id: 111, type: "private" },
      text: "ZP-LOW-1",
    });
    assert.match(baleState.calls.at(-1).body.text, /ZP-LOW-1/);

    await bot.handleCallbackQuery({
      id: "cb-inv-csv",
      from: { id: 111 },
      message: { message_id: 31, chat: { id: 111, type: "private" } },
      data: "inv:csv:out",
    });
    assert.equal(baleState.documents.length, 2);
    assert.match(baleState.documents[1].rawMultipart, /ZP-OUT-1/);

    // --- معیار ۲ و ۵: صف Outbox تراکنشی، Retry بدون تکرار، هشدار موجودی و سینک راهکاران ---
    const managerAdapter = {
      getRepository: (ent) => {
        if (ent === BotOutboxEvent) return outboxRepo;
        if (ent === BotInventoryAlertState) return alertStateRepo;
        return settingRepo;
      },
    };

    await eventsService.recordOrderPaidInTransaction(managerAdapter, {
      id: 777,
      orderNumber: "ORD-STG-PAID-777",
      status: "paid",
      finalPrice: 2_450_000,
      items: [{ quantity: 1 }],
      updatedAt: new Date(),
    });
    await eventsService.evaluateVariantStockTransitions([
      {
        variantId: 91,
        productTitle: "کیف دوشی کلاسیک",
        variantLabel: "قهوه‌ای / متوسط",
        sku: "ZP-LOW-1",
        oldStock: 10,
        newStock: 2,
      },
    ]);
    await eventsService.recordSyncFailed(new Error("Rahkaran SQL timeout"));

    // شبیه‌سازی خطای موقت بله برای ادمین 333 در دور اول، سپس تحویل موفق بدون تکرار برای 111
    baleState.failNextForRecipient = "333";
    await bot.pollOutboxOnce();

    // آزادسازی دستی زمان availableAt برای اجرای فوری دور دوم تست بدون انتظار ۱۵ ثانیه‌ای
    for (const row of outboxRepo.rows) {
      if (row.status === BotOutboxStatus.PENDING) {
        row.availableAt = new Date(Date.now() - 1000);
      }
    }
    await bot.pollOutboxOnce();

    const ownerPaidAlerts = baleState.calls.filter(
      (c) =>
        c.method === "sendMessage" &&
        String(c.body.chat_id) === "111" &&
        /ORD-STG-PAID-777/.test(c.body.text),
    );
    assert.equal(ownerPaidAlerts.length, 1, "مالک نباید اعلان تکراری دریافت کند");

    const ownerLowAlerts = baleState.calls.filter(
      (c) =>
        c.method === "sendMessage" &&
        String(c.body.chat_id) === "111" &&
        /هشدار کم‌موجودی کالا/.test(c.body.text) &&
        /ZP-LOW-1/.test(c.body.text),
    );
    assert.equal(ownerLowAlerts.length, 1);

    const ownerSyncAlerts = baleState.calls.filter(
      (c) =>
        c.method === "sendMessage" &&
        String(c.body.chat_id) === "111" &&
        /خطا در همگام‌سازی موجودی راهکاران/.test(c.body.text),
    );
    assert.equal(ownerSyncAlerts.length, 1);

    // --- معیار ۸: کارکرد تمام دکمه‌های اصلی بدون هیچ پیام «بعداً فعال می‌شود» ---
    await bot.handleMessage({
      message_id: 10,
      from: { id: 111 },
      chat: { id: 111, type: "private" },
      text: BUTTONS.customers,
    });
    await bot.handleMessage({
      message_id: 11,
      from: { id: 111 },
      chat: { id: 111, type: "private" },
      text: BUTTONS.alerts,
    });

    for (const call of baleState.calls) {
      if (typeof call.body?.text === "string") {
        assert.doesNotMatch(
          call.body.text,
          /بعداً فعال می‌شود/,
          "نباید هیچ پیام placeholder باقی مانده باشد",
        );
      }
    }
  } finally {
    await app.close();
    await new Promise((resolve) => baleServer.server.close(resolve));
  }
});
