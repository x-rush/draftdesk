// R10.37 组件级测试（第十轮审查盲区 1 的补课）：Review 审查台真实渲染 + 交互——
// ①同选题分组与适合平台徽章并集 ②状态卡组合过滤口径 ③组级拍板=平台并集（A-1 UI 半）
// ④键盘流 J/A（C⑤）。jsdom + createRoot + act，fetch 按 api() 的 /api/v1/<path> 形状 mock。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1037ui-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;

// ---- jsdom 环境（先于 react-dom 导入）----
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://127.0.0.1:5173/", pretendToBeVisual: true });
// 全量拷贝 jsdom 全局构造器（跳过 Node 已有键，如 navigator 只读 getter）——
// React/Radix 运行时会按需引用 HTMLFormElement/DocumentFragment/SVGElement 等
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try { (globalThis as any)[key] = (dom.window as any)[key]; } catch { /* 只读/不可配置键跳过 */ }
}
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).Element.prototype.scrollIntoView = () => {};
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { store } = await import("../core/store");
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Review } = await import("../components/Review");
const act = (React as any).act;

// ---- fetch mock：按 api() 的相对路径分发 ----
let outlineRows: any[] = [];
let clusterRows: any[] = [];
const posted: { path: string; body: any }[] = [];
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = String(input);
  const route = url.replace(/^\/api\/v1\//, "").split("?")[0];
  const method = init?.method || "GET";
  if (method !== "GET") posted.push({ path: route, body: JSON.parse(init.body) });
  const body: any = route === "decisions" ? { items: outlineRows }
    : route === "decisions/stats" ? {}
    : route === "clusters" ? { items: clusterRows }
    : route === "persona" ? null
    : route === "aiPolicy" ? { triage: "cheap", outline: "off", draft: "cheap", aiWriter: "external" }
    : route === "consumerMode" ? "external"
    : route.startsWith("outlines/") && route.endsWith("/platform-decision") ? { ok: true }
    : null;
  return new Response(JSON.stringify(body ?? {}), { status: 200, headers: { "content-type": "application/json" } });
};

const rootEl = document.getElementById("root")!;
const root = createRoot(rootEl);

function multiRow(): any {
  return {
    sourceType: "outline", id: "out-ui-1", kind: "长文", title: "多平台选题UI验证", clusterId: "clu-ui",
    decision: "pending", platform: "gzh", platforms: ["gzh", "xhs-note", "tiebuhao"], recommendation: "主投公众号",
    createdAt: new Date().toISOString(), summary: "要点",
  };
}

let mountKey = 0;
async function render(rows: any[]) {
  outlineRows = rows;
  // key 递增强制重挂载：同一 root 跨用例会复用组件实例，state（含默认档与已拉数据）不重置
  await act(async () => { root.render(React.createElement(Review, { key: ++mountKey })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}

after(async () => {
  await act(async () => root.unmount());
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("R10.37 UI①：多平台选题渲染——适合平台徽章=platforms 全集（3 枚），推荐建议在行内", async () => {
  await render([multiRow()]);
  const badges = Array.from(document.querySelectorAll('[aria-label="适合平台与按平台拍板"] button')).map((b) => (b.textContent || "").trim());
  assert.equal(badges.length, 3, "只渲染适合平台（gzh/xhs-note/tiebuhao），不再九平台全列");
  assert.ok(badges.some((t) => t.includes("公众号")) && badges.some((t) => t.includes("小红书笔记")) && badges.some((t) => t.includes("贴图号")));
  assert.ok((document.body.textContent || "").includes("推荐 · 主投公众号"), "推荐建议行渲染");
});

test("R10.37 UI②：状态卡组合过滤——「进行中」=drafting+published，「已否决·暂缓」=rejected+deferred", async () => {
  const now = new Date().toISOString();
  const mk = (id: string, decision: string) => ({ sourceType: "manual", id, kind: "manual", title: "行-" + id, decision, createdAt: now });
  await render([mk("dr", "drafting"), mk("pb", "published"), mk("rj", "rejected"), mk("df", "deferred")]);
  const card = (label: string) => Array.from(document.querySelectorAll(".stat-card.clickable")).find((c) => (c.textContent || "").includes(label)) as HTMLElement;
  const visibleTitles = () => Array.from(document.querySelectorAll(".decision-title")).map((t) => t.textContent);
  await act(async () => { card("进行中").click(); });
  assert.deepEqual(visibleTitles().sort(), ["行-dr", "行-pb"], "进行中卡过滤 drafting+published");
  await act(async () => { card("已否决·暂缓").click(); });
  assert.deepEqual(visibleTitles().sort(), ["行-df", "行-rj"], "已否决·暂缓卡过滤 rejected+deferred");  await act(async () => { card("已否决·暂缓").click(); }); // 再点回全部
  assert.equal(visibleTitles().length, 4, "再点回全部");
});

test("R10.37 UI③（A-1）：主行「通过」=按平台并集拍板——3 个适合平台各发一次 platform-decision（同一主行）", async () => {
  posted.length = 0;
  await render([multiRow()]);
  const approve = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "通过") as HTMLElement;
  assert.ok(approve, "找到主行通过按钮");
  await act(async () => { approve.click(); });
  const pd = posted.filter((p) => p.path === "outlines/out-ui-1/platform-decision");
  assert.equal(pd.length, 3, "对主行发 3 次平台拍板（并集，非仅主平台）");
  assert.deepEqual(pd.map((p) => p.body.platform).sort(), ["gzh", "tiebuhao", "xhs-note"]);
  assert.ok(pd.every((p) => p.body.decision === "approved"));
  assert.ok((document.body.textContent || "").includes("已按平台拍板 3 个平台"), "通知文案报并集数");
});

test("R10.37 UI④（C⑤）：键盘流——J 高亮首行、A 触发通过（并集拍板）", async () => {
  posted.length = 0;
  await render([multiRow(), { sourceType: "manual", id: "m2", kind: "manual", title: "另一行", decision: "pending", createdAt: new Date().toISOString() }]);
  const press = (key: string) => act(async () => {
    window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await press("j");
  const first = document.querySelector(".decision-row") as HTMLElement;
  assert.ok(first.style.outline.includes("var(--ink)"), "J 高亮第一行");
  await press("a");
  const pd = posted.filter((p) => p.path === "outlines/out-ui-1/platform-decision");
  assert.equal(pd.length, 3, "A=通过当前组（3 平台并集）");
});
