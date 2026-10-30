// 布局巡检（R10.37 C⑩ 入库，原为本机 data/ 遗留脚本）：
// 13 视图桌面 1440×900 + 移动 390×844 双端截图 + 移动端水平溢出检测 + 页面错误捕获。
// 运行：node scripts/layout-audit.mjs（需工作台已在 127.0.0.1:5173 运行）。
// 产出：data/layout-<view>.png / data/layout-mobile-<view>.png（data/ 已 gitignore）+ JSON 摘要（stdout）。
//
// Playwright 解析顺序与 e2e-audit.mjs 一致（不强制新增依赖）：
//   1. E2E_PLAYWRIGHT_PATH 指向 playwright index.mjs；2. 项目 node_modules 内 playwright。
import { pathToFileURL } from "node:url";

const FALLBACK_CHROME_PATHS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
];

async function loadChromium() {
  const candidates = [process.env.E2E_PLAYWRIGHT_PATH, "playwright"].filter(Boolean);
  for (const spec of candidates) {
    try {
      const mod = spec.includes("/") || spec.includes("\\") ? await import(pathToFileURL(spec).href) : await import(spec);
      if (mod?.chromium) return mod.chromium;
    } catch { /* 尝试下一个来源 */ }
  }
  throw new Error("找不到 playwright：设 E2E_PLAYWRIGHT_PATH 或 npm i -D playwright");
}

const VIEWS = ["discover", "hotspots", "library", "chat", "trends", "ideas", "activities", "decisions", "plans", "sources", "runs", "connections", "skills", "settings"];

const chromium = await loadChromium();
let executablePath = process.env.E2E_CHROME_PATH;
if (!executablePath) {
  const { existsSync } = await import("node:fs");
  executablePath = FALLBACK_CHROME_PATHS.find((p) => existsSync(p));
}
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const errors = [];
const summary = [];

const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
desktop.on("pageerror", (e) => errors.push(e.message));
for (const view of VIEWS) {
  await desktop.goto(`http://127.0.0.1:5173/?view=${view}`, { waitUntil: "networkidle" });
  await desktop.screenshot({ path: `data/layout-${view}.png` });
  summary.push({
    view,
    title: await desktop.locator("h1").first().innerText().catch(() => ""),
    navCount: await desktop.locator(".sidebar nav button").count(),
    mainScrollHeight: await desktop.locator("main").evaluate((e) => e.scrollHeight),
    viewportWidth: await desktop.evaluate(() => window.innerWidth),
    documentWidth: await desktop.evaluate(() => document.documentElement.scrollWidth),
  });
}

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
mobile.on("pageerror", (e) => errors.push(e.message));
for (const view of VIEWS) {
  await mobile.goto(`http://127.0.0.1:5173/?view=${view}`, { waitUntil: "networkidle" });
  await mobile.screenshot({ path: `data/layout-mobile-${view}.png` });
  const docW = await mobile.evaluate(() => document.documentElement.scrollWidth);
  if (docW > 391) errors.push(`mobile-${view} 水平溢出：scrollWidth=${docW} > 视口 390`);
  summary.push({ view: `mobile-${view}`, documentWidth: docW, viewportWidth: 390 });
}

console.log(JSON.stringify({ summary, errors }, null, 1));
await browser.close();
if (errors.length) process.exit(1);
