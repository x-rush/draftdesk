"use client";
// 热词趋势（布局重构批）：唯一数据源 = seen-terms 热词雷达。
// 旧 seo-terms「全量热词」板块移除——那是另一套从未被喂数据的写入合同（全站只有 2 条测试词），
// 空态文案误导（用户实拍批复）；siteCandidate 词仍在应用机会页消费，API 合同不变。
// 新词区噪音治理：词质筛选（💎 只看强相关）+ 强相关优先排序 + 行内「搜索 ↗」直达验证。
import { useState } from "react";
import type { Workspace, Snapshot } from "../useWorkspaceData";
import { Empty, api, Skeleton } from "../ui";
import { Pagination } from "../Pagination";
import { isLongTail } from "../../core/seen-terms";

// 热词掘金 v3：seen-terms 搜索意图四类筛选与中文标签
const DIG_INTENTS: [string, string][] = [["question", "问题类"], ["comparison", "比价类"], ["informational", "教程类"], ["commercial", "商业类"]];
// persona 相关性三档徽章：未判定不显示，避免新词噪音
const RELEVANCE_LABELS: Record<string, string> = { strong: "💎 强相关", weak: "○ 弱相关", off: "🚫 圈外" };
function RelevanceBadge({ relevance }: { relevance?: string }) {
  const label = relevance ? RELEVANCE_LABELS[relevance] : "";
  return label ? <span className="pill">{label}</span> : null;
}
// region 徽章（海外定位批）
function RegionBadge({ region }: { region?: string }) {
  if (region === "global") return <span className="pill">🌐 海外</span>;
  if (region === "cn") return <span className="pill">🇨🇳 中文</span>;
  return null;
}
// 值不值得做三档徽章（判定层）
const VERDICT_LABELS: Record<string, string> = { "推荐": "✅ 推荐", "可以试试": "🟦 可以试试", "不值得做": "⛔ 不值得做", "竞争度待查": "⏳ 竞争度待查" };
function VerdictBadge({ verdict, reason }: { verdict?: string; reason?: string }) {
  if (!verdict || verdict === "竞争度待查") return null;
  return <span className="pill" title={reason}>{VERDICT_LABELS[verdict] || verdict}</span>;
}
function ObsBadge({ obsRatio }: { obsRatio?: number }) {
  return typeof obsRatio === "number" ? <span title="近2天日均÷前7天日均">obs {obsRatio.toFixed(2)}</span> : null;
}

// 词质排序（新词 700+ 噪音治理）：strong 优先、观测降序；弱相关/未判定自然沉底
const RELEVANCE_RANK: Record<string, number> = { strong: 2, weak: 1 };
function sortZone(items: any[], quality: "all" | "strong"): any[] {
  let list = items ?? [];
  if (quality === "strong") list = list.filter((t) => t.relevance === "strong");
  return [...list].sort((a, b) => (RELEVANCE_RANK[b.relevance] ?? 0) - (RELEVANCE_RANK[a.relevance] ?? 0) || (b.observations ?? 0) - (a.observations ?? 0));
}

