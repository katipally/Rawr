'use client'

import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { getQueryClient } from '~/lib/rpc.ts'

export const QueryProvider = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={getQueryClient()}>{children}</QueryClientProvider>
)
