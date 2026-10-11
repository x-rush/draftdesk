"use client";
// 应用机会 · 站群评估器（信息架构 v2-5）：
// 数据源 = seo-terms 中 siteCandidate:true 的词；域名/站型/需求大纲均来自外部 Agent 数据。
// [讨论][推进=立项建站（site-projects, pending）]；忽略为会话级隐藏。
// 站点发现 tab（海外定位批 6）：site-discoveries 独立站卡片（host/命中词/首次发现/它做的是什么）。
import { useMemo, useState } from "react";
import type { Workspace, Snapshot } from "../useWorkspaceData";
import { Empty, api, date } from "../ui";

export function SiteEvaluatorView({ ws, data }: { ws: Workspace; data: Snapshot }) {
  const { seoTerms, siteProjects, siteDiscoveries, busy, act, setNotice, navigate, setDiscussionContext } = ws;
  const [siteType, setSiteType] = useState("all");
  const [ignored, setIgnored] = useState<string[]>([]);
  const [tab, setTab] = useState<"candidates" | "sites">("candidates");
  const candidates = useMemo(
    () => (seoTerms || []).filter((t) => t.siteCandidate === true && !ignored.includes(t.term)),
    [seoTerms, ignored],
  );
  const filtered = siteType === "all" ? candidates : candidates.filter((t) => t.siteType === siteType);
  const projects = siteProjects || [];
  const discoveries = siteDiscoveries || [];

  return (
    <>
      <nav className="discovery-modes" aria-label="应用机会板块">
        <button className={tab === "candidates" ? "active" : ""} aria-current={tab === "candidates" ? "page" : undefined} onClick={() => setTab("candidates")}>站群候选 {candidates.length}</button>
        <button className={tab === "sites" ? "active" : ""} aria-current={tab === "sites" ? "page" : undefined} onClick={() => setTab("sites")}>🌐 站点发现 {discoveries.length}</button>
      </nav>
      {tab === "sites" && (
        discoveries.length === 0 ? (
          <Empty title="还没有站点发现。">
            判定层每天对 score TOP100 强相关海外词查 DDG 竞争度（vercel/github.io/pages.dev/netlify.app），
            查到的同题独立站会自动出现在这里。首跑约需 3-5 分钟。
          </Empty>
        ) : (
          <div className="discovery-list">
            {discoveries.map((s) => (
              <article className="discovery-row" key={s.host}>
                <div className="row-content">
                  <div className="row-meta">
                    <span className="pill">{s.platform}</span>
                    {s.brand ? <span className="pill">🚫 不建议做</span> : <span className="pill">✅ 候选</span>}
                    {s.brandReason && <span>原因：{s.brandReason}</span>}
                    <span>首次发现 {s.firstFoundAt ? date(s.firstFoundAt) : ""}</span>
                    <span>DDG 最低排名 {s.bestRank}</span>
                  </div>
                  <a className="article-title" style={{ fontSize: 17, padding: "4px 0 0" }} href={`https://${s.host}`} target="_blank" rel="noopener noreferrer">{s.host} ↗</a>
                  <div className="tags">
                    {(s.terms || []).slice(0, 6).map((t: string) => <span key={t}>命中词：{t}</span>)}
                  </div>
                </div>
                <div className="row-side">
                  <button onClick={() => { void navigator.clipboard.writeText(s.host); setNotice("已复制域名：" + s.host); }}>复制域名</button>
                </div>
              </article>
            ))}
          </div>
        )
      )}
      {tab === "candidates" && (
      <>
      <div className="filter-row">
        <select aria-label="按站型筛选" value={siteType} onChange={(e) => setSiteType(e.target.value)}>
          <option value="all">全部站型</option>
          <option value="资讯站">资讯站（广告变现）</option>
          <option value="工具站">工具站（订阅变现）</option>
        </select>
        <span className="muted">已立项 {projects.length} 个 · 候选 {candidates.length} 个</span>
      </div>
      {filtered.length === 0 ? (
        <Empty title="暂无站群候选。">外部 Agent 按「频次≥3 且来源≥2」标记 siteCandidate 后，评估卡出现在这里。</Empty>
      ) : (
        <div className="discovery-list">
          {filtered.map((t) => {
            const project = projects.find((p) => p.term === t.term);
            return (
              <article className="discovery-row" key={t.term}>
                <div className="row-number">{String(t.frequency ?? 0)}</div>
                <div className="row-content">
                  <div className="row-meta">
                    <span className="pill">{t.siteType || "待评估站型"}</span>
                    {t.category && <span className="pill">{t.category}</span>}
                    <span>{(t.sources || []).join(" · ")}{t.trend7d ? ` · 7 天趋势 ${t.trend7d}` : ""}</span>
                  </div>
                  <button className="article-title" style={{ fontSize: 18, padding: "5px 0 0" }} onClick={() => { void navigator.clipboard.writeText(t.term); setNotice("已复制词：" + t.term); }}>{t.term}</button>
                  {t.domainSuggestions?.length ? (
                    <p>
                      域名建议（仅建议）：
                      {t.domainSuggestions.map((d: string) => (
                        <button key={d} className="text-button" style={{ marginRight: 8 }} onClick={() => { void navigator.clipboard.writeText(d); setNotice("已复制域名：" + d); }}>
                          {d} ⧉
                        </button>
                      ))}
                    </p>
                  ) : (
                    <p className="muted">暂无域名建议（等外部 Agent 评估补充）。</p>
                  )}
                  {t.siteRationale && <p className="muted">判断依据：{t.siteRationale}</p>}
                  {t.contentOutline?.length ? (
                    <details className="fold-card">
                      <summary>需求大纲（{t.contentOutline.length} 条）</summary>
                      <ol>{t.contentOutline.map((c: string, i: number) => <li key={i}>{c}</li>)}</ol>
                      <button onClick={() => { setDiscussionContext({ title: "站群深化：" + t.term, url: t.sourceUrls?.[0] || "", source: (t.sources || []).join("/") }); navigate("chat"); }}>发起讨论深化</button>
                    </details>
                  ) : null}
                  <div className="tags">
                    {(t.sourceUrls || []).slice(0, 3).map((u: string) => <a key={u} href={u} target="_blank" rel="noopener noreferrer">数据源 ↗</a>)}
                  </div>
                </div>
                <div className="row-side">
                  {project ? (
                    <small>已立项 · {project.status}</small>
                  ) : (
                    <button className="primary" disabled={busy} onClick={() => void act(async () => { await api("site-projects", { term: t.term }); setNotice("已立项建站（pending）。"); })}>推进 · 立项建站</button>
                  )}
                  <button className="button-secondary" disabled={busy} onClick={() => setIgnored([...ignored, t.term])}>忽略</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      </>
      )}
    </>
  );
}
