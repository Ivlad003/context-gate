import { test, expect } from 'vitest'
import { UsersService } from './users.service.ts'

test('UsersService is constructible', () => {
  expect(new UsersService()).toBeInstanceOf(UsersService)
})
