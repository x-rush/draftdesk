// R10.47 补丁验收：①筛选弹窗在 Radix Select 下拉选项点击时不再误关（popper wrapper 白名单）；
// ②批量范围自动推导三段——一致直拍（无确认）/不一致交集确认/筛选+勾选组合。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1049-"));
delete process.env.REDIS_URL;
process.env.DRAFTDESK_DATA_DIR = dir;

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div><div id='probe'></div></body></html>", { url: "http://127.0.0.1:5173/", pretendToBeVisual: true });
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
const { usePopoverAutoClose } = await import("../components/usePopoverAutoClose");
const act = (React as any).act;

// ── 弹窗白名单探针（独立 root，直接挂 hook）──
const probeRoot = createRoot(document.getElementById("probe")!);
function Probe() {
  usePopoverAutoClose();
  return React.createElement("details", { "data-popover": true, open: true, id: "pop" },
    React.createElement("summary", null, "弹层"),
    React.createElement("div", { id: "pop-body" }, "内容"));
}
await act(async () => { probeRoot.render(React.createElement(Probe)); });

// ── Review 组件 harness ──
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
function mkRow(id: string, platforms: string[]): any {
  return { sourceType: "outline", id, kind: "长文", title: "行-" + id, clusterId: "clu-" + id, decision: "pending", platform: platforms[0], platforms, createdAt: new Date().toISOString() };
}
const clickBtn = async (pred: (t: string) => boolean) => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => pred((x.textContent || "").trim())) as HTMLElement;
  assert.ok(b, "按钮存在");
  await act(async () => { b.click(); });
};
const selectAll = async () => {
  const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
  await act(async () => { boxes.forEach((b) => (b as HTMLInputElement).click()); });
};
const pdCalls = () => calls.filter((c) => c.path.endsWith("/decision") || c.path === "decisions/batch");

after(async () => {
  await act(async () => root.unmount());
  probeRoot.unmount();
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("R10.47 ①：筛选弹窗在 Radix popper 内点击不误关；外部点击仍关", async () => {
  const pop = document.getElementById("pop")!;
  // Radix Select 下拉面板场景：popper wrapper 内点击 → details 保持 open
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-radix-popper-content-wrapper", "");
  const inner = document.createElement("button");
  inner.textContent = "下拉选项";
  wrapper.appendChild(inner);
  document.body.appendChild(wrapper);
  await act(async () => {
    inner.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
  });
  assert.equal(pop.hasAttribute("open"), true, "popper 内点击不关闭（白名单生效）");
  // 外部点击 → 关闭
  await act(async () => {
    document.body.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
  });
  assert.equal(pop.hasAttribute("open"), false, "外部点击仍关闭");
  wrapper.remove();
});

test("R10.50 更新 ②a：批量通过=行级直拍（平台一致也不分流）", async () => {
  calls.length = 0;
  await render([mkRow("a1", ["gzh", "xhs-note"]), mkRow("a2", ["gzh", "xhs-note"])]);
  await selectAll();
  await clickBtn((t) => t === "批量通过");
  await new Promise((r) => setTimeout(r, 40)); // 异步批量落库
  assert.equal(document.querySelector('[aria-label="拍板范围确认"]'), null, "一致 → 无确认框");
  const batchCall = pdCalls().find((c) => c.path === "decisions/batch");
  assert.ok(batchCall, "单次 decisions/batch 行级直拍");
  assert.equal(batchCall.body.decision, "approved");
  assert.ok(!calls.some((c) => c.path.includes("/platforms") || c.path.includes("platform-decision")), "无平台分流");
});

test("R10.50 更新 ②b：平台不一致 → 行级直拍（交集确认框已退役）", async () => {
  calls.length = 0;
  await render([mkRow("b1", ["gzh", "xhs-note"]), mkRow("b2", ["gzh", "threads"])]);
  await selectAll();
  await clickBtn((t) => t === "批量通过");
  await new Promise((r) => setTimeout(r, 40)); // 异步批量落库
  assert.equal(document.querySelector('[aria-label="拍板范围确认"]'), null, "交集确认框已退役");
  const batchCall = pdCalls().find((c) => c.path === "decisions/batch");
  assert.ok(batchCall, "行级 batch 调用在");
  assert.deepEqual(batchCall.body.ids.sort(), ["b1", "b2"], "两行都进 batch（平台不一致也不分流）");
});

test("R10.47 ②c：筛选+勾选组合——平台筛选筛出后再勾选，范围自然限定", async () => {
  calls.length = 0;
  await render([
    mkRow("c1", ["gzh", "xhs-note"]),
    mkRow("c2", ["threads"]),
    mkRow("c3", ["gzh", "xhs-note"]),
  ]);
  // 平台筛选勾选 小红书图文笔记 → 只渲染 c1/c3
  const pill = Array.from(document.querySelectorAll('[aria-label="平台多选筛选"] button')).find((b) => (b.textContent || "").includes("小红书图文笔记")) as HTMLElement;
  await act(async () => { pill.click(); });
  await selectAll();
  await clickBtn((t) => t === "批量通过");
  await new Promise((r) => setTimeout(r, 40)); // 异步批量落库
  const batchCall = pdCalls().find((c) => c.path === "decisions/batch");
  assert.ok(batchCall, "batch 调用在");
  assert.deepEqual(batchCall.body.ids.sort(), ["c1", "c3"], "筛选后的勾选集 c1/c3（c2 未被卷入）");
});
