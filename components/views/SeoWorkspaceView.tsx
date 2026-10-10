"use client";
// 热词趋势 · SEO 工作台（信息架构 v2-4）：
// 数据源 = seo-terms 集合（外部 Agent 每日 upsert；category 主题类 + intent 搜索意图两字段）。
// 三板块：① 全量词表（频次降序+筛选+源链接）② 选题×搜索词 ③ 意图分层。
import { useMemo, useState } from "react";
import type { Workspace, Snapshot } from "../useWorkspaceData";
import { Empty, api, date } from "../ui";
import { Pagination } from "../Pagination";
import { Select } from "../Select";

const INTENTS = ["怎么选型", "怎么装", "怎么修", "免费替代", "价格对比", "其他"] as const;

export function SeoWorkspaceView({ ws, data }: { ws: Workspace; data: Snapshot }) {
  const { seoTerms, busy, act, setNotice, navigate, setDiscussionContext } = ws;
  const [tab, setTab] = useState<"terms" | "matched" | "intent">("terms");
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

  return (
    <>
      <nav className="discovery-modes" aria-label="SEO 板块">
        {[["terms", "全量热词"], ["matched", "选题×搜索词"], ["intent", "意图分层"]].map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id as typeof tab)}>{label}</button>
        ))}
      </nav>
      {terms.length === 0 && <Empty title="还没有搜索词数据。">
        外部 Agent 每日写入 seo-terms（词频/意图/源链接）后，这里会出现全量词表、选题匹配与意图分层。
      </Empty>}
      {terms.length > 0 && tab === "terms" && (
        <>
          <div className="filter-row">
            <Select aria-label="主题分类" value={category} onChange={(e) => setCategory(e.target.value)}><option value="all">$6</option>{["all", ...new Set(terms.map((t) => t.category).filter(Boolean))].filter((o) => o && o !== "all").map((o) => <option key={o} value={o}>{o}</option>)}</Select>
            <Select aria-label="搜索意图" value={intent} onChange={(e) => setIntent(e.target.value)}><option value="all">$6</option>{["all", ...INTENTS].filter((o) => o && o !== "all").map((o) => <option key={o} value={o}>{o}</option>)}</Select>
            <Select aria-label="平台" value={source} onChange={(e) => setSource(e.target.value)}><option value="all">$6</option>{["all", ...platforms].filter((o) => o && o !== "all").map((o) => <option key={o} value={o}>{o}</option>)}</Select>
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

