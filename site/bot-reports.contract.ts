export const BOT_REPORTS_READER = Symbol('BOT_REPORTS_READER');

export type DateRange = {
  from: string;
  to: string;
  timezone: 'Asia/Tehran';
};

export interface BotReportsReader {
  getSalesSummary(range: DateRange): Promise<{
    from: string;
    to: string;
    timezone: 'Asia/Tehran';
    currency: 'IRR' | 'IRT';
    paidOrders: number;
    grossSales: number;
    refunds: number;
    netSales: number;
    averageOrderValue: number;
    generatedAt: string;
  }>;

  getLowStock(input: { threshold: number }): Promise<{
    threshold: number;
    inventorySyncedAt: string | null;
    items: Array<{
      productName: string;
      variant: string | null;
      sku: string | null;
      stock: number;
    }>;
  }>;

  getOrder(orderNumber: string): Promise<{
    orderNumber: string;
    status: string;
    createdAt: string;
    currency: 'IRR' | 'IRT';
    total: number;
    items: Array<{
      productName: string;
      variant: string | null;
      quantity: number;
      unitPrice: number;
    }>;
  } | null>;

  getCustomerSummary(range: DateRange): Promise<{
    newCustomers: number;
    repeatCustomers: number;
  }>;
}
