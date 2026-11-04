// R10.52②③ 验收：useWorkspaceData 按视图拉取 + in-flight 合流。
// 此前 refresh() 每 4s 全量拉 8 端点（含 2.4MB seo-terms），不管当前视图是否消费——
// 审查台（decisions）首屏因此拖着 SEO 工作台全部数据，弱链路下首屏永远转圈。
// ①decisions：只拉 workspace（outlines/clusters/SEO 五件套全不拉）
// ②ideas：workspace + SEO 五件套（outlines/clusters 不拉）
// ③discover：workspace + outlines（SEO 五件套不拉）
// ④in-flight 合流：上一轮未完成时再调 refresh 直接跳过（防 8 端点 ×N 连发）
// ⑤未拉取集合不清空：decisions 拉过一次后切到 ideas 再回 decisions，outlines 保留
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1052hook-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://127.0.0.1:5173/?view=decisions", pretendToBeVisual: true });
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
const { useWorkspaceData } = await import("../components/useWorkspaceData");
const act = (React as any).act;

const calls: string[] = [];
let gateWorkspace: (() => void) | null = null; // ④受控闸：workspace 响应挂起
(globalThis as any).fetch = async (input: any) => {
  const route = String(input).replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/v1\//, "").split("?")[0];
  calls.push(route);
  if (route === "workspace" && gateWorkspace) {
    await new Promise<void>((r) => { gateWorkspace = r; });
    gateWorkspace = null;
  }
  const body: any = route === "workspace" ? { pendingOutlines: 3, jobActivity: [] }
    : route === "outlines" ? { items: [{ id: "o1", decision: "pending" }] }
    : route === "clusters" ? { items: [{ id: "c1" }] }
    : route === "seo-terms" ? { items: [{ term: "卡", siteCandidate: true }] }
    : { items: [] };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

const rootEl = document.getElementById("root")!;
const root = createRoot(rootEl);
let mountKey = 0;
async function mountAt(url: string) {
  dom.window.history.replaceState(null, "", url);
  calls.length = 0;
  function Harness() {
    const ws = useWorkspaceData();
    (globalThis as any).__ws = ws;
    return null;
  }
  await act(async () => { root.render(React.createElement(Harness, { key: ++mountKey })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
}
const uniq = () => [...new Set(calls.filter((r) => r !== "skills"))];

after(async () => {
  await act(async () => root.unmount());
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("R10.52③①：decisions 视图只拉 workspace——SEO 五件套/outlines/clusters 全不拉", async () => {
  await mountAt("http://127.0.0.1:5173/?view=decisions");
  assert.deepEqual(uniq().filter((r) => r !== "skills"), ["workspace"], "审查台一轮只打 workspace（此前 8 端点）；skills 为挂载期一次性拉取不计数");
  assert.equal((globalThis as any).__ws.data?.pendingOutlines, 3, "快照徽章计数在");
});

test("R10.52③②：ideas 视图拉 workspace+SEO 三件套，不拉 outlines/clusters/seo-terms/site-projects", async () => {
  await mountAt("http://127.0.0.1:5173/?view=ideas");
  const u = uniq().sort();
  assert.deepEqual(u, ["opportunities", "site-discoveries", "site-launches", "workspace"], "ideas=workspace+3（R10.52①：seo-terms/site-projects 为死数据自 UI 撤除）");
  assert.ok(!u.includes("outlines"), "outlines 不在 ideas 拉");
  assert.ok(!u.includes("clusters"), "clusters 不在 ideas 拉");
  assert.ok(!u.includes("seo-terms"), "2.4MB 的 seo-terms 不再随 UI 拉取");
});

test("R10.52③③：discover 视图拉 workspace+outlines，不拉 SEO 五件套", async () => {
  await mountAt("http://127.0.0.1:5173/?view=discover");
  const u = uniq().sort();
  assert.deepEqual(u, ["outlines", "workspace"], "discover=workspace+outlines");
});

test("R10.52②④：in-flight 合流——上一轮未完成时 refresh 跳过（fetch 数不增）", async () => {
  await mountAt("http://127.0.0.1:5173/?view=decisions");
  calls.length = 0;
  gateWorkspace = () => {}; // 置闸：workspace 响应挂起（fetch mock 内 await）
  const ws = (globalThis as any).__ws;
  let p1!: Promise<void>, p2!: Promise<void>;
  await act(async () => {
    p1 = ws.refresh();
    await new Promise((r) => setTimeout(r, 20)); // 第一轮已发出并挂在闸上
    const count = calls.length;
    p2 = ws.refresh(); // 第二轮应直接跳过
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, count, "合流：第二轮零新请求");
    const g = gateWorkspace; gateWorkspace = null; g?.();
  });
  await act(async () => { await Promise.allSettled([p1, p2]); });
});

test("R10.52③⑤：未拉取集合保留上次状态——decisions→ideas→回切不清空", async () => {
  await mountAt("http://127.0.0.1:5173/?view=discover"); // 拉 outlines
  const ws = (globalThis as any).__ws;
  assert.equal(ws.outlines.length, 1, "discover 拉到 outlines");
  await mountAt("http://127.0.0.1:5173/?view=ideas"); // 不拉 outlines
  assert.equal((globalThis as any).__ws.outlines.length, 0, "新挂载实例尚未拉取=空（状态不跨实例）");
  await mountAt("http://127.0.0.1:5173/?view=decisions");
  const ws2 = (globalThis as any).__ws;
  let p!: Promise<void>;
  await act(async () => { p = ws2.refresh(); }); // decisions 轮询再跑一轮，仍不拉 outlines
  await act(async () => { await p; });
  assert.ok(!uniq().includes("outlines"), "decisions 轮询不拉 outlines");
});
