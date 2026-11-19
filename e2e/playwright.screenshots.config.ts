import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// npx playwright test -c playwright.screenshots.config.ts → docs/screenshots
export default defineConfig({ ...base, testDir: './screenshots', retries: 0 })
