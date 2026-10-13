import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { simpleProfit } from '@fr/core';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Auth, AuthContext, RequirePermissions } from '../auth/decorators';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { CalculateInput, ExpenseInput, FeeRuleInput, FxRateInput, ReversePriceInput, SimpleProfitInput, zMarketplace } from './finance.schemas';
import { ProfitService } from './profit.service';

@ApiTags('Profit & finance')
@Controller()
export class FinanceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profit: ProfitService,
    private readonly audit: AuditService,
  ) {}

  // ── Exchange rates ──
  @Get('fx-rates')
  @RequirePermissions('finance.read')
  rates() {
    return this.prisma.currencyRate.findMany({ orderBy: { asOf: 'desc' }, take: 500 });
  }

  @Post('fx-rates')
  @RequirePermissions('fx.write')
  @ApiZodBody(FxRateInput)
  async addRate(@Body(new ZodPipe(FxRateInput)) body: z.infer<typeof FxRateInput>, @Auth() auth: AuthContext) {
    const r = await this.prisma.currencyRate.create({ data: { ...body, createdById: auth.userId } });
    await this.audit.record(auth, { action: 'fx.add', entityType: 'currency_rate', entityId: r.id, after: r });
    return r;
  }

  // ── Fee rules ──
  @Get('fee-rules')
  @RequirePermissions('finance.read')
  feeRules(@Query('marketplace') marketplace?: string) {
    const mp = marketplace ? zMarketplace.parse(marketplace) : undefined;
    return this.prisma.feeRule.findMany({ where: { marketplace: mp }, orderBy: [{ marketplace: 'asc' }, { name: 'asc' }] });
  }

  @Post('fee-rules')
  @RequirePermissions('fees.write')
  @ApiZodBody(FeeRuleInput)
  async addFeeRule(@Body(new ZodPipe(FeeRuleInput)) body: z.infer<typeof FeeRuleInput>, @Auth() auth: AuthContext) {
    const r = await this.prisma.feeRule.create({ data: { ...body, tiers: body.tiers ?? Prisma.JsonNull } });
    await this.audit.record(auth, { action: 'fee_rule.create', entityType: 'fee_rule', entityId: r.id, after: r });
    return r;
  }

  @Patch('fee-rules/:id')
  @RequirePermissions('fees.write')
  async updateFeeRule(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(FeeRuleInput.partial())) body: Partial<z.infer<typeof FeeRuleInput>>, @Auth() auth: AuthContext) {
    const before = await this.prisma.feeRule.findUniqueOrThrow({ where: { id } });
    const r = await this.prisma.feeRule.update({ where: { id }, data: { ...body, tiers: body.tiers === undefined ? undefined : body.tiers ?? Prisma.JsonNull } });
    await this.audit.record(auth, { action: 'fee_rule.update', entityType: 'fee_rule', entityId: id, before, after: r });
    return r;
  }

  // ── Profit calculators ──
  @Post('profit/calculate')
  @HttpCode(200)
  @RequirePermissions('costs.read')
  @ApiZodBody(CalculateInput)
  calculate(@Body(new ZodPipe(CalculateInput)) body: z.infer<typeof CalculateInput>) {
    return this.profit.calculate(body);
  }

  @Post('profit/reverse-price')
  @HttpCode(200)
  @RequirePermissions('costs.read')
  @ApiZodBody(ReversePriceInput)
  reverse(@Body(new ZodPipe(ReversePriceInput)) body: z.infer<typeof ReversePriceInput>) {
    return this.profit.reversePrice(body);
  }

  @Post('profit/simple')
  @HttpCode(200)
  @ApiZodBody(SimpleProfitInput)
  simple(@Body(new ZodPipe(SimpleProfitInput)) body: z.infer<typeof SimpleProfitInput>) {
    return { ...simpleProfit(body), demonstration: true };
  }

  @Get('variants/:id/profit')
  @RequirePermissions('costs.read')
  variantProfit(@Param('id', ParseUUIDPipe) id: string) {
    return this.profit.variantProfitAcrossMarketplaces(id);
  }

  // ── Expenses ──
  @Get('expenses')
  @RequirePermissions('finance.read')
  expenses(@Query('from') from?: string, @Query('to') to?: string) {
    return this.prisma.expense.findMany({
      where: { date: { gte: from ? new Date(from) : undefined, lte: to ? new Date(to) : undefined } },
      orderBy: { date: 'desc' },
      take: 1000,
    });
  }

  @Post('expenses')
  @RequirePermissions('expenses.write')
  @ApiZodBody(ExpenseInput)
  async addExpense(@Body(new ZodPipe(ExpenseInput)) body: z.infer<typeof ExpenseInput>, @Auth() auth: AuthContext) {
    const e = await this.prisma.expense.create({ data: { ...body, createdById: auth.userId } });
    await this.audit.record(auth, { action: 'expense.create', entityType: 'expense', entityId: e.id, after: e });
    return e;
  }

  @Delete('expenses/:id')
  @RequirePermissions('expenses.write')
  async deleteExpense(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext) {
    const before = await this.prisma.expense.delete({ where: { id } });
    await this.audit.record(auth, { action: 'expense.delete', entityType: 'expense', entityId: id, before });
    return { ok: true };
  }
}
