import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, AuthContext, RequirePermissions } from '../auth/decorators';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationService, RULE_KINDS, RuleInput } from './automation.service';

@ApiTags('Automation')
@Controller('automation')
export class AutomationController {
  constructor(
    private readonly automation: AutomationService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('kinds')
  kinds() {
    return Object.entries(RULE_KINDS).map(([key, k]) => ({ key, label: k.label, actions: k.actions, defaults: k.conditions.parse({}) }));
  }

  @Get('rules')
  @RequirePermissions('automation.manage')
  rules() {
    return this.prisma.automationRule.findMany({ orderBy: { createdAt: 'asc' }, include: { runs: { orderBy: { startedAt: 'desc' }, take: 5 } } });
  }

  @Post('rules')
  @RequirePermissions('automation.manage')
  @ApiZodBody(RuleInput)
  create(@Body(new ZodPipe(RuleInput)) body: z.infer<typeof RuleInput>, @Auth() auth: AuthContext) {
    return this.automation.create(body, auth);
  }

  @Put('rules/:id')
  @RequirePermissions('automation.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RuleInput)) body: z.infer<typeof RuleInput>, @Auth() auth: AuthContext) {
    return this.automation.update(id, body, auth);
  }

  @Post('rules/:id/run')
  @HttpCode(200)
  @RequirePermissions('automation.manage')
  run(@Param('id', ParseUUIDPipe) id: string) {
    return this.automation.run(id, true);
  }
}
