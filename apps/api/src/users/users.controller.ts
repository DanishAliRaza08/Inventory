import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@fr/core';
import { z } from 'zod';
import { Auth, AuthContext, RequirePermissions } from '../auth/decorators';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { UsersService } from './users.service';

const CreateUser = z.object({ email: z.string().email(), name: z.string().min(1).max(120), password: z.string().max(200), roleKeys: z.array(z.string()).min(1) });
const UpdateUser = z.object({ name: z.string().min(1).max(120).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), roleKeys: z.array(z.string()).min(1).optional() });
const RoleBody = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()),
  requiresMfa: z.boolean().optional(),
});

@ApiTags('Users & permissions')
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  @RequirePermissions('users.manage')
  list() {
    return this.users.list();
  }

  @Post('users')
  @RequirePermissions('users.manage')
  @ApiZodBody(CreateUser)
  create(@Body(new ZodPipe(CreateUser)) body: z.infer<typeof CreateUser>, @Auth() auth: AuthContext) {
    return this.users.create(body, auth);
  }

  @Patch('users/:id')
  @RequirePermissions('users.manage')
  @ApiZodBody(UpdateUser)
  update(@Param('id') id: string, @Body(new ZodPipe(UpdateUser)) body: z.infer<typeof UpdateUser>, @Auth() auth: AuthContext) {
    return this.users.update(id, body, auth);
  }

  @Get('roles')
  @RequirePermissions('users.manage')
  roles() {
    return this.users.listRoles();
  }

  @Get('permissions')
  permissions() {
    return Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description }));
  }

  @Put('roles/:key')
  @RequirePermissions('users.manage')
  @ApiZodBody(RoleBody)
  upsertRole(@Param('key') key: string, @Body(new ZodPipe(RoleBody)) body: z.infer<typeof RoleBody>, @Auth() auth: AuthContext) {
    return this.users.upsertRole({ key, ...body }, auth);
  }
}
