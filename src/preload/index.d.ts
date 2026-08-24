import type { StemKitApi } from '../shared/types'

declare global {
  interface Window {
    stemkit: StemKitApi
  }
}

export {}
