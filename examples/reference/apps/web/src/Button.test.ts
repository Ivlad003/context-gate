import { test, expect } from 'vitest'
import { Button } from './Button.tsx'

test('Button renders its children', () => {
  expect(Button({ children: 'Save' })).toBeTruthy()
})
