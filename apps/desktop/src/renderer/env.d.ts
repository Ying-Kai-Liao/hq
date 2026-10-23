/// <reference types="vite/client" />
import type { KithBridge } from '@shared/ipc'

declare global {
  interface Window {
    kith: KithBridge
  }
}

export {}
