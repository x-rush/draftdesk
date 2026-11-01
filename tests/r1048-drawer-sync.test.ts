// R10.43⑥ 验收：队列抽屉拍板后 detail 同步——
// ①抽屉内平台徽章拍板 → 聚合出队 → 抽屉自动关（pending 队列里任一徽章拍板即离开 pending）；
// ①b 仍 pending 的同步分支（抽屉内改题材）→ 行不出队、抽屉保持开启且换新快照；
// ②行级拍板出队 → 抽屉自动关闭（列表即真相）。
// OutlineQueueView jsdom（ws/data 双 mock，act 驱动乐观拍板 + 服务端效果对账）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1048-"));
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
const dlgProto = (dom.window as any).HTMLDialogElement?.prototype;
if (dlgProto && !dlgProto.showModal) {
  dlgProto.showModal = function () { this.open = true; };
  dlgProto.close = function () { this.open = false; };
}

const { store } = await import("../core/store");
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { OutlineQueueView } = await import("../components/views/OutlineQueueView");
const act = (React as any).act;

let outlinesState: any[] = [];
const calls: { path: string; body: any }[] = [];
const noticeStack: string[] = [];
const ws: any = {
  get outlines() { return outlinesState; },
  clusters: [],
  setNotice: (t: string) => noticeStack.push(t),
  navigate: () => {},
  busy: false,
  act: async (fn: () => Promise<void>, opts?: { apply: () => void; undo: () => void }) => {
    const before = calls.length;
    try { await fn(); opts?.apply(); } catch { opts?.undo(); throw new Error("网络失败"); }
    // 模拟真 ws.act 的成功后对账：按本次新增调用把服务端效果映射回内存 outlines
    for (const c of calls.slice(before)) {
      const pm = c.path.match(/^outlines\/(.+?)\/platform-decision$/);
      if (pm) outlinesState = outlinesState.map((o) => o.id === pm[1]
        ? { ...o, perPlatformDecision: { ...(o.perPlatformDecision || {}), [c.body.platform]: c.body.decision }, decision: c.body.decision }
        : o);
      const dm = c.path.match(/^outlines\/(.+?)\/decision$/);
      if (dm) outlinesState = outlinesState.map((o) => o.id === dm[1] ? { ...o, decision: c.body.decision } : o);
      const cm = c.path.match(/^outlines\/(.+?)\/category$/);
      if (cm) outlinesState = outlinesState.map((o) => o.id === cm[1] ? { ...o, category: c.body.category } : o);
    }
  },
  mutateOutlines: (fn: (list: any[]) => any[]) => { outlinesState = fn(outlinesState); },
  setDiscussionContext: () => {},
};
const data = {};

(globalThis as any).fetch = async (input: any, init?: any) => {
  const route = String(input).replace(/^\/api\/v1\//, "").split("?")[0];
  const method = init?.method || "GET";
  if (method !== "GET") calls.push({ path: route, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
};

const rootEl = document.getElementById("root")!;
const root = createRoot(rootEl);
let mountKey = 0;
async function render() {
  await act(async () => { root.render(React.createElement(OutlineQueueView as any, { key: ++mountKey, ws, data: {} as any })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}
const mk = (id: string, platforms: string[], per: Record<string, string> = {}) => ({
  id, clusterId: "clu-" + id, title: "行-" + id, decision: "pending", platform: platforms[0], platforms,
  contentType: "长文", keyPoints: [], evidenceRefs: [], createdAt: new Date().toISOString(), perPlatformDecision: per, suggestions: [],
});
const drawerOpen = () => (document.body.textContent || "").includes("适合平台");
const drawerBadge = (label: string) => {
  const btns = Array.from(document.querySelectorAll('button[title*="点击拍板"]'));
  return btns.find((b) => (b.textContent || "").includes(label)) as HTMLElement | undefined;
};
async function clickDrawerBtn(label: string) {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim().startsWith(label)) as HTMLElement;
  assert.ok(btn, "按钮存在: " + label);
  await act(async () => { btn.click(); });
}

after(async () => {
  await act(async () => root.unmount());
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("R10.43⑥ ①：抽屉内平台徽章拍板 → 聚合出队 → 抽屉自动关", async () => {
  outlinesState = [mk("d1", ["gzh", "xhs-note"], { gzh: "pending", "xhs-note": "pending" })];
  await render();
  await act(async () => { (document.querySelector(".article-title") as HTMLElement).click(); });
  assert.ok(drawerOpen(), "抽屉打开");
  const badge = drawerBadge("公众号");
  assert.ok(badge, "公众号徽章在抽屉内");
  await act(async () => { badge!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  assert.equal(drawerOpen(), false, "聚合 approved → 出队 → 抽屉自动关");
  assert.equal(outlinesState[0].decision, "approved", "乐观聚合落库");
  assert.ok(calls.some((c) => c.path === "outlines/d1/platform-decision" && c.body.decision === "approved"));
});

test("R10.43⑥ ①b：仍 pending 的同步分支——抽屉内改题材 → 行不出队、抽屉保持开启", async () => {
  outlinesState = [mk("d1b", ["gzh"])];
  await render();
  await act(async () => { (document.querySelector(".article-title") as HTMLElement).click(); });
  const catBtn = Array.from(document.querySelectorAll("button.pill")).find((b) => ((b as HTMLElement).title || "").includes("点击切换题材")) as HTMLElement;
  assert.ok(catBtn, "题材点改按钮在抽屉内");
  await act(async () => { catBtn.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  assert.ok(drawerOpen(), "行仍 pending → 抽屉保持开启（detail 已换新快照）");
  assert.equal(outlinesState[0].category, "newtech", "题材落库");
});

test("R10.43⑥ ②：行级拍板出队 → 抽屉自动关闭（列表即真相）", async () => {
  outlinesState = [mk("d2", ["gzh"])];
  await render();
  await act(async () => { (document.querySelector(".article-title") as HTMLElement).click(); });
  assert.ok(drawerOpen(), "抽屉打开");
  await clickDrawerBtn("通过");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  assert.equal(drawerOpen(), false, "出队 → 抽屉自动关");
  assert.equal(outlinesState[0].decision, "approved", "乐观落库");
  assert.ok(noticeStack.some((t) => t.includes("已拍板出队")), "出队通知");
});
