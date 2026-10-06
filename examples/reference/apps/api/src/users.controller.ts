import { Controller, Get, Param, Query } from '@nestjs/common'
import { UsersService } from './users.service.ts'

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Query('cursor') cursor?: string) {
    return this.users.list({ cursor, take: 50 })
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.users.get(id)
  }
}
