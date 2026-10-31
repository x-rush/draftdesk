// R10.43 拍板深度验收（组件级，键盘流绕开 Radix Select）：
// ①多平台否决（X）→ 范围确认框 + 仅主平台执行路径；②通过（A）→ 确认框 + 应用到全部；
// ⑤rejected 行内「翻回待定」。平台级批量的 Radix Select 在 jsdom 无法交互——浏览器验收/下批补。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "draftdesk-r1043-"));
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
function mkRow(id: string, platforms: string[]): any {
  return { sourceType: "outline", id, kind: "长文", title: "行-" + id, clusterId: "clu-" + id, decision: "pending", platform: platforms[0], platforms, createdAt: new Date().toISOString() };
}
const press = async (key: string) => {
  await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); });
};
const clickIn = async (pred: (t: string) => boolean, scope: ParentNode) => {
  const b = Array.from(scope.querySelectorAll("button")).find((x) => pred((x.textContent || "").trim())) as HTMLElement;
  assert.ok(b, "按钮存在");
  await act(async () => { b.click(); });
};

after(async () => {
  await act(async () => root.unmount());
  store().close();
  rmSync(dir, { recursive: true, force: true });
});

test("R10.43 ①②：多平台否决（X）→ 确认框（平台级原因默认推荐全部）→ 仅主平台执行只拍 1 次", async () => {
  calls.length = 0;
  await render([mkRow("c1", ["gzh", "xhs-note"])]);
  await press("j");
  await press("x"); // X=否决（原因「其他」=平台级）
  const dlg = document.querySelector('[aria-label="拍板范围确认"]');
  assert.ok(dlg, "确认框出现");
  assert.ok((dlg!.textContent || "").includes("应用到全部 2 个平台（推荐）"), "平台级原因默认推荐全部");
  await clickIn((t) => t.startsWith("仅主平台"), dlg!);
  const pd = calls.filter((c) => c.path.startsWith("outlines/") && c.path.endsWith("platform-decision"));
  assert.equal(pd.length, 1, "仅主平台=1 次调用");
  assert.equal(pd[0].body.platform, "gzh");
  assert.equal(pd[0].body.decision, "rejected");
});

test("R10.43 ②：通过（A）→ 确认框 → 应用到全部=并集逐平台", async () => {
  calls.length = 0;
  await render([mkRow("c2", ["gzh", "xhs-note", "threads"])]);
  await press("j");
  await press("a");
  const dlg = document.querySelector('[aria-label="拍板范围确认"]');
  assert.ok((dlg!.textContent || "").includes("应用到全部 3 个平台"), "全部选项在");
  await clickIn((t) => t.startsWith("应用到全部"), dlg!);
  const pd = calls.filter((c) => c.path.startsWith("outlines/") && c.path.endsWith("platform-decision"));
  assert.equal(pd.length, 3, "并集三平台各一次");
  assert.deepEqual(pd.map((c) => c.body.platform).sort(), ["gzh", "threads", "xhs-note"]);
  assert.ok(pd.every((c) => c.body.decision === "approved"));
});

test("R10.43 ⑤：rejected 行内「翻回待定」调用行级翻转端点", async () => {
  calls.length = 0;
  await render([
    { sourceType: "outline", id: "f1", kind: "长文", title: "行-f1", clusterId: "c", decision: "rejected", platform: "gzh", platforms: ["gzh"], createdAt: new Date().toISOString() },
  ]);
  await act(async () => { // 默认档=pending，先回「全部」让 rejected 行可见
    const all = Array.from(document.querySelectorAll('nav[aria-label="决策状态筛选"] button')).find((x) => (x.textContent || "").startsWith("全部")) as HTMLElement;
    all.click();
  });
  await act(async () => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent || "").trim() === "翻回待定") as HTMLElement;
    assert.ok(b, "翻回按钮在行内");
    b.click();
  });
  const flip = calls.find((c) => c.path === "outlines/f1/decision");
  assert.ok(flip, "行级翻转端点");
  assert.equal(flip.body.decision, "pending");
});
