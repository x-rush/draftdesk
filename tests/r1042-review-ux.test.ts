// R10.42 审查台 UX 重整验收（组件级，沿用 R10.37 jsdom 基建）：
// ①②nav 与快捷卡同一键空间——点卡 nav 亮、点 nav 卡亮、pending 有 nav 入口；
// ③组合卡数字=过滤后行数严格一致；④平台多选筛选可用且与状态正交。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1042-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://127.0.0.1:5173/", pretendToBeVisual: true });
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try { (globalThis as any)[key] = (dom.window as any)[key]; } catch { /* 只读键跳过 */ }
}
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).Element.prototype.scrollIntoView = () => {};
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { store } = await import("../core/store");
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { Review } = await import("../components/Review");
const act = (React as any).act;

let outlineRows: any[] = [];
const posted: { path: string; body: any }[] = [];
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = String(input);
  const route = url.replace(/^\/api\/v1\//, "").split("?")[0];
  const method = init?.method || "GET";
  if (method !== "GET") posted.push({ path: route, body: JSON.parse(init.body) });
  const body: any = route === "decisions" ? { items: outlineRows }
    : route === "decisions/stats" ? {}
    : route === "clusters" ? { items: [] }
    : route === "persona" ? null
    : route === "aiPolicy" ? { triage: "cheap", outline: "off", draft: "cheap", aiWriter: "external" }
    : route === "consumerMode" ? "external"
    : null;
  return new Response(JSON.stringify(body ?? {}), { status: 200, headers: { "content-type": "application/json" } });
};

const rootEl = document.getElementById("root")!;
const root = createRoot(rootEl);
let mountKey = 0;
async function render(rows: any[]) {
  outlineRows = rows;
  await act(async () => { root.render(React.createElement(Review, { key: ++mountKey })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}
const rowsOf = () => Array.from(document.querySelectorAll(".decision-title")).map((t) => t.textContent?.trim()).sort();
const card = (label: string) => Array.from(document.querySelectorAll(".stat-card.clickable")).find((c) => (c.textContent || "").includes(label)) as HTMLElement;
const navBtn = (label: string) => Array.from(document.querySelectorAll('nav[aria-label="决策状态筛选"] button')).find((b) => (b.textContent || "").includes(label)) as HTMLElement;

function mkRow(id: string, decision: string, platforms: string[], platform = platforms[0]): any {
  return { sourceType: "outline", id, kind: "长文", title: "行-" + id, clusterId: "clu-" + id, decision, platform, platforms, createdAt: new Date().toISOString() };
}

after(async () => {
  await act(async () => root.unmount());
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("R10.42 ①②：nav 与卡同键空间——点卡 nav 亮、点 nav 卡亮、pending 有 nav 入口", async () => {
  await render([
    mkRow("a", "pending", ["gzh"]),
    mkRow("b", "drafting", ["gzh"]), mkRow("c", "published", ["xhs-note"]),
    mkRow("d", "rejected", ["threads"]), mkRow("e", "deferred", ["tiebuhao"]),
  ]);
  const navLabels = Array.from(document.querySelectorAll('nav[aria-label="决策状态筛选"] button')).map((b) => (b.textContent || "").trim());
  assert.equal(navLabels.length, 5, "五键：全部+四组合键");
  assert.ok(navLabels.some((t) => t.startsWith("待决策")), "pending 有 nav 入口（旧 nav 排除 pending 已修）");
  // 点卡 → nav 同亮
  await act(async () => { card("进行中").click(); });
  assert.ok((navBtn("进行中") as HTMLElement).className.includes("active"), "点卡后 nav 同亮");
  assert.deepEqual(rowsOf().sort(), ["行-b", "行-c"], "进行中=drafting+published 组合过滤");
  // 点 nav → 卡同亮
  await act(async () => { navBtn("已否决·暂缓").click(); });
  assert.ok((card("已否决·暂缓") as HTMLElement).className.includes("active"), "点 nav 后卡同亮");
  assert.deepEqual(rowsOf().sort(), ["行-d", "行-e"], "已否决·暂缓=rejected+deferred");
});

test("R10.42 ③：组合卡数字与过滤后行数严格一致", async () => {
  await render([
    mkRow("r1", "rejected", ["gzh"]), mkRow("r2", "rejected", ["xhs-note"]), mkRow("r3", "deferred", ["gzh"]),
    mkRow("r4", "pending", ["gzh"]),
  ]);
  await act(async () => { navBtn("已否决·暂缓").click(); });
  const closedCard = card("已否决·暂缓");
  const count = Number((closedCard.querySelector("strong") as HTMLElement).textContent);
  assert.equal(count, rowsOf().length, "卡数字=列表行数");
  assert.equal(count, 3, "rejected 2 + deferred 1");
});

test("R10.42 ④：平台多选筛选可用，且与状态筛选正交叠加", async () => {
  await render([
    mkRow("x1", "pending", ["gzh", "xhs-note"]),
    mkRow("x2", "pending", ["threads"]),
    mkRow("x3", "approved", ["xhs-note", "tiebuhao"]),
    mkRow("x4", "pending", ["gzh"]),
  ]);
  // 初始档=pending（Review 默认），先回「全部」再验平台筛选
  await act(async () => { navBtn("全部").click(); });
  // 勾选 小红书笔记 → platforms 含 xhs-note 的行（x1/x3）
  const xhs = Array.from(document.querySelectorAll('[aria-label="平台多选筛选"] button')).find((b) => (b.textContent || "").includes("小红书笔记")) as HTMLElement;
  await act(async () => { xhs.click(); });
  assert.deepEqual(rowsOf().sort(), ["行-x1", "行-x3"], "平台筛选生效");
  // 正交叠加：再切状态「待决策」→ x1（x3 approved 被状态滤掉）
  await act(async () => { card("待决策").click(); });
  assert.deepEqual(rowsOf(), ["行-x1"], "平台×状态正交");
  // 状态切回全部 + 平台多选第二个（gzh）→ 累积集 {xhs-note,gzh} 的并集 x1/x3/x4
  await act(async () => { navBtn("全部").click(); });
  const gzh = Array.from(document.querySelectorAll('[aria-label="平台多选筛选"] button')).find((b) => (b.textContent || "").includes("公众号")) as HTMLElement;
  await act(async () => { gzh.click(); });
  assert.deepEqual(rowsOf().sort(), ["行-x1", "行-x3", "行-x4"], "平台多选=累积并集语义");
  // 清除
  const clear = Array.from(document.querySelectorAll('[aria-label="平台多选筛选"] button')).find((b) => (b.textContent || "").includes("清除")) as HTMLElement;
  await act(async () => { clear.click(); });
  assert.equal(rowsOf().length, 4, "清除恢复全部");
});

test("R10.42 ⑤：徽章引导常显（适合 · 点徽章单拍）", async () => {
  await render([mkRow("y1", "pending", ["gzh", "xhs-note"])]);
  const label = Array.from(document.querySelectorAll('[aria-label="适合平台与按平台拍板"] span')).map((s) => s.textContent || "").join("");
  assert.ok(label.includes("点徽章单拍"), "常显引导在徽章行");
});
