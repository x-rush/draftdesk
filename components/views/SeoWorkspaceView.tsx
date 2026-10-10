"use client";
// 热词趋势 · SEO 工作台（信息架构 v2-4 + 热词捕获-4）：
// 数据源 = seo-terms 集合（外部 Agent 每日 upsert；category 主题类 + intent 搜索意图两字段）
// 与 seen-terms 集合（热词雷达三层：新词/突增/持续）。
// 板块：🔥 热词雷达（顶部）→ 全量词表 → 选题×搜索词 → 意图分层。
import { useState } from "react";
import type { Workspace, Snapshot } from "../useWorkspaceData";
import { Empty, api, date } from "../ui";
import { Pagination } from "../Pagination";
import { Select } from "../Select";

const INTENTS = ["怎么选型", "怎么装", "怎么修", "免费替代", "价格对比", "其他"] as const;

export function SeoWorkspaceView({ ws, data }: { ws: Workspace; data: Snapshot }) {
  const { seoTerms, busy, act, setNotice, navigate, setDiscussionContext, refresh } = ws;
  const [tab, setTab] = useState<"radar" | "terms" | "matched" | "intent">("radar");
  const [category, setCategory] = useState("all");
  const [intent, setIntent] = useState("all");
  const [source, setSource] = useState("all");
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const terms = seoTerms || [];
  const platforms = useMemo(() => [...new Set(terms.flatMap((t) => t.sources || []))], [terms]);
  const filtered = terms
    .filter((t) => (category === "all" || t.category === category) && (intent === "all" || t.intent === intent) && (source === "all" || (t.sources || []).includes(source)))
    .sort((a, b) => (b.frequency || 0) - (a.frequency || 0) || (b.lastSeenAt || "").localeCompare(a.lastSeenAt || ""));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(pages, Math.max(1, page));
  const pageItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  // ② 选题×搜索词：outline keyPoints 的「建议搜索词:」前缀行
  const matched = (ws.outlines || []).filter((o) => (o.keyPoints || []).some((k: string) => k.startsWith("建议搜索词:")));

  // 热词雷达（三层）：🆕 new（48h 内首见）/ 📈 rising / 🔥 sustained
  const seen = ws.seenTerms || [];
  const now48 = Date.now() - 48 * 3600000;
  const radar = {
    fresh: seen.filter((t) => t.status === "new" || Date.parse(t.firstSeenAt || 0) >= now48),
    rising: seen.filter((t) => t.status === "rising"),
    sustained: seen.filter((t) => t.status === "sustained"),
  };
  const [radarTab, setRadarTab] = useState<"new" | "rising" | "sustained">("new");
  const zoneLists: Record<string, any[]> = { new: radar.fresh, rising: radar.rising, sustained: radar.sustained };
  const [projectBusy, setProjectBusy] = useState<string | null>(null);
  async function projectTerm(term: string) {
    setProjectBusy(term);
    try {
      await api("site-projects", { term });
      setNotice("已立项建站（pending）。可回到应用机会页跟踪。");
      await refresh();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setProjectBusy(null);
    }
  }

  return (
    <>
      <section className="surface" style={{ marginBottom: 14 }}>
        <h2>🔥 热词雷达</h2>
        <p className="muted">三层雷达：新词（48h 内首见）→ 突增（观测晋级）→ 持续（连续 3 天在榜）。数据来自全源标题流的每日提取与外部 Agent 双写。</p>
        <nav className="discovery-modes" aria-label="雷达分区">
          <button className={radarTab === "new" ? "active" : ""} onClick={() => setRadarTab("new")}>🆕 新词 {radar.fresh.length}</button>
          <button className={radarTab === "rising" ? "active" : ""} onClick={() => setRadarTab("rising")}>📈 突增 {radar.rising.length}</button>
          <button className={radarTab === "sustained" ? "active" : ""} onClick={() => setRadarTab("sustained")}>🔥 持续 {radar.sustained.length}</button>
        </nav>
        {zoneLists[radarTab].length === 0 ? (
          <p className="muted">{radarTab === "new" ? "今日无爆发级新词，常规词表见下方。" : radarTab === "rising" ? "暂无突增词（观测 ≥2 次即晋级）。" : "暂无持续词（连续 3 天在榜即晋级）。"}</p>
        ) : (
          <div className="discovery-list">
            {zoneLists[radarTab].map((t) => (
              <article className="discovery-row" key={t.id}>
                <div className="row-content">
                  <div className="row-meta">
                    <span className="pill">{t.status === "new" ? "🆕 新词" : t.status === "rising" ? "📈 突增" : "🔥 持续"}</span>
                    {t.offTopic && <span className="pill">圈外</span>}
                    <span>观测 {t.observations} 次</span>
                    {(t.sources || []).length > 0 && <span>{(t.sources || []).join(" · ")}</span>}
                  </div>
                  <strong>{t.term}</strong>
                  {t.status === "sustained" && (
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      <button disabled={projectBusy === t.term} onClick={() => void projectTerm(t.term)}>生成站群评估并立项</button>
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <nav className="discovery-modes" aria-label="SEO 板块">
        {[["terms", "全量热词"], ["matched", "选题×搜索词"], ["intent", "意图分层"]].map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id as typeof tab)}>{label}</button>
        ))}
      </nav>
      {terms.length === 0 && tab !== "radar" && <Empty title="还没有搜索词数据。">
        外部 Agent 每日写入 seo-terms（词频/意图/源链接）后，这里会出现全量词表、选题匹配与意图分层。
      </Empty>}
      {terms.length > 0 && tab === "terms" && (
        <>
          <div className="filter-row">
            <Select aria-label="主题分类" value={category} onChange={(e) => setCategory(e.target.value)}><option value="all">全部分类</option>{[...new Set(terms.map((t) => t.category).filter(Boolean))].filter((o) => o !== "all").map((o) => <option key={o} value={o}>{o}</option>)}</Select>
            <Select aria-label="搜索意图" value={intent} onChange={(e) => setIntent(e.target.value)}><option value="all">全部意图</option>{INTENTS.filter((o) => terms.some((t) => t.intent === o)).map((o) => <option key={o} value={o}>{o}</option>)}</Select>
            <Select aria-label="平台" value={source} onChange={(e) => setSource(e.target.value)}><option value="all">全部平台</option>{platforms.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
          </div>
          <div className="discovery-list">
            {pageItems.map((t) => (
              <article className="discovery-row" key={t.term}>
                <div className="row-number">{String(t.frequency ?? 0)}</div>
                <div className="row-content">
                  <div className="row-meta">
                    <span className="pill">{t.category || "未分类"}</span>
                    {t.intent && <span className="pill">{t.intent}</span>}
                    <span>{(t.sources || []).join(" · ")}</span>
                    <small>{t.lastSeenAt ? date(t.lastSeenAt) : ""}</small>
                  </div>
                  <button className="article-title" onClick={() => { void navigator.clipboard.writeText(t.term); setNotice("已复制搜索词：" + t.term); }}>{t.term}</button>
                  <p>{t.trend7d ? `7 天趋势：${t.trend7d}` : ""}</p>
                </div>
                <div className="row-side">
                  <div className="tags">
                    {(t.sourceUrls || []).slice(0, 2).map((u: string) => <a key={u} href={u} target="_blank" rel="noopener noreferrer">源链接 ↗</a>)}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => { setDiscussionContext({ title: t.term, url: t.sourceUrls?.[0] || "", source: (t.sources || []).join("/") }); navigate("chat"); }}>讨论</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
          <Pagination info={{ page: safePage, pages, pageSize, total: filtered.length }} onChange={setPage} disabled={busy} />
        </>
      )}
      {terms.length > 0 && tab === "matched" && (matched.length === 0
        ? <Empty title="还没有选题带建议搜索词。">大纲 keyPoints 中写入「建议搜索词:」前缀行后，这里自动配对。</Empty>
        : <div className="discovery-list">
          {matched.map((o) => (
            <article className="discovery-row" key={o.id}>
              <div className="row-content">
                <div className="row-meta"><span>{o.platform}</span><span>{o.decision}</span></div>
                <strong>{o.title}</strong>
                <div className="tags">
                  {(o.keyPoints || []).filter((k: string) => k.startsWith("建议搜索词:")).map((k: string) => (
                    <span key={k}>{k.replace("建议搜索词:", "").trim()}</span>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>)}
      {terms.length > 0 && tab === "intent" && (
        <div className="discovery-list">
          {INTENTS.map((it) => {
            const group = terms.filter((t) => t.intent === it);
            if (!group.length) return null;
            return (
              <section key={it} style={{ marginBottom: 14 }}>
                <h3>{it}（{group.length}）</h3>
                <div className="tags">{group.slice(0, 30).map((t) => <span key={t.term}>{t.term} ×{t.frequency ?? 0}</span>)}</div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
