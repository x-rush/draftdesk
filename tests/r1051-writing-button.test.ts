// R10.49 尾巴验收（老大 11-01 深夜实锤）：①approved 行「标记写作中」按钮——已通过切写作中
// 此前 UI 无入口（agent 口按设计无拍板权，拍板只能人做）；②drafting 行「翻回待定」闭环
// （工单描述写作中行已有翻回待定，实查 R10.43 起只挂 rejected/deferred——本次补齐闭环）；
// ③pending 行不出现该按钮。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1051-"));
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
const calls: { path: string; body: any }[] = [];
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = String(input);
  const route = url.replace(/^\/api\/v1\//, "").split("?")[0];
  const method = init?.method || "GET";
  if (method !== "GET") calls.push({ path: route, body: JSON.parse(init.body) });
  const body: any = route === "decisions" ? { items: outlineRows }
    : route === "decisions/stats" ? {}
    : route === "clusters" ? { items: [] }
    : route === "persona" ? null
    : route === "aiPolicy" ? { triage: "cheap", outline: "off", draft: "cheap", aiWriter: "external" }
    : route === "consumerMode" ? "external"
    : route.startsWith("outlines/") ? { ok: true }
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
function mkRow(id: string, decision: string): any {
  return { sourceType: "outline", id, kind: "长文", title: "行-" + id, clusterId: "clu-" + id, decision, platform: "gzh", platforms: ["gzh"], createdAt: new Date().toISOString() };
}
// 默认状态档是 pending——先点 nav「已通过/写作中」切档再找行内按钮
const clickNav = async (label: string) => {
  const nav = document.querySelector('nav[aria-label="决策状态筛选"]');
  const b = Array.from(nav!.querySelectorAll("button")).find((x) => (x.textContent || "").includes(label)) as HTMLElement;
  assert.ok(b, "nav 有「" + label + "」");
  await act(async () => { b.click(); });
};
const clickBtn = async (pred: (t: string) => boolean) => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => pred((x.textContent || "").trim())) as HTMLElement;
  assert.ok(b, "按钮存在");
  await act(async () => { b.click(); });
};
const decisionCalls = () => calls.filter((c) => c.path.endsWith("/decision"));

after(async () => {
  await act(async () => root.unmount());
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("R10.49 尾巴①：approved 行有「标记写作中」，点击走行级 decision→drafting", async () => {
  calls.length = 0;
  await render([mkRow("ap-1", "approved")]);
  await clickNav("已通过");
  const btn = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent || "").trim() === "标记写作中");
  assert.ok(btn, "approved 行有「标记写作中」按钮");
  await clickBtn((t) => t === "标记写作中");
  await new Promise((r) => setTimeout(r, 30));
  const c = decisionCalls()[0];
  assert.ok(c, "行级 decision 调用在");
  assert.equal(c.path, "outlines/ap-1/decision", "outline 走行级端点");
  assert.equal(c.body.decision, "drafting", "切写作中");
  assert.ok(!calls.some((x) => x.path.endsWith("/publish")), "不误触发布");
});

test("R10.49 尾巴②：drafting 行有「已发布」+「翻回待定」，翻回走 decision→pending（闭环）", async () => {
  calls.length = 0;
  await render([mkRow("dr-1", "drafting")]);
  await clickNav("写作中");
  assert.ok(Array.from(document.querySelectorAll("button")).find((x) => (x.textContent || "").trim() === "已发布"), "写作中行保留「已发布」");
  const flip = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent || "").trim() === "翻回待定");
  assert.ok(flip, "写作中行有「翻回待定」（闭环补齐）");
  await clickBtn((t) => t === "翻回待定");
  await new Promise((r) => setTimeout(r, 30));
  const c = decisionCalls()[0];
  assert.ok(c, "翻回调用在");
  assert.equal(c.path, "outlines/dr-1/decision");
  assert.equal(c.body.decision, "pending", "翻回待决策");
});

test("R10.49 尾巴③：pending 行无「标记写作中」；published 行无「标记写作中」", async () => {
  await render([mkRow("pd-1", "pending"), mkRow("pb-1", "published")]);
  await clickNav("待决策");
  assert.equal(Array.from(document.querySelectorAll("button")).find((x) => (x.textContent || "").trim() === "标记写作中"), undefined, "待决策行无该按钮");
  await clickNav("已发布");
  assert.equal(Array.from(document.querySelectorAll("button")).find((x) => (x.textContent || "").trim() === "标记写作中"), undefined, "已发布行无该按钮");
});