export function SeoWorkspaceView({ ws }: { ws: Workspace; data: Snapshot }) {
  const { setNotice, refresh } = ws;
  const [radarTab, setRadarTab] = useState<"new" | "rising" | "sustained">("new");
  const [quality, setQuality] = useState<"all" | "strong">("all");
  const [fullMode, setFullMode] = useState(false);
  const [radarBusy, setRadarBusy] = useState(false);

  const zones = ws.seenList?.zones;
  const zoneSources: Record<string, any[]> = {
    new: zones?.fresh?.items ?? [],
    rising: zones?.hot?.items ?? [],
    sustained: zones?.sustained?.items ?? [],
  };
  const zoneTotals: Record<string, number> = {
    new: zones?.fresh?.total ?? 0,
    rising: zones?.hot?.total ?? 0,
    sustained: zones?.sustained?.total ?? 0,
  };
  const zoneLists: Record<string, any[]> = {
    new: sortZone(zoneSources.new, quality),
    rising: sortZone(zoneSources.rising, quality),
    sustained: sortZone(zoneSources.sustained, quality),
  };
  const intentCounts: Record<string, number> = ws.seenList?.counts ?? {};

  function copyTerm(term: string) {
    void navigator.clipboard.writeText(term);
    setNotice(`已复制「${term}」——粘贴到搜索引擎看看真实联想与竞争`);
  }
  function searchTerm(term: string) {
    window.open("https://www.google.com/search?q=" + encodeURIComponent(term) + "&hl=en", "_blank", "noopener");
  }

  const zoneRows = (items: any[]) => items.map((t) => (
    <article className="discovery-row" key={t.id} role="listitem">
      <div className="row-content">
        <div className="row-meta">
          <RelevanceBadge relevance={t.relevance} />
          <RegionBadge region={t.region} />
          {isLongTail(t.term) && <span className="pill">🎯 长尾</span>}
          <VerdictBadge verdict={t.verdict} reason={t.verdictReason} />
          <ObsBadge obsRatio={t.obsRatio} />
          <span>观测 {t.observations} 次</span>
          {t.seed && <span>血缘：{t.seed}</span>}
        </div>
        <button className="article-title" style={{ fontSize: 17, padding: "4px 0 0" }} onClick={() => searchTerm(t.term)} title="点击去 Google 搜索验证">{t.term}</button>
      </div>
      <div className="row-side">
        <div style={{ display: "flex", gap: 6 }}>
          <button aria-label={`搜索：${t.term}`} onClick={() => searchTerm(t.term)}>搜索 ↗</button>
          <button aria-label={`复制：${t.term}`} onClick={() => copyTerm(t.term)}>复制</button>
        </div>
      </div>
    </article>
  ));

  return (
    <>
      <section className="surface">
        <h2>🔥 热词雷达</h2>
        <p className="muted">新词（首见原始信号，含噪音）→ 突增（观测 ≥3 才晋级）→ 持续（连续 3 天在榜）。💎 强相关词才进挖掘种子；点词名直接去 Google 验证。</p>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <nav className="discovery-modes" aria-label="雷达分区" style={{ marginTop: 8 }}>
            <button className={radarTab === "new" ? "active" : ""} aria-current={radarTab === "new" ? "page" : undefined} onClick={() => { setRadarTab("new"); setFullMode(false); }}>🆕 新词 {zoneTotals.new}</button>
            <button className={radarTab === "rising" ? "active" : ""} aria-current={radarTab === "rising" ? "page" : undefined} onClick={() => { setRadarTab("rising"); setFullMode(false); }}>📈 突增 {zoneTotals.rising}</button>
            <button className={radarTab === "sustained" ? "active" : ""} aria-current={radarTab === "sustained" ? "page" : undefined} onClick={() => { setRadarTab("sustained"); setFullMode(false); }}>🔥 持续 {zoneTotals.sustained}</button>
          </nav>
          <button disabled={radarBusy} onClick={() => void (async () => {
            setRadarBusy(true);
            try {
              const r = await api<{ triggered: boolean; alreadyDone: boolean }>("seen-terms/extract", {});
              setNotice(r.alreadyDone ? "今日已整理。" : "热词整理与挖掘已触发（提取/联想展开/竞争度判定，需数分钟），完成后自动更新。");
              await ws.refresh();
            } catch (e) { setNotice((e as Error).message); } finally { setRadarBusy(false); }
          })()}>{radarBusy ? "刷新中…" : "刷新雷达 · 触发提取"}</button>
        </div>
        {!fullMode && (
          <nav className="discovery-modes" aria-label="词质筛选" style={{ marginTop: 8 }}>
            <button className={quality === "all" ? "active" : ""} aria-current={quality === "all" ? "page" : undefined} onClick={() => setQuality("all")}>全部</button>
            <button className={quality === "strong" ? "active" : ""} aria-current={quality === "strong" ? "page" : undefined} onClick={() => setQuality("strong")}>💎 只看强相关</button>
          </nav>
        )}
        {/* 单一列表区：分区前 20 条；「查看全部」或搜索/筛选切到全量模式 */}
        {fullMode && (
          <>
            <nav className="discovery-modes" aria-label="区域筛选" style={{ marginTop: 8 }}>
              <button className={(ws.seenRegion || "") === "global" ? "active" : ""} aria-current={ws.seenRegion === "global" ? "page" : undefined} onClick={() => { ws.setSeenRegion("global"); ws.setSeenPage(1); }}>🌐 海外 {(ws.seenList?.regions?.global) ?? 0}</button>
              <button className={ws.seenRegion === "cn" ? "active" : ""} aria-current={ws.seenRegion === "cn" ? "page" : undefined} onClick={() => { ws.setSeenRegion("cn"); ws.setSeenPage(1); }}>🇨🇳 中文 {(ws.seenList?.regions?.cn) ?? 0}</button>
              <button className={ws.seenRegion === "" ? "active" : ""} aria-current={ws.seenRegion === "" ? "page" : undefined} onClick={() => { ws.setSeenRegion(""); ws.setSeenPage(1); }}>全部 {(ws.seenList?.regions?.all) ?? 0}</button>
            </nav>
            <nav className="discovery-modes" aria-label="搜索意图筛选" style={{ marginTop: 8 }}>
              <button className={!ws.seenIntent ? "active" : ""} aria-current={!ws.seenIntent ? "page" : undefined} onClick={() => { ws.setSeenIntent(""); ws.setSeenPage(1); }}>全部 {intentCounts.all ?? 0}</button>
              {DIG_INTENTS.map(([key, label]) => (
                <button key={key} className={ws.seenIntent === key ? "active" : ""} aria-current={ws.seenIntent === key ? "page" : undefined} onClick={() => { ws.setSeenIntent(key); ws.setSeenPage(1); }}>{label} {intentCounts[key] ?? 0}</button>
              ))}
            </nav>
          </>
        )}
        {fullMode ? (
          ws.seenLoading && !ws.seenList.items.length ? <Skeleton rows={3} label="词表加载中" /> : ws.seenList.items.length === 0 ? (
            <p className="muted">没有匹配的热词。</p>
          ) : (
            <>
              <div className="discovery-list" role="list" aria-label="热词全量词表">
                {ws.seenList.items.map((t: any) => (
                  <article className="discovery-row" key={t.id} role="listitem" style={{ padding: "18px 4px" }}>
                    <div className="row-content">
                      <div className="row-meta">
                        <span className="pill">{t.status}</span>
                        <RelevanceBadge relevance={t.relevance} />
                        <RegionBadge region={t.region} />
                        <VerdictBadge verdict={t.verdict} reason={t.verdictReason} />
                        <ObsBadge obsRatio={t.obsRatio} />
                        {t.intent && <span>{DIG_INTENTS.find(([k]) => k === t.intent)?.[1] || t.intent}</span>}
                        {isLongTail(t.term) && <span className="pill">🎯 长尾</span>}
                        {t.seed && <span>血缘：{t.seed}</span>}
                        <span>观测 {t.observations} 次</span>
                      </div>
                      <button className="article-title" style={{ fontSize: 17, padding: "4px 0 0" }} onClick={() => searchTerm(t.term)} title="点击去 Google 搜索验证">{t.term}</button>
                    </div>
                    <div className="row-side">
                      <div style={{ display: "flex", gap: 6 }}>
                        <button aria-label={`搜索：${t.term}`} onClick={() => searchTerm(t.term)}>搜索 ↗</button>
                        <button aria-label={`复制：${t.term}`} onClick={() => copyTerm(t.term)}>复制</button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
              <Pagination info={{ page: ws.seenPage, pages: Math.max(1, Math.ceil(ws.seenList.total / 50)), pageSize: 50, total: ws.seenList.total }} onChange={ws.setSeenPage} disabled={ws.seenLoading} />
            </>
          )
        ) : (
          ws.seenLoading && !zoneLists[radarTab].length ? <Skeleton rows={3} label="热词雷达加载中" /> : zoneLists[radarTab].length === 0 ? (
            <p className="muted">
              {quality === "strong"
                ? `这一档暂无 💎 强相关词（共 ${zoneTotals[radarTab]} 条在榜，切回「全部」看原始信号）。`
                : radarTab === "new" ? "暂无新词。" : radarTab === "rising" ? "暂无突增词（观测 ≥3 次且 7 天内首见）。" : "暂无持续词（连续 3 天在榜即晋级）。"}
            </p>
          ) : (
            <div className="discovery-list" role="list" aria-label={`${{ new: "新词", rising: "突增", sustained: "持续" }[radarTab]}区（前 20 条）`}>
              {zoneRows(zoneLists[radarTab])}
            </div>
          )
        )}
        {fullMode ? (
          <button className="text-button" onClick={() => setFullMode(false)}>← 返回雷达分区视图</button>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              新词是每日提取的原始信号，观测 1 次不代表真需求——连续出现才晋级突增。弱相关词多为沾边噪音，💎 筛选可只看可用的。
            </p>
            <button className="text-button" onClick={() => {
              setFullMode(true);
              ws.setSeenStatus(radarTab === "new" ? "new" : radarTab === "sustained" ? "sustained" : "");
              ws.setSeenIntent("");
              ws.setSeenPage(1);
            }}>查看全部 {zoneTotals[radarTab] || 0} 条（区域/意图/搜索/分页）→</button>
          </>
        )}
      </section>
      {!ws.seenLoading && !ws.seenList.items.length && !ws.seenList.total && !fullMode && (
        <Empty title="词库还是空的。">
          点上方「刷新雷达 · 触发提取」开始第一次采集：标题流提词 → 联想展开 → 相关性判定，全程约几分钟。
        </Empty>
      )}
    </>
  );
}
