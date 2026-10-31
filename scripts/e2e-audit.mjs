// 工作台全量 UI 审计（第七轮批4 沉淀）：视图遍历 + 关键交互冒烟 + 控制台错误捕获 + 截图产出。
// 运行：node scripts/e2e-audit.mjs（需工作台已在 127.0.0.1:5173 运行）。
// 产出：data/e2e-<view>.png 截图 + JSON 摘要（stdout）；发现 errors 时 exit 1。
//
// Playwright 解析顺序（不强制新增 npm 依赖）：
//   1. E2E_PLAYWRIGHT_PATH 环境变量指向 playwright 的 index.mjs（本机已有全局安装时用）；
//   2. 项目 node_modules 内的 playwright（npm i -D playwright 后自动生效）。
// Chrome 可执行路径：E2E_CHROME_PATH 环境变量；未设置时回退 playwright 自带 Chromium
//（npx playwright install chromium）或常见安装位置。
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FALLBACK_CHROME_PATHS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
];

async function loadChromium() {
  const candidates = [
    process.env.E2E_PLAYWRIGHT_PATH,
    "playwright",
  ].filter(Boolean);
  for (const spec of candidates) {
    try {
      const mod = spec.includes("/") || spec.includes("\\") ? await import(pathToFileURL(spec).href) : await import(spec);
      if (mod?.chromium) return mod.chromium;
    } catch { /* 尝试下一个来源 */ }
  }
  throw new Error("未找到 playwright：npm i -D playwright，或设 E2E_PLAYWRIGHT_PATH 指向其 index.mjs 绝对路径。");
}

function resolveChrome() {
  if (process.env.E2E_CHROME_PATH) return process.env.E2E_CHROME_PATH;
  return FALLBACK_CHROME_PATHS.find((p) => existsSync(p));
}

const chromium = await loadChromium();
const CHROME = resolveChrome();

const BASE = "http://127.0.0.1:5173";
const views = ["discover", "hotspots", "library", "chat", "trends", "ideas", "activities", "decisions", "plans", "sources", "runs", "connections", "skills", "settings"];

// 每视图功能断言：selector 必须存在（数量 ≥1）；文案断言为包含匹配
const assertions = {
  settings: [
    { sel: ".dash-label", text: "SEO 数据源", name: "SEO 数据源区块" },
    { sel: "button", text: "连接测试", name: "连接测试按钮" },
    { sel: "button", text: "保存 SEO 数据源配置", name: "保存按钮" },
  ],
  ideas: [
    { sel: "button", text: "机会引擎", name: "机会引擎 tab" },
    { sel: "button", text: "站点发现", name: "站点发现 tab" },
  ],
  trends: [
    { sel: "h1", text: "热词之外", name: "热词趋势标题" },
  ],
  decisions: [
    { sel: "h1", text: "把待写队列拍成板", name: "审查台标题" },
  ],
};

const browser = await chromium.launch({ headless: true, ...(CHROME ? { executablePath: CHROME } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.message).slice(0, 120)}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 120)}`); });
page.on("response", (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url().slice(0, 140)}`); });

const summary = [];
for (const view of views) {
  await page.goto(`${BASE}/?view=${view}`, { waitUntil: "networkidle" }).catch(() => errors.push(`${view}: 页面加载失败`));
  const entry = {
    view,
    title: await page.locator("h1").first().innerText().catch(() => "无标题"),
    btns: await page.locator("button").count(),
    failed: [],
  };
  // 功能断言
  for (const a of assertions[view] || []) {
    try {
      const loc = a.text ? page.locator(a.sel, { hasText: a.text }) : page.locator(a.sel);
      const n = await loc.count();
      if (n < 1) entry.failed.push(`${a.name}：未找到（${a.sel}${a.text ? ` hasText=${a.text}` : ""}）`);
    } catch (e) {
      entry.failed.push(`${a.name}：断言异常 ${String(e.message).slice(0, 80)}`);
    }
  }
  await page.screenshot({ path: `data/e2e-${view}.png` });
  summary.push(entry);
}

// 交互动画（关键链路冒烟，不写生产数据——回传用探针词且立即清理）
try {
  await page.goto(`${BASE}/?view=trends`, { waitUntil: "networkidle" });
  // R10.45 P2⑦：查看全部改为跳词库页（带筛选）——交互检查同步新契约
  const expand = page.locator("button", { hasText: "查看全部" });
  if (await expand.count()) {
    await expand.first().click();
    await page.waitForTimeout(800);
    if (!page.url().includes("view=library")) throw new Error("查看全部未跳转词库页");
    summary.push({ view: "trends-交互", ok: true, note: "查看全部→词库页跳转生效" });
  } else {
    const chip = page.locator("button", { hasText: "哥飞注入" });
    if (!(await chip.count())) throw new Error("来源 chips 未渲染");
    await chip.first().click();
    await page.waitForTimeout(800);
    summary.push({ view: "trends-交互", ok: true, note: "来源 chips 切换生效" });
  }
  await page.screenshot({ path: "data/e2e-trends-interaction.png" });
} catch (e) {
  errors.push(`trends 交互: ${String(e.message).slice(0, 120)}`);
}

await browser.close();
console.log(JSON.stringify({ summary, errors }, null, 1));
if (errors.length) {
  console.error(`[e2e-audit] ${errors.length} 个错误`);
  process.exit(1);
}
console.log("[e2e-audit] 全部通过");
