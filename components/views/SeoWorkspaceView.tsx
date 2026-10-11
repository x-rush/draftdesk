"use client";
// 热词趋势 · 信号台（完全重设计批）：四层信息架构——
// ① 统计条（词库/强相关/突增/持续 四个数字卡，一眼掌握池子健康度）
// ② 今日精选（强相关 Top6 hero 卡，页面有自己的「脸」）
// ③ 分区扫描（新词/突增/持续 tab + 词质筛选 + 紧凑词行）
// ④ 全量词表（区域/意图/搜索/分页，查看全部展开）
// 旧 seo-terms 板块已在前轮移除；本页唯一数据源 = seen-terms。
import { useMemo, useState } from "react";
import type { Workspace, Snapshot } from "../useWorkspaceData";
import { Empty, api, Skeleton } from "../ui";
import { Ban, CheckCircle2, Circle, ClipboardList, Crosshair, Flame, Gem, Globe, Sparkles, Star, TrendingUp, XCircle } from "lucide-react";
import { Pagination } from "../Pagination";
import { isLongTail } from "../../core/seen-terms";

const DIG_INTENTS: [string, string][] = [["question", "问题类"], ["comparison", "比价类"], ["informational", "教程类"], ["commercial", "商业类"]];
const RELEVANCE_LABELS: Record<string, string> = { strong: "强相关", weak: "弱相关", off: "圈外" };
function RelevanceBadge({ relevance }: { relevance?: string }) {
  const label = relevance ? RELEVANCE_LABELS[relevance] : "";
  if (!label) return null;
  const icon = relevance === "strong" ? <Gem size={11} /> : relevance === "off" ? <Ban size={11} /> : <Circle size={8} />;
  return <span className="pill">{icon} {label}</span>;
}
function RegionBadge({ region }: { region?: string }) {
  if (region === "global") return <span className="pill"><Globe size={11} /> 海外</span>;
  if (region === "cn") return <span className="pill">中文</span>;
  return null;
}
const VERDICT_LABELS: Record<string, string> = { "推荐": "推荐", "可以试试": "可以试试", "不值得做": "不值得做" };
function VerdictIcon({ verdict }: { verdict: string }) {
  return verdict === "推荐" ? <CheckCircle2 size={11} /> : verdict === "不值得做" ? <XCircle size={11} /> : <Circle size={8} />;
}
function VerdictBadge({ verdict, reason }: { verdict?: string; reason?: string }) {
  if (!verdict || verdict === "竞争度待查") return null;
  return <span className="pill" title={reason}><VerdictIcon verdict={verdict} /> {VERDICT_LABELS[verdict] || verdict}</span>;
}
function ObsBadge({ obsRatio }: { obsRatio?: number }) {
  return typeof obsRatio === "number" ? <span title="近2天日均÷前7天日均">obs {obsRatio.toFixed(2)}</span> : null;
}

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
  const regions = ws.seenList?.regions ?? {};
  const relevances = ws.seenList?.relevances ?? {};
  const intentCounts: Record<string, number> = ws.seenList?.counts ?? {};

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

  // 今日精选：全库强相关（新词+突增合并去重），观测降序取 6——页面的「脸」
  const heroes = useMemo(() => {
    const seen = new Set<string>();
    return [...(zones?.fresh?.items ?? []), ...(zones?.hot?.items ?? [])]
      .filter((t) => {
        const id = String(t.id);
        if (seen.has(id)) return false;
        seen.add(id);
        return t.relevance === "strong";
      })
      .sort((a, b) => (b.observations ?? 0) - (a.observations ?? 0))
      .slice(0, 6);
  }, [zones]);

  function copyTerm(term: string) {
    void navigator.clipboard.writeText(term);
    setNotice(`已复制「${term}」——粘贴到搜索引擎看看真实联想与竞争`);
  }
  function searchTerm(term: string) {
    window.open("https://www.google.com/search?q=" + encodeURIComponent(term) + "&hl=en", "_blank", "noopener");
  }
  async function triggerExtract() {
    setRadarBusy(true);
    try {
      const r = await api<{ triggered: boolean; alreadyDone: boolean }>("seen-terms/extract", {});
      setNotice(r.alreadyDone ? "今日已整理。" : "热词整理与挖掘已触发（提取/联想展开/竞争度判定，需数分钟），完成后自动更新。");
      await refresh();
    } catch (e) { setNotice((e as Error).message); } finally { setRadarBusy(false); }
  }

  const bankEmpty = (regions.all ?? 0) === 0 && !ws.seenLoading;

  if (bankEmpty && !fullMode) {
    return (
      <Empty title="词库还是空的。">
        <button className="primary" disabled={radarBusy} onClick={() => void triggerExtract()}>{radarBusy ? "启动中…" : "开始第一次采集"}</button>
        <p className="muted" style={{ marginTop: 10 }}>标题流提词 → 联想展开 → 相关性判定，全程约几分钟，完成后这个页面会出现统计条与今日精选。</p>
      </Empty>
    );
  }

  return (
    <>
      {/* ① 统计条 */}
      <div className="stat-strip">
        <div className="stat-card"><strong>{regions.all ?? 0}</strong><span>词库总量</span><small>弱相关 {relevances.weak ?? 0} · 未判定 {(relevances.all ?? 0) - (relevances.strong ?? 0) - (relevances.weak ?? 0) - (relevances.off ?? 0)}</small></div>
        <div className="stat-card accent"><strong>{relevances.strong ?? 0}</strong><span><Gem size={13} /> 强相关</span><small>只有这些会进挖掘种子</small></div>
        <div className="stat-card"><strong>{zoneTotals.rising}</strong><span><TrendingUp size={13} /> 突增</span><small>观测 ≥3 且 7 天内首见</small></div>
        <div className="stat-card"><strong>{zoneTotals.sustained}</strong><span><Flame size={13} /> 持续</span><small>连续 3 天在榜</small></div>
      </div>

      {/* ② 今日精选 */}
      <p className="dash-label"><Star size={14} /> 今日精选<span className="dash-label-sub">强相关优先 · 点词名去 Google 验证</span>
        <button className="radar-refresh" disabled={radarBusy} onClick={() => void triggerExtract()}>{radarBusy ? "刷新中…" : "刷新雷达"}</button>
      </p>
      {heroes.length === 0 ? (
        <section className="surface"><p className="muted" style={{ padding: "14px 18px" }}>还没有强相关词——AI 判定是种子闸的前提，点「刷新雷达」跑一轮提取判定；已有的弱相关词在下方分区里。</p></section>
      ) : (
        <div className="hero-grid">
          {heroes.map((t) => (
            <article className="hero-card" key={String(t.id)}>
              <button className="hero-term" onClick={() => searchTerm(t.term)} title="点击去 Google 搜索验证">{t.term}</button>
              <div className="hero-badges">
                <RegionBadge region={t.region} />
                {isLongTail(t.term) && <span className="pill"><Crosshair size={11} /> 长尾</span>}
                <VerdictBadge verdict={t.verdict} reason={t.verdictReason} />
                <ObsBadge obsRatio={t.obsRatio} />
                <span>×{t.observations}</span>
              </div>
              <div className="hero-foot">
                <small className="muted">{t.intent ? DIG_INTENTS.find(([k]) => k === t.intent)?.[1] || t.intent : ""}{t.firstSeenAt ? ` · 首见 ${new Date(t.firstSeenAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}` : ""}</small>
                <div className="term-actions">
                  <button onClick={() => searchTerm(t.term)}>搜索 ↗</button>
                  <button onClick={() => copyTerm(t.term)}>复制</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* ③ 分区扫描（fullMode 时切换为全量词表，不再叠加显示） */}
      {!fullMode && <>
      <p className="dash-label"><ClipboardList size={14} /> 分区扫描</p>
      <section className="surface" style={{ padding: "16px 18px" }}>
        <div className="radar-toolbar" style={{ marginTop: 0 }}>
          <nav className="discovery-modes" aria-label="雷达分区">
            <button className={radarTab === "new" ? "active" : ""} aria-current={radarTab === "new" ? "page" : undefined} onClick={() => { setRadarTab("new"); setFullMode(false); }}><Sparkles size={13} /> 新词 {zoneTotals.new}</button>
            <button className={radarTab === "rising" ? "active" : ""} aria-current={radarTab === "rising" ? "page" : undefined} onClick={() => { setRadarTab("rising"); setFullMode(false); }}><TrendingUp size={13} /> 突增 {zoneTotals.rising}</button>
            <button className={radarTab === "sustained" ? "active" : ""} aria-current={radarTab === "sustained" ? "page" : undefined} onClick={() => { setRadarTab("sustained"); setFullMode(false); }}><Flame size={13} /> 持续 {zoneTotals.sustained}</button>
          </nav>
          <nav className="discovery-modes" aria-label="词质筛选">
            <button className={quality === "all" ? "active" : ""} aria-current={quality === "all" ? "page" : undefined} onClick={() => setQuality("all")}>全部</button>
            <button className={quality === "strong" ? "active" : ""} aria-current={quality === "strong" ? "page" : undefined} onClick={() => setQuality("strong")}>强相关</button>
          </nav>
        </div>
        {ws.seenLoading && !zoneLists[radarTab].length ? <Skeleton rows={3} label="热词雷达加载中" /> : zoneLists[radarTab].length === 0 ? (
          <p className="muted" style={{ padding: "10px 2px" }}>
            {quality === "strong"
              ? `这一档暂无强相关词（共 ${zoneTotals[radarTab]} 条在榜，切回「全部」看原始信号）。`
              : radarTab === "new" ? "暂无新词。" : radarTab === "rising" ? "暂无突增词。" : "暂无持续词。"}
          </p>
        ) : (
          <div className="term-list" role="list" aria-label={`${{ new: "新词", rising: "突增", sustained: "持续" }[radarTab]}区（前 20 条）`}>
            {zoneLists[radarTab].map((t) => (
              <div className="term-row" key={String(t.id)}>
                <div className="term-main">
                  <button className="term-name" onClick={() => searchTerm(t.term)} title="点击去 Google 搜索验证">{t.term}</button>
                  <span className="term-meta">
                    <RelevanceBadge relevance={t.relevance} />
                    <RegionBadge region={t.region} />
                    {isLongTail(t.term) && <span className="pill"><Crosshair size={11} /> 长尾</span>}
                    <VerdictBadge verdict={t.verdict} reason={t.verdictReason} />
                    <ObsBadge obsRatio={t.obsRatio} />
                    <span>×{t.observations}</span>
                    {t.seed && <span title="首见血缘">{t.seed}</span>}
                  </span>
                </div>
                <div className="term-actions">
                  <button aria-label={`搜索：${t.term}`} onClick={() => searchTerm(t.term)}>搜索 ↗</button>
                  <button aria-label={`复制：${t.term}`} onClick={() => copyTerm(t.term)}>复制</button>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          新词是每日提取的原始信号，观测 1 次不代表真需求——连续出现才晋级突增。
        </p>
        <button className="text-button" onClick={() => {
          setFullMode(true);
          ws.setSeenStatus(radarTab === "new" ? "new" : radarTab === "sustained" ? "sustained" : "");
          ws.setSeenIntent("");
          ws.setSeenPage(1);
        }}>查看全部 {zoneTotals[radarTab] || 0} 条（区域/意图/搜索/分页）→</button>
      </section>
      </>}

      {/* ④ 全量词表 */}
      {fullMode && (
        <>
          <p className="dash-label" style={{ marginTop: 0 }}><ClipboardList size={14} /> 全量词表
            <span className="dash-label-sub">
              <button className={(ws.seenRegion || "") === "global" ? "active" : ""} onClick={() => { ws.setSeenRegion("global"); ws.setSeenPage(1); }}>🌐 海外 {(ws.seenList?.regions?.global) ?? 0}</button>
              <button className={ws.seenRegion === "cn" ? "active" : ""} onClick={() => { ws.setSeenRegion("cn"); ws.setSeenPage(1); }}>中文 {(ws.seenList?.regions?.cn) ?? 0}</button>
              <button className={ws.seenRegion === "" ? "active" : ""} onClick={() => { ws.setSeenRegion(""); ws.setSeenPage(1); }}>全部 {(ws.seenList?.regions?.all) ?? 0}</button>
              {DIG_INTENTS.map(([key, label]) => (
                <button key={key} className={ws.seenIntent === key ? "active" : ""} onClick={() => { ws.setSeenIntent(key); ws.setSeenPage(1); }}>{label} {intentCounts[key] ?? 0}</button>
              ))}
              <button className="text-button" onClick={() => setFullMode(false)}>← 返回信号台</button>
            </span>
          </p>
          <section className="surface" style={{ padding: "16px 18px" }}>
            {ws.seenLoading && !ws.seenList.items.length ? <Skeleton rows={3} label="词表加载中" /> : ws.seenList.items.length === 0 ? (
              <p className="muted">没有匹配的热词。</p>
            ) : (
              <>
                <div className="discovery-list" role="list" aria-label="热词全量词表">
                  {ws.seenList.items.map((t: any) => (
                    <article className="discovery-row" key={String(t.id)} role="listitem" style={{ padding: "14px 4px" }}>
                      <div className="row-content">
                        <div className="row-meta">
                          <span className="pill">{t.status}</span>
                          <RelevanceBadge relevance={t.relevance} />
                          <RegionBadge region={t.region} />
                          <VerdictBadge verdict={t.verdict} reason={t.verdictReason} />
                          <ObsBadge obsRatio={t.obsRatio} />
                          {t.intent && <span>{DIG_INTENTS.find(([k]) => k === t.intent)?.[1] || t.intent}</span>}
                          {isLongTail(t.term) && <span className="pill"><Crosshair size={11} /> 长尾</span>}
                          {t.seed && <span>血缘：{t.seed}</span>}
                          <span>观测 {t.observations} 次</span>
                        </div>
                        <button className="article-title" style={{ fontSize: 16, padding: "3px 0 0" }} onClick={() => searchTerm(t.term)} title="点击去 Google 搜索验证">{t.term}</button>
                      </div>
                      <div className="row-side">
                        <div className="term-actions">
                          <button onClick={() => searchTerm(t.term)}>搜索 ↗</button>
                          <button onClick={() => copyTerm(t.term)}>复制</button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
                <Pagination info={{ page: ws.seenPage, pages: Math.max(1, Math.ceil(ws.seenList.total / 50)), pageSize: 50, total: ws.seenList.total }} onChange={ws.setSeenPage} disabled={ws.seenLoading} />
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
