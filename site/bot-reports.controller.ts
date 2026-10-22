import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { BotServiceKeyGuard } from './bot-service-key.guard';
import { BOT_REPORTS_READER, BotReportsReader, DateRange } from './bot-reports.contract';

function dateRange(from?: string, to?: string): DateRange {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !datePattern.test(from) || !datePattern.test(to) || from > to) {
    throw new BadRequestException('from and to must be valid YYYY-MM-DD dates, with from <= to.');
  }
  return { from, to, timezone: 'Asia/Tehran' };
}

@Controller('bot/v1')
@UseGuards(BotServiceKeyGuard)
export class BotReportsController {
  constructor(@Inject(BOT_REPORTS_READER) private readonly reports: BotReportsReader) {}

  @Get('reports/sales')
  sales(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.getSalesSummary(dateRange(from, to));
  }

  @Get('reports/customers')
  customers(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.getCustomerSummary(dateRange(from, to));
  }

  @Get('inventory/low-stock')
  lowStock(@Query('threshold') rawThreshold = '3') {
    const threshold = Number(rawThreshold);
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 10000) {
      throw new BadRequestException('threshold must be an integer between 0 and 10000.');
    }
    return this.reports.getLowStock({ threshold });
  }

  @Get('orders/:orderNumber')
  async order(@Param('orderNumber') orderNumber: string) {
    if (!/^[\p{L}\p{N}-]{2,64}$/u.test(orderNumber)) {
      throw new BadRequestException('Invalid order number.');
    }
    const order = await this.reports.getOrder(orderNumber);
    if (!order) return { orderNumber, notFound: true };
    return order;
  }
}
