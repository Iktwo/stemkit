import { defineConfig, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  // .env values (and shell overrides) bake into the main bundle at build time
  const env = loadEnv(mode ?? 'production', process.cwd(), '')
  return {
    main: {
      define: {
        __STEMKIT_GA_ID__: JSON.stringify(env.STEMKIT_GA_ID ?? ''),
        __STEMKIT_GA_SECRET__: JSON.stringify(env.STEMKIT_GA_SECRET ?? '')
      }
    },
    preload: {},
    renderer: {
      plugins: [react(), tailwindcss()]
    }
  }
})
