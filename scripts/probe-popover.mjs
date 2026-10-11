import { chromium } from 'file:///C:/Users/77958/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// ① 审查台弹层外点关闭
await page.goto('http://127.0.0.1:5173/?view=decisions', { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.locator('.filters-popover summary').click();
await page.waitForTimeout(250);
const openBefore = await page.locator('.filters-popover[open]').count();
await page.locator('.page-header').click();
await page.waitForTimeout(250);
const openAfter = await page.locator('.filters-popover[open]').count();
console.log('筛选弹层 外点前 open:', openBefore, '→ 外点后 open:', openAfter, openBefore === 1 && openAfter === 0 ? '✓ 外点关闭生效' : '✗ 未关闭');
// ② more-menu 外点关闭
await page.goto('http://127.0.0.1:5173/?view=plans', { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.locator('.more-menu summary').first().click();
await page.waitForTimeout(250);
const menuBefore = await page.locator('.more-menu .menu-pop').count();
await page.locator('h1').first().click();
await page.waitForTimeout(250);
const menuAfter = await page.locator('.more-menu .menu-pop:visible').count();
console.log('更多菜单 外点前:', menuBefore, '→ 外点后可见:', menuAfter, menuBefore >= 1 && menuAfter === 0 ? '✓' : '（检查）');
// ③ connections 截图
await page.goto('http://127.0.0.1:5173/?view=connections', { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.screenshot({ path: 'data/connections-v2.png' });
await browser.close();
console.log('done');
