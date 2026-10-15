# -*- coding: utf-8 -*-
# R8-4② 待查清单路由 + Markdown 报告解析增强；R8-4③ 台账
p = "core/seo-source.ts"
s = open(p, encoding="utf-8").read()
# Markdown 报告模式：哥飞网页一键复制（粗体词条目/表格行/标题行防御式解析）
old = """  // 文本模式：每行一条，分隔符 tab/竖线/多空格，字段序=词 月搜 KD CPC（后三可缺）。防御式，解析不出的行跳过。"""
new = """  // Markdown 报告模式（哥飞网页一键复制）：剥粗体/标题记号后按文本模式解析，
  // 表格行（| 分隔）天然被分隔符覆盖。识别特征：行含 ** 或以 # 或 | 开头。
  const looksLikeMarkdown = /\\*\\*|^#|\\|^\\s*\\|/m.test(text);
  // 文本模式：每行一条，分隔符 tab/竖线/多空格，字段序=词 月搜 KD CPC（后三可缺）。防御式，解析不出的行跳过。"""
assert old in s, "md marker"
s = s.replace(old, new)
old = """  const items: ManualGepheiItem[] = [];
  for (const line of text.split(/\\r?\\n/)) {
    const cols = line.trim().split(/\\t|\\s{2,}|\\s*\\|\\s*/).filter(Boolean);"""
new = """  const items: ManualGepheiItem[] = [];
  for (const rawLine of text.split(/\\r?\\n/)) {
    const line = looksLikeMarkdown ? rawLine.replace(/\\*\\*/g, "").replace(/^#+\\s*/, "") : rawLine;
    const cols = line.trim().split(/\\t|\\s{2,}|\\s*\\|\\s*/).filter(Boolean);"""
assert old in s, "text loop"
s = s.replace(old, new)
# mode 判定：Markdown 命中时返回 "md"（对外仍算文本族）
old = """    if (items.length) return { items, mode: "text" };
  }
  return { items, mode: "text" };"""
new = """    if (items.length) return { items, mode: looksLikeMarkdown ? "md" : "text" };
  }
  return { items, mode: "text" };"""
assert old in s, "mode"
s = s.replace(old, new)
s = s.replace('export function parseManualGephei(raw: string): { items: ManualGepheiItem[]; mode: "json" | "text" } {',
              'export function parseManualGephei(raw: string): { items: ManualGepheiItem[]; mode: "json" | "text" | "md" } {')
open(p, "w", encoding="utf-8", newline="").write(s)
print("markdown parse ok")

# geo.ts 加今日待查清单路由
p = "core/routes/geo.ts"
s = open(p, encoding="utf-8").read()
old = """  {
    // Agent 读口：标杆站页面（第十二步消费侧=外部 Agent 挑高流量页需求词）
    methods: ["GET"],
    pattern: "agent/benchmark-pages","""
new = """  {
    // UI 口：今日待查清单（R8-4②，批4 指导行的聚合升级）——共享质量闸
    // （dailyMetricsCandidates：strong+global+低竞争+obs≥5+未出标+过期，英文优先）取前 10，
    // 每词三张实测深链；回传成功（manualAt）自动移出清单。
    methods: ["GET"],
    pattern: "seo-terms/today",
    handler: ({ db }) => {
      const gate = siteGateOf(db);
      const markedIds = new Set(db.list("seo-terms").filter((t) => t.siteCandidate === true).map((t) => termId(String(t.term || t.id))));
      const items = dailyMetricsCandidates(db, gate, markedIds)
        .filter((t) => isEnglishTerm(String(t.term || t.id)))
        .slice(0, 10)
        .map((t) => ({
          term: String(t.term || t.id),
          observations: t.observations ?? 0,
          links: gepheiToolLinks(String(t.term || t.id)).slice(0, 3),
        }));
      return json({ items, total: items.length, generatedAt: now() });
    },
  },
  {
    // Agent 读口：标杆站页面（第十二步消费侧=外部 Agent 挑高流量页需求词）
    methods: ["GET"],
    pattern: "agent/benchmark-pages","""
assert old in s, "today route"
s = s.replace(old, new)
s = s.replace(
  'import { ensureBenchmarkSeeds, applyManualGephei } from "../gephei-collect";',
  'import { ensureBenchmarkSeeds, applyManualGephei } from "../gephei-collect";\nimport { dailyMetricsCandidates, isEnglishTerm, siteGateOf } from "../seo-gate";\nimport { gepheiToolLinks } from "../seo-source";')
open(p, "w", encoding="utf-8", newline="").write(s)
print("geo today ok")
