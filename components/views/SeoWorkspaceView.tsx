"use client";
// 热词趋势 · 信号台（完全重设计批）：四层信息架构——
// ① 统计条（词库/强相关/突增/持续 四个数字卡，一眼掌握池子健康度）
// ② 今日精选（强相关 Top6 hero 卡，页面有自己的「脸」）
// ③ 分区扫描（新词/突增/持续 tab + 词质筛选 + 紧凑词行）
// ④ 全量词表（区域/意图/搜索/分页，查看全部展开）
// 旧 seo-terms 板块已在前轮移除；本页唯一数据源 = seen-terms。
import { useMemo, useEffect, useState } from "react";
import type { Workspace, Snapshot } from "../useWorkspaceData";
import { Drawer, Empty, api, Skeleton } from "../ui";
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
  // 词详情抽屉（第七轮批3 W7-10②）：点击词名打开，SEO 指标区块承载哥飞数据
  const [drawerTerm, setDrawerTerm] = useState<any | null>(null);

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
  // region 筛选（58 项清单纯量批修正）：分区数据为服务端三区各 20 条，
  // 区域筛选在客户端过滤生效（此前按钮只摆不接）。
  const scanRegion = ws.seenRegion;
  const zoneLists: Record<string, any[]> = {
    new: sortZone(zoneSources.new, quality).filter((t) => !scanRegion || (t.region ?? "global") === scanRegion),
    rising: sortZone(zoneSources.rising, quality).filter((t) => !scanRegion || (t.region ?? "global") === scanRegion),
    sustained: sortZone(zoneSources.sustained, quality).filter((t) => !scanRegion || (t.region ?? "global") === scanRegion),
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
      <Empty icon={<Sparkles size={22} />} title="词库还是空的。">
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

      {/* ③ 词表：视图切换一级化（顶部互切，不再沉底） */}
      <div className="radar-toolbar" style={{ marginTop: 0 }}>
        <nav className="discovery-modes" aria-label="词表视图">
          <button className={!fullMode ? "active" : ""} aria-current={!fullMode ? "page" : undefined} onClick={() => setFullMode(false)}><ClipboardList size={13} /> 分区扫描</button>
          <button className={fullMode ? "active" : ""} aria-current={fullMode ? "page" : undefined} onClick={() => setFullMode(true)}><Globe size={13} /> 全量词表</button>
        </nav>
      </div>
      {!fullMode && <>
      <section className="surface" style={{ padding: "16px 18px" }}>
        <div className="radar-toolbar" style={{ marginTop: 0 }}>
          <nav className="discovery-modes" aria-label="雷达分区">
            <button className={radarTab === "new" ? "active" : ""} aria-current={radarTab === "new" ? "page" : undefined} onClick={() => setRadarTab("new")}><Sparkles size={13} /> 新词 {zoneTotals.new}</button>
            <button className={radarTab === "rising" ? "active" : ""} aria-current={radarTab === "rising" ? "page" : undefined} onClick={() => setRadarTab("rising")}><TrendingUp size={13} /> 突增 {zoneTotals.rising}</button>
            <button className={radarTab === "sustained" ? "active" : ""} aria-current={radarTab === "sustained" ? "page" : undefined} onClick={() => setRadarTab("sustained")}><Flame size={13} /> 持续 {zoneTotals.sustained}</button>
          </nav>
          <nav className="discovery-modes" aria-label="词质筛选">
            <button className={quality === "all" ? "active" : ""} aria-current={quality === "all" ? "page" : undefined} onClick={() => setQuality("all")}>全部</button>
            <button className={quality === "strong" ? "active" : ""} aria-current={quality === "strong" ? "page" : undefined} onClick={() => setQuality("strong")}>强相关</button>
          </nav>
          <nav className="discovery-modes" aria-label="分区区域筛选">
            <button className={(ws.seenRegion || "") === "global" ? "active" : ""} onClick={() => { ws.setSeenRegion("global"); ws.setSeenPage(1); }}>海外</button>
            <button className={ws.seenRegion === "cn" ? "active" : ""} onClick={() => { ws.setSeenRegion("cn"); ws.setSeenPage(1); }}>中文</button>
            <button className={ws.seenRegion === "" ? "active" : ""} onClick={() => { ws.setSeenRegion(""); ws.setSeenPage(1); }}>全部</button>
          </nav>
        </div>
        {ws.seenLoading && !zoneLists[radarTab].length ? <Skeleton rows={3} label="热词雷达加载中" /> : zoneLists[radarTab].length === 0 ? (
          <p className="muted" style={{ padding: "10px 2px" }}>
            {quality === "strong"
              ? `这一档暂无强相关词（本区共 ${zoneTotals[radarTab]} 条，切回「全部」看原始信号）。`
              : scanRegion
                ? `${scanRegion === "cn" ? "中文" : "海外"}区暂无${{ new: "新词", rising: "突增词", sustained: "持续词" }[radarTab]}，切回「全部区域」再看。`
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
                    <span title="累计观测次数">×{t.observations}</span>
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
        }}>查看全部 {zoneTotals[radarTab] || 0} 条 →</button>
      </section>
      </>}

      {/* ④ 全量词表 */}
      {fullMode && (
        <>
          <p className="dash-label" style={{ marginTop: 0 }}><ClipboardList size={14} /> 全量词表
            <span className="dash-label-sub">
              区域与意图筛选：<button className={(ws.seenRegion || "") === "global" ? "active" : ""} onClick={() => { ws.setSeenRegion("global"); ws.setSeenPage(1); }}>🌐 海外 {(ws.seenList?.regions?.global) ?? 0}</button>
              <button className={ws.seenRegion === "cn" ? "active" : ""} onClick={() => { ws.setSeenRegion("cn"); ws.setSeenPage(1); }}>中文 {(ws.seenList?.regions?.cn) ?? 0}</button>
              <button className={ws.seenRegion === "" ? "active" : ""} onClick={() => { ws.setSeenRegion(""); ws.setSeenPage(1); }}>全部 {(ws.seenList?.regions?.all) ?? 0}</button>
              <button className={ws.seenOrigin === "gephei" ? "active" : ""} onClick={() => { ws.setSeenOrigin(ws.seenOrigin === "gephei" ? "" : "gephei"); ws.setSeenPage(1); }}>⬆ 哥飞注入 {((ws.seenList?.originCounts?.["gephei-trends"]) ?? 0) + ((ws.seenList?.originCounts?.["gephei-ideas"]) ?? 0) + ((ws.seenList?.originCounts?.["gephei-newwords"]) ?? 0)}</button>
              <button className={ws.seenOrigin === "normal" ? "active" : ""} onClick={() => { ws.setSeenOrigin(ws.seenOrigin === "normal" ? "" : "normal"); ws.setSeenPage(1); }}>常规采集 {(ws.seenList?.originCounts?.normal) ?? 0}</button>
              {DIG_INTENTS.map(([key, label]) => (
                <button key={key} className={ws.seenIntent === key ? "active" : ""} onClick={() => { ws.setSeenIntent(key); ws.setSeenPage(1); }}>{label} {intentCounts[key] ?? 0}</button>
              ))}
              <button className="text-button" onClick={() => setFullMode(false)}>← 返回分区扫描</button>
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
                          {t.siteCandidateEligible && <span className="pill" style={{ color: "#1a7f4b", borderColor: "#1a7f4b" }} title="站群候选池达标：观测通道（obs≥3+来源≥2）或竞争通道（strong+SERP 竞争≤siteGate 上限）或意图通道（strong+tool 工具语义）——达标词由判定 tick 按 siteGate 自动标注，外部 Agent 复核共用同一规则">站群候选</span>}
                          {t.serpDerived && (
                            <span title={`SERP 派生信号（${t.serpDerived.source === "full" ? "全量结果" : "仅静态平台 host"}，共 ${t.serpDerived.total} 条）：精确匹配域名 ${t.serpDerived.exact} 个 · 首页占比 ${t.serpDerived.homeShare === null ? "无 URL 数据" : t.serpDerived.homeShare + "%"} · 论坛/视频站 ${t.serpDerived.forumShare}%`}>
                              🔍 精确 {t.serpDerived.exact} · 首页 {t.serpDerived.homeShare === null ? "—" : `${t.serpDerived.homeShare}%`} · 论坛/视频 {t.serpDerived.forumShare}%
                            </span>
                          )}
                        </div>
                        <button className="article-title" style={{ fontSize: 16, padding: "3px 0 0" }} onClick={() => setDrawerTerm(t)} title="点击打开词详情（SEO 指标/判据）">{t.term}</button>
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
      {drawerTerm && <SeenTermDrawer ws={ws} term={drawerTerm} onClose={() => setDrawerTerm(null)} onSearch={() => searchTerm(drawerTerm.term)} />}
      <details className="fold-card" style={{ marginTop: 12 }}>
        <summary><h2 style={{ display: "inline", margin: 0 }}>站群门槛</h2> <small className="muted">siteCandidate 判定的五个参数（改完全局生效，内置 sweep 与 Agent 复核同源）</small></summary>
        <SiteGateForm />
      </details>

    </>
  );
}

const DEMAND_LABELS: Record<string, string> = { tool: "工具/产品需求", info: "资讯/教程", nav: "导航/品牌" };
const GEPHEI_INTENT_LABELS: Record<string, string> = { informational: "informational（教程）", commercial: "commercial（商业）", transactional: "transactional（交易）", navigational: "navigational（导航）" };

// 词详情抽屉（第七轮批3 W7-10②）：SEO 指标核心承载块——月搜/KD/CPC/意图/时间戳，
// 哥飞权威源「●」、自采「○」；无 token 时区块保留并显示「配置后解锁」+settings 深链。
function SeenTermDrawer({ ws, term, onClose, onSearch }: { ws: Workspace; term: any; onClose: () => void; onSearch: () => void }) {
  const hasMetrics = typeof term.monthlySearch === "number" || typeof term.kd === "number" || typeof term.cpc === "number";
  const metricsFresh = typeof term.gepheiFetchedAt === "string" && Date.now() - Date.parse(term.gepheiFetchedAt) < 90 * 86400000;
  const seoCfg = ws.data?.config?.seoDataSource;
  const seoEnabled = !!seoCfg?.enabled && !!seoCfg?.hasToken;
  const stale = term.serpStale === true;
  return (
    <Drawer
      title={term.term}
      subtitle={[term.status, `观测 ${term.observations} 次`, term.seed ? `血缘 ${term.seed}` : "", (term.sources || []).some((x: string) => String(x).startsWith("gephei-")) ? "⬆ 哥飞注入" : "", stale ? "⏳ 数据待更新（超 60 天，回探针队列重测中）" : ""].filter(Boolean).join(" · ")}
      onClose={onClose}
    >
        <div className="row-meta" style={{ alignItems: "center" }}>
          <RelevanceBadge relevance={term.relevance} />
          <RegionBadge region={term.region} />
          <VerdictBadge verdict={term.verdict} reason={term.verdictReason} />
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
          状态 {term.status} · 观测 {term.observations} 次{term.seed ? ` · 血缘 ${term.seed}` : ""}
          {(term.sources || []).some((x: string) => String(x).startsWith("gephei-")) && " · ⬆ 哥飞注入"}
          {term.manualAt && <span style={{ color: "#8a6d1a" }}> · ✋ 手动回传（{new Date(term.manualAt).toLocaleDateString("zh-CN")}，权重最高）</span>}
          {stale && " · ⏳ 数据待更新（超 60 天，回探针队列重测中）"}
        </p>

        {/* SEO 指标区块（哥飞权威 ● / 自采 ○） */}
        <section className="form-section" style={{ marginTop: 12 }}>
          <p className="dash-label" style={{ marginTop: 0 }}>SEO 指标<span className="dash-label-sub">● 哥飞权威源（90 天新鲜度） · ○ 自采探针（60 天保质期）</span></p>
          {hasMetrics ? (
            <div className="stat-strip" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
              <div className="stat-card"><strong>{metricsFresh ? "●" : "○"} {(term.monthlySearch ?? 0).toLocaleString()}</strong><span>月搜索量</span><small>{metricsFresh ? "哥飞权威" : "过期数据"}</small></div>
              <div className="stat-card"><strong>{metricsFresh ? "●" : "○"} {term.kd ?? "—"}</strong><span>KD 关键词难度</span><small>≤29 视为低竞争</small></div>
              <div className="stat-card"><strong>{metricsFresh ? "●" : "○"} ${term.cpc ?? "—"}</strong><span>CPC 单次点击价值</span><small>≥$0.1 有商业价值</small></div>
              <div className="stat-card"><strong>{metricsFresh ? "●" : "○"} {term.demandIntent ? (DEMAND_LABELS[term.demandIntent] || term.demandIntent) : "—"}</strong><span>需求语义（内置三分类）</span><small>{term.intent ? `哥飞对照：${GEPHEI_INTENT_LABELS[term.intent] || term.intent}` : "哥飞意图待补"}</small></div>
            </div>
          ) : seoEnabled ? (
            <p className="muted" style={{ margin: 0 }}>已配置数据源，该词尚未进入日更补查窗（按观测数排序每日 ≤200 词），稍后自动出现。</p>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              配置 SEO 数据源后解锁：月搜/KD/CPC/意图四指标与综合价值分。
              <button className="text-button" onClick={() => ws.navigate("settings")}>前往设置 →</button>
            </p>
          )}
          {typeof term.gepheiFetchedAt === "string" && (
            <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
              数据时间戳 {new Date(term.gepheiFetchedAt).toLocaleString("zh-CN")} · {metricsFresh ? "90 天新鲜度内" : "已过期（待日更重查）"}
            </p>
          )}
        </section>

        {/* 自采 SERP 观测（○） */}
        <section className="form-section">
          <p className="dash-label" style={{ marginTop: 0 }}>SERP 竞争观测<span className="dash-label-sub">○ 自采探针 · 数据待更新时判定层自动重测</span></p>
          {typeof term.serpDedicated === "number" ? (
            <p style={{ margin: 0, fontSize: 13 }}>
              竞争站 {term.serpDedicated}（独立 host {term.serpInternal ?? "—"}）{typeof term.serpTop10Home === "number" && ` · 前 10 首页 ${term.serpTop10Home}`}· {term.serpTop3Tier ? `前 3 名量级 ${term.serpTop3Tier}` : "前 3 名量级待哥飞权威补位"}
              {term.serpCheckedAt && ` · 观测于 ${new Date(term.serpCheckedAt).toLocaleDateString("zh-CN")}`}
            </p>
          ) : (
            <p className="muted" style={{ margin: 0 }}>尚未查 SERP 竞争度（strong 词按观测排序进入判定队列）。</p>
          )}
          {term.serpDerived && (
            <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>派生：精确匹配域名 {term.serpDerived.exact} · 首页占比 {term.serpDerived.homeShare === null ? "—" : term.serpDerived.homeShare + "%"} · 论坛/视频站 {term.serpDerived.forumShare}%</p>
          )}
        </section>

        {/* 判定判据（W7-1 可解释性） */}
        {term.rationale && (
          <section className="form-section">
            <p className="dash-label" style={{ marginTop: 0 }}>判定判据<span className="dash-label-sub">LLM 判定依据，复核与拍板有据可依</span></p>
            <p style={{ margin: 0, fontSize: 13 }}>{term.rationale}</p>
          </section>
        )}
        <div className="term-actions" style={{ marginTop: 10 }}>
          <button onClick={onSearch}>Google 搜索验证 ↗</button>
          <button onClick={() => { void navigator.clipboard.writeText(term.term); }}>复制</button>
        </div>
    </Drawer>
  );
}

function SiteGateForm() {
  const [gate, setGate] = useState<any>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<any>("siteGate").then(setGate).catch((e: Error) => setNotice(e.message)); }, []);
  if (!gate) return <p className="muted">{notice || "读取门槛配置…"}</p>;
  const fields: [string, string, string][] = [
    ["requireStrong", "必须 strong 判定", "checkbox"],
    ["serpDedicatedMax", "SERP 竞争站上限", "number"],
    ["monthlySearchMin", "月搜下限", "number"],
    ["kdMax", "KD 上限", "number"],
    ["cpcMin", "CPC 下限（美元）", "number"],
  ];
  return (
    <div>
      {notice && <p role="status" className="notice">{notice}</p>}
      <div className="toolbar" style={{ flexWrap: "wrap", gap: 10 }}>
        {fields.map(([key, label, type]) => (
          <label key={key} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 13 }}>
            {type === "checkbox" ? (
              <input type="checkbox" checked={!!gate[key]} onChange={(e) => setGate({ ...gate, [key]: e.target.checked })} />
            ) : (
              <input type="number" value={gate[key]} style={{ width: 80 }} onChange={(e) => { const v = e.target.value; if (v === "") return; const n = Number(v); if (!Number.isFinite(n) || n < 0) return; setGate({ ...gate, [key]: n }); }} />
            )}
            {label}
          </label>
        ))}
        <button className="primary" disabled={busy} onClick={() => void (async () => {
          setBusy(true);
          try { const r = await api<any>("siteGate", gate); setNotice("已保存，判定 sweep 与 Agent 复核即刻按新门槛执行。"); setGate(r); }
          catch (e) { setNotice("保存失败：" + (e as Error).message); } finally { setBusy(false); }
        })()}>保存门槛</button>
      </div>
    </div>
  );
}
