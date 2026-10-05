/// <reference types="vite/client" />
import type { CodyncBridge } from '@shared/ipc'

declare global {
  interface Window {
    codync: CodyncBridge
  }
}

export {}
