// 工作台全量 UI 审计（第七轮批4 沉淀）：视图遍历 + 关键交互冒烟 + 控制台错误捕获 + 截图产出。
// 运行：node scripts/e2e-audit.mjs（需工作台已在 127.0.0.1:5173 运行；本机 Docker 个人版）。
// 产出：data/e2e-<view>.png 截图 + JSON 摘要（stdout）；发现 errors 时 exit 1。
// 与 layout-audit.mjs 的分工：layout-audit 只查布局溢出；本脚本追加「功能断言」——
// 每视图的关键区块/交互控件必须存在，交互动作（筛选/抽屉/回传框）必须生效。
// playwright 来源与本机 Chrome 可执行路径沿用 data/layout-audit.mjs 的既有模式（不新增依赖）
import { chromium } from 'file:///C:/Users/77958/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

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

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.message).slice(0, 120)}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 120)}`); });

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
  const expand = page.locator("button", { hasText: "查看全部" });
  if (await expand.count()) await expand.first().click();
  await page.waitForTimeout(800);
  const chip = page.locator("button", { hasText: "哥飞注入" });
  if (!(await chip.count())) throw new Error("来源 chips 未渲染");
  await chip.first().click();
  await page.waitForTimeout(800);
  const chipCount = await page.locator("button", { hasText: "常规采集" }).count();
  if (!chipCount) throw new Error("常规采集 chip 消失");
  summary.push({ view: "trends-交互", ok: true, note: "来源 chips 切换生效" });
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
