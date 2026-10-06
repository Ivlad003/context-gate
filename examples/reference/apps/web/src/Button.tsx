import type { ReactNode } from 'react'

export interface ButtonProps {
  children: ReactNode
  variant?: 'primary' | 'ghost'
  onClick?: () => void
}

export function Button({ children, variant = 'primary', onClick }: ButtonProps) {
  const cls = variant === 'primary' ? 'rounded bg-blue-600 px-4 py-2 text-white' : 'rounded px-4 py-2 text-blue-600'
  return (
    <div className={cls} onClick={onClick}>
      {children}
    </div>
  )
}
