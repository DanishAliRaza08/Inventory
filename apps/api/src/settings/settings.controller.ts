import { BadRequestException, Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, AuthContext, RequirePermissions } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { SETTINGS_SCHEMA, SettingKey, SettingsService } from './settings.service';

const Body_ = z.object({ value: z.unknown() });

@ApiTags('Settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  list() {
    return this.settings.all();
  }

  @Put(':key')
  @RequirePermissions('settings.manage')
  async set(@Param('key') key: string, @Body(new ZodPipe(Body_)) body: z.infer<typeof Body_>, @Auth() auth: AuthContext) {
    if (!(key in SETTINGS_SCHEMA)) throw new BadRequestException({ code: 'UNKNOWN_SETTING', message: `Unknown setting ${key}` });
    const parsed = SETTINGS_SCHEMA[key as SettingKey].safeParse(body.value);
    if (!parsed.success) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message });
    return this.settings.set(key as SettingKey, parsed.data, auth);
  }
}
