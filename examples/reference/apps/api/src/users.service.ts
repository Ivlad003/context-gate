import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

@Injectable()
export class UsersService {
  private readonly db = new PrismaClient()

  async list(o: { cursor?: string; take: number }) {
    const items = await this.db.user.findMany({ take: o.take, ...(o.cursor ? { skip: 1, cursor: { id: o.cursor } } : {}), orderBy: { id: 'asc' } })
    return { items, nextCursor: items.length === o.take ? items[items.length - 1]!.id : null }
  }

  async get(id: string) {
    const user = await this.db.user.findUnique({ where: { id } })
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: `User ${id} not found` })
    return user
  }
}
