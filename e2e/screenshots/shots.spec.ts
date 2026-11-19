import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { adminCookie, BASE, createRoom, enqueue, newUser, songId } from '../tests/helpers'

// Portfolio screenshots (docs/screenshots, 1280×800). Run against a server that
// serves the made-up library from make-demo-media.sh; see README "截圖".
const OUT = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url))
const ROOM = 'party'

test.use({ viewport: { width: 1280, height: 800 }, launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } })

const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}${name}.png` })

test('screenshots', async ({ browser, page }) => {
  test.setTimeout(180_000)
  const cookie = await adminCookie()
  await createRoom(cookie, ROOM)
  const singers = await Promise.all(['小明', 'Amy', '阿傑'].map((n) => newUser(ROOM, n)))
  const songs = ['夏夜的風', 'Neon Lights', '夜明けのメロディ', '慢慢走', 'Weekend Drive', '一起唱吧']
  for (const [i, s] of songs.entries()) await enqueue(ROOM, singers[i % 3], await songId(s))

  // 01: the TV, a few seconds into the first song.
  await page.goto(`/r/${ROOM}/player`)
  await expect.poll(() => page.evaluate(() => document.querySelector('video')?.currentTime ?? 0), { timeout: 20_000 }).toBeGreaterThan(4)
  await page.evaluate(() => document.querySelector('video')?.pause())
  await shot(page, '01-tv-player')

  // 02: three phones side by side: search, folders, the queue.
  const phone = await browser.newContext({ viewport: { width: 360, height: 720 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await phone.addInitScript(() => localStorage.setItem('zkaraver.nickname', '小美'))
  const pp = await phone.newPage()
  await pp.goto(`/r/${ROOM}`)
  await expect(pp.locator('.scroller li', { hasText: '星期五的晚上' })).toBeVisible()
  const shots = [await pp.screenshot()]
  await pp.locator('.sort-btn').click()
  await pp.locator('.panel .action', { hasText: '依資料夾瀏覽' }).click()
  await pp.locator('.artist-row', { hasText: '華語' }).click()
  await expect(pp.locator('.scroller li', { hasText: '夏夜的風' })).toBeVisible()
  shots.push(await pp.screenshot())
  await pp.locator('.tabs button', { hasText: '佇列' }).click()
  await pp.waitForTimeout(500)
  shots.push(await pp.screenshot())
  await page.setContent(`
    <style>
      body { margin: 0; height: 800px; display: flex; gap: 48px; justify-content: center; align-items: center;
             background: linear-gradient(135deg, #2b1055, #7597de); }
      img { width: 360px; height: 720px; border-radius: 28px; box-shadow: 0 0 0 8px #111, 0 20px 50px rgba(0,0,0,.45); }
    </style>
    ${shots.map((b) => `<img src="data:image/png;base64,${b.toString('base64')}">`).join('')}`)
  await shot(page, '02-phone-request')

  // 03: the admin page for the room.
  const admin = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const [name, value] = cookie.split('=')
  await admin.addCookies([{ name, value, url: BASE }])
  const ap = await admin.newPage()
  await ap.addInitScript((r) => localStorage.setItem('zkaraver.adminRoom', r), ROOM)
  await ap.goto('/admin')
  await expect(ap.locator('.admin-room .now-text')).toContainText('夏夜的風')
  await ap.waitForTimeout(1000)
  await shot(ap, '03-admin')
})
