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

test("R10.54-②：总览信息条——可点项带跳转（pushState+popstate）、纯信息项无 affordance", async () => {
  await render([mkRow("ov1", "pending", ["gzh"])]);
  const strip = document.querySelector(".review-overview");
  assert.ok(strip, "总览信息条渲染（替代旧两行大卡）");
  const jumps = Array.from(strip!.querySelectorAll("button.review-info")) as HTMLElement[];
  assert.equal(jumps.length, 4, "四个可跳项：采集→sources / 组→panorama / 机会卡→ideas / 待查词→trends");
  const texts = jumps.map((b) => b.textContent || "");
  assert.ok(texts[0].includes("采集") && texts[1].includes("组") && texts[2].includes("机会卡") && texts[3].includes("待查词"), "跳转项顺序与文案");
  jumps[1].click(); // 组 → 素材仓库
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  assert.ok(window.location.search.includes("view=panorama"), "组卡软导航到素材仓库（pushState+popstate）");
  const plain = Array.from(strip!.querySelectorAll(".review-info:not(button)"));
  assert.ok(plain.length >= 4, "纯信息项（入池/待拍/今日已拍/外部消费）无按钮 affordance");
  const decisionStrip = document.querySelector(".stat-strip.decision-strip");
  assert.ok(decisionStrip, "决策状态卡行挂 decision-strip（active 主题化/hover 抬升样式钩子）");
});

test("R10.54-②：时间筛选——matchTimeRange 三档边界 + 弹层控件存在", async () => {
  const { matchTimeRange } = await import("../components/Review");
  const now = new Date().toISOString();
  const d2 = new Date(Date.now() - 2 * 86400000).toISOString();
  const d10 = new Date(Date.now() - 10 * 86400000).toISOString();
  assert.equal(matchTimeRange(now, "7d"), true, "2 小时前在近 7 天内");
  assert.equal(matchTimeRange(d2, "7d"), true, "2 天前在近 7 天内");
  assert.equal(matchTimeRange(d10, "7d"), false, "10 天前不在近 7 天内");
  assert.equal(matchTimeRange(d10, "30d"), true, "10 天前在近 30 天内");
  assert.equal(matchTimeRange(d10, "all"), true, "全部时间恒真");
  assert.equal(matchTimeRange(undefined, "7d"), true, "无时间戳行不因筛选消失");
  assert.equal(matchTimeRange("not-a-date", "7d"), true, "畸形时间戳不因筛选消失");
  await render([mkRow("tf", "pending", ["gzh"])]);
  (document.querySelector('summary[aria-label="筛选与批量操作"]') as HTMLElement).click();
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const trigger = document.querySelector('.select-trigger[aria-label="时间范围筛选"]');
  assert.ok(trigger, "时间范围 Select 渲染于筛选弹层（正交于来源/平台筛选）");
  assert.ok((document.body.textContent || "").includes("时间范围（按选题创建时间）"), "Field 标签在弹层可见");
});

test("R10.42 ①②：nav 与卡同键空间——点卡 nav 亮、点 nav 卡亮、pending 有 nav 入口", async () => {
  await render([
    mkRow("a", "pending", ["gzh"]),
    mkRow("b", "drafting", ["gzh"]), mkRow("c", "published", ["xhs-note"]),
    mkRow("d", "rejected", ["threads"]), mkRow("e", "deferred", ["tiebuhao"]),
  ]);
  const navLabels = Array.from(document.querySelectorAll('nav[aria-label="决策状态筛选"] button')).map((b) => (b.textContent || "").trim());
  assert.equal(navLabels.length, 6, "六键：全部+五组合键（R10.49 published 拆出）");
  assert.ok(navLabels.some((t) => t.startsWith("待决策")), "pending 有 nav 入口（旧 nav 排除 pending 已修）");
  // 点卡 → nav 同亮；「写作中」=仅 drafting
  await act(async () => { card("写作中").click(); });
  assert.ok((navBtn("写作中") as HTMLElement).className.includes("active"), "点卡后 nav 同亮");
  assert.deepEqual(rowsOf(), ["行-b"], "写作中=drafting 单态");
  // 「已发布」卡=仅 published
  await act(async () => { card("已发布").click(); });
  assert.ok((navBtn("已发布") as HTMLElement).className.includes("active"), "点已发布卡后 nav 同亮");
  assert.deepEqual(rowsOf(), ["行-c"], "published 独立卡（R10.49）");
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
  // 勾选 小红书图文笔记 → platforms 含 xhs-note 的行（x1/x3）
  const xhs = Array.from(document.querySelectorAll('[aria-label="平台多选筛选"] button')).find((b) => (b.textContent || "").includes("小红书图文笔记")) as HTMLElement;
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

test("R10.50 更新：徽章引导常显（适合 · 点徽章增删）", async () => {
  await render([mkRow("y1", "pending", ["gzh", "xhs-note"])]);
  const label = Array.from(document.querySelectorAll('[aria-label="适合平台编辑器"] span')).map((s) => s.textContent || "").join("");
  assert.ok(label.includes("点徽章增删"), "常显引导在徽章行");
});


test("R10.47 修订c：approved 行内「复制创作简报」——结构化 markdown 一次带全（标题/推荐/大纲/证据源）", async () => {
  const written: string[] = [];
  // jsdom 无 clipboard——直接在 navigator 上定义（Node navigator 无该属性）
  Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText: async (t: string) => { written.push(t); } }, configurable: true });
  await render([
    { sourceType: "outline", id: "z1", kind: "长文", title: "英特尔代工突围：三个被忽视的细节", clusterId: "clu-z",
      decision: "approved", platform: "gzh", platforms: ["gzh"], recommendation: "用成本曲线切入，避开情绪化叙事",
      outline: ["成本曲线对比", "良率爬坡时间线", "对国产供应链的影响"], evidenceRefs: ["https://example.org/a", "https://example.org/b"],
      createdAt: new Date().toISOString() },
  ]);
  // Review 默认档=pending——先回「全部」让 approved 行可见
  await act(async () => {
    const all = Array.from(document.querySelectorAll('nav[aria-label="决策状态筛选"] button')).find((x) => (x.textContent || "").startsWith("全部")) as HTMLElement;
    all.click();
  });
  const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").includes("复制创作简报")) as HTMLElement;
  assert.ok(btn, "简报按钮在 approved 行内");
  await act(async () => { btn.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  assert.equal(written.length, 1, "剪贴板收到一次写入");
  const md = written[0];
  assert.ok(md.includes("# 创作简报：英特尔代工突围"), "标题");
  assert.ok(md.includes("## 推荐建议") && md.includes("成本曲线切入"), "推荐建议段");
  assert.ok(md.includes("## 大纲方向") && md.includes("1. 成本曲线对比"), "大纲方向段");
  assert.ok(md.includes("## 证据源") && md.includes("https://example.org/a") && md.includes("https://example.org/b"), "证据源全量");
  assert.ok((document.body.textContent || "").includes("粘贴给小拾/任意 AI 助手"), "通知引导");
});

test("R10.47 修订b：草稿正文区已拆除——审查台行内不再渲染草稿编辑器", async () => {
  await render([
    { sourceType: "outline", id: "g1", kind: "长文", title: "行-g1 草稿区验证", clusterId: "c", decision: "approved",
      platform: "gzh", platforms: ["gzh"], draftBody: "## 旧草稿内容", createdAt: new Date().toISOString() },
  ]);
  assert.ok(!(document.body.textContent || "").includes("草稿正文"), "草稿区不在 DOM（draftBody 字段保留不展示）");
});
