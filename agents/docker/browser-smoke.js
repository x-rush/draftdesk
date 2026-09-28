// 浏览器冒烟测试：容器里跑一次，确认 Chromium 能起、中文能渲染、能截图。
// 用法（在容器内）：
//   NODE_PATH=/usr/local/lib/node_modules node /opt/browser-smoke.js
const { chromium } = require('playwright');

(async () => {
  // Docker 里通常没有 user namespace，chromium 自带沙箱会起不来，故 --no-sandbox
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent('<h1>浏览器可用 · 中文渲染测试</h1>');
  const text = (await page.textContent('h1')).trim();
  await page.screenshot({ path: '/tmp/browser-smoke.png' });
  const version = await browser.version();
  await browser.close();
  console.log('OK |', version, '| 文本:', text, '| 截图: /tmp/browser-smoke.png');
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
