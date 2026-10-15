/// <reference types="vite/client" />

import type { PetApi } from '@shared/api'

declare global {
  interface Window {
    petAPI: PetApi
  }
}

export {}
