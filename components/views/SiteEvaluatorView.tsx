"use client";
// 应用机会 · 站群评估器（信息架构 v2-5）：
// 数据源 = seo-terms 中 siteCandidate:true 的词；域名/站型/需求大纲均来自外部 Agent 数据。
// [讨论][推进=立项建站（site-projects, pending）]；忽略为会话级隐藏。
// 站点发现 tab（海外定位批 6）：site-discoveries 独立站卡片（host/命中词/首次发现/它做的是什么）。
// 机会引擎 tab（第五轮 §1）：四信号源统一机会卡（opportunities），auto/agent 来源标注 + 生成按钮。
// 新站发现 tab（第五轮 §2）：site-launches Show HN/PH 新站（六类判定/中文转译/核心词/撞词标记）。
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Ban, CheckCircle2, Globe, Sparkles, Zap } from "lucide-react";
import { Select } from "../Select";
import type { Workspace, Snapshot } from "../useWorkspaceData";
import { Empty, api, date, Skeleton } from "../ui";

const SIGNAL_LABELS: Record<string, string> = { complaint: "用户抱怨", newtech: "新技术", news: "新资讯", trend: "热词趋势" };
const KIND_LABELS: Record<string, string> = { app: "应用", site: "站群/内容页" };
const FORM_LABELS: Record<string, string> = { web: "Web 应用", app: "App 应用", miniprogram: "小程序", tool: "工具站" };
const VERDICT_STYLE: Record<string, string> = { 推荐: "#1a7f4b", 可以试试: "#8a6d1a", 不值得做: "#8a3a3a", 待验证: "#5a6b7a" };
const MOTIVE_LABELS: Record<string, string> = { keyword: "冲着关键词", pain: "解决自己痛点", others: "满足别人需求", hobby: "兴趣爱好", business: "商业机会", unclear: "没说清" };
const MOTIVE_SOURCE_LABELS: Record<string, string> = { quote: "作者原话", guess: "推测" };

function OpportunityBadge({ children, color }: { children: ReactNode; color?: string }) {
  return <span className="pill" style={color ? { color, borderColor: color } : undefined}>{children}</span>;
}

function OpportunitiesTab({ ws, opportunities }: { ws: Workspace; opportunities: any[] }) {
  const { busy, setNotice } = ws;
  const [signal, setSignal] = useState("");
  const [source, setSource] = useState("");
  const [kind, setKind] = useState("");
  const [form, setForm] = useState("");
  const [generating, setGenerating] = useState(false);
  // kind 筛选（第六轮批 B §2.5①）+ form 形态筛选（第七轮批2 W7-5）
  const filtered = opportunities.filter((o) =>
    (!kind || o.kind === kind) && (!form || o.form === form) && (!signal || (o.signals || []).includes(signal)) && (!source || o.source === source));
  const counts = { app: opportunities.filter((o) => o.kind === "app").length, site: opportunities.filter((o) => o.kind === "site").length };
  const auto = opportunities.filter((o) => o.source === "auto").length;

  async function generate() {
    setGenerating(true);
    try {
      const res = await api<{ ok: boolean; created: number; merged: number; note: string }>("opportunities/generate", {});
      setNotice(res.note);
      await ws.refresh();
    } catch (e) {
      setNotice("生成失败：" + (e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <>
      <div className="filter-row">
        <nav className="discovery-modes" aria-label="机会类型筛选">
          <button className={kind === "" ? "active" : ""} onClick={() => setKind("")}>全部 {opportunities.length}</button>
          <button className={kind === "app" ? "active" : ""} onClick={() => setKind("app")}>应用 {opportunities.filter((o) => o.kind === "app").length}</button>
          <button className={kind === "site" ? "active" : ""} onClick={() => setKind("site")}>站群 {opportunities.filter((o) => o.kind === "site").length}</button>
        </nav>
        <nav className="discovery-modes" aria-label="机会形态筛选">
          <button className={form === "" ? "active" : ""} onClick={() => setForm("")}>全部形态</button>
          {Object.entries(FORM_LABELS).map(([key, label]) => (
            <button key={key} className={form === key ? "active" : ""} onClick={() => setForm(key)}>{label} {opportunities.filter((o) => o.form === key).length}</button>
          ))}
        </nav>
      </div>
      <div className="filter-row">
        <nav className="discovery-modes" aria-label="机会信号筛选">
          <button className={signal === "" ? "active" : ""} onClick={() => setSignal("")}>全部 {opportunities.length}</button>
          {Object.entries(SIGNAL_LABELS).map(([key, label]) => (
            <button key={key} className={signal === key ? "active" : ""} onClick={() => setSignal(key)}>{label} {opportunities.filter((o) => (o.signals || []).includes(key)).length}</button>
          ))}
        </nav>
        <Select aria-label="按来源筛选" placeholder="全部来源" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">全部来源</option>
          <option value="agent">agent（外部 Agent 生成）</option>
          <option value="auto">auto（内置 tick 生成）</option>
        </Select>
        <button className="button-secondary" disabled={busy || generating} onClick={() => void generate()}>
          <Sparkles size={13} /> {generating ? "生成中…" : "按四信号源生成"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        应用 {counts.app} · 站群/内容页 {counts.site} · auto 来源 {auto} 张——四信号源：用户抱怨 / 新技术 / 新资讯 / 热词趋势；去重规则：同词或同证据集只出一张卡。
      </p>
      {filtered.length === 0 ? (
        <Empty title="还没有机会卡。">
          点「按四信号源生成」跑一轮规则扫描（small-products 候选 / news 产物配套缺口推演 / 官方新品 / verdict=推荐 蓝海词）。
          consumerMode=builtin 时 worker 每天也会自动生成一次。
        </Empty>
      ) : (
        <div className="discovery-list">
          {filtered.map((o) => (
            <article className="discovery-row" key={o.id}>
              <div className="row-content">
                <div className="row-meta">
                  <OpportunityBadge color={VERDICT_STYLE[o.verdict]}>{o.verdict}</OpportunityBadge>
                  <span className="pill">{KIND_LABELS[o.kind] || o.kind}</span>
                  {o.form && <span className="pill">{FORM_LABELS[o.form] || o.form}</span>}
                  {(o.signals || []).map((s: string) => <span key={s} className="pill">{SIGNAL_LABELS[s] || s}</span>)}
                  <span className="pill"><Zap size={11} /> {o.source}</span>
                  {o.valueUnverified && <span className="pill" title="未配 SEO 数据源或三指标缺失/过期——配置后自动升级为全门槛判定+价值分">价值未验证</span>}
                  {o.platform && <span>{o.platform}</span>}
                  {typeof o.watchRefs === "number" && o.watchRefs > 0 && <span>引用 {o.watchRefs} 次</span>}
                  <span>{date(o.createdAt)}</span>
                </div>
                <button className="article-title" style={{ fontSize: 16, padding: "4px 0 0" }} onClick={() => { void navigator.clipboard.writeText(o.title); setNotice("已复制：" + o.title); }}>{o.title}</button>
                <p style={{ margin: "4px 0 0" }}>{o.oneLiner}</p>
                {(o.seoMetrics || o.competitors?.length || o.domainSuggestions?.length) ? (
                  <div style={{ margin: "6px 0 0", fontSize: 12 }}>
                    {o.seoMetrics && (
                      <p style={{ margin: "0 0 4px" }} title="哥飞三指标（90 天新鲜度）与综合价值分 = 月搜×CPC÷KD">
                        💰 价值面板：月搜 <strong>{o.seoMetrics.monthlySearch.toLocaleString()}</strong> · KD <strong>{o.seoMetrics.kd}</strong> · CPC <strong>${o.seoMetrics.cpc}</strong> · 综合价值分 <strong style={{ color: "#1a7f4b" }}>{o.seoMetrics.valueScore}</strong>
                      </p>
                    )}
                    {o.seoMetrics && <p style={{ margin: "0 0 4px" }}>估值参考：待哥飞 website_worth 联调补全（竞品估值区间）。</p>}
                    {o.domainSuggestions?.length ? (
                      <p style={{ margin: "0 0 4px" }} title="词根+常见后缀的可注册性查询结果（哥飞 domain_availability）">
                        🌐 域名清单：{o.domainSuggestions.map((d: string) => <button key={d} className="text-button" style={{ padding: "0 4px" }} onClick={() => window.open(`https://registrar.domain.com/search?q=${encodeURIComponent(d)}`, "_blank")}>{d} ↗</button>)}
                      </p>
                    ) : (
                      o.seoMetrics && <p className="muted" style={{ margin: "0 0 4px" }}>🌐 域名清单：配置 SEO 数据源后由日更自动补全（可注册域名 up to 5）。</p>
                    )}
                    {o.valueUnverified && (
                      <p className="muted" style={{ margin: "0 0 4px" }}>
                        ⏳ 待查指标（点开即达哥飞站内，词已预填；或站点发现页「手动回传」粘贴结果）：
                        {["kd", "ideas", "serp"].map((tool) => (
                          <a key={tool} className="text-button" style={{ padding: "0 4px" }} target="_blank" rel="noopener noreferrer" href={`https://seo.web.cafe/${tool}/?kw=${encodeURIComponent(o.term || "")}`}>{tool === "kd" ? "难度" : tool === "ideas" ? "搜索量/拓词" : "SERP"} ↗</a>
                        ))}
                      </p>
                    )}
                    {o.competitors?.length ? (
                      <details className="fold-card">
                        <summary>竞品档案：SERP 前 {o.competitors.length} 域名（类型/量级档）</summary>
                        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                          {o.competitors.map((c: any, i: number) => (
                            <li key={c.host + i}>
                              <a href={`https://${c.host}`} target="_blank" rel="noopener noreferrer">{c.host} ↗</a>
                              {" "}{c.platform || "—"} · 量级 {c.tier || "—"}{typeof c.dr === "number" ? ` · DR ${c.dr}` : ""}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                ) : null}
                <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
                  初判理由：{o.verdictReason}
                  {o.evidenceIds?.length ? ` · 证据 ${o.evidenceIds.length} 条` : ""}
                </p>
                {o.verifyPlan?.length ? (
                  <details className="fold-card">
                    <summary>一周验证计划（{o.verifyPlan.length} 步）</summary>
                    <ol>{o.verifyPlan.map((v: string, i: number) => <li key={i}>{v}</li>)}</ol>
                    {o.url && <a href={o.url} target="_blank" rel="noopener noreferrer">原始线索 ↗</a>}
                  </details>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

// 新站发现 tab（第五轮 §2）：site-launches 站卡片（host/六类判定/中文转译/核心词/HN 数据/撞词标记）
function SiteLaunchesTab({ siteLaunches, onJumpSites }: { siteLaunches: any[]; onJumpSites: (host: string) => void }) {
  const [motive, setMotive] = useState("");
  const [clashOnly, setClashOnly] = useState(false);
  const filtered = siteLaunches.filter((l) =>
    (!motive || (l.motive || "unclear") === motive) && (!clashOnly || (l.clashTerms || []).length > 0));
  const judged = siteLaunches.filter((l) => l.titleZh).length;
  const clashCount = siteLaunches.filter((l) => (l.clashTerms || []).length > 0).length;

  return (
    <>
      <div className="filter-row">
        <nav className="discovery-modes" aria-label="新站动机筛选">
          <button className={motive === "" ? "active" : ""} onClick={() => setMotive("")}>全部 {siteLaunches.length}</button>
          {Object.entries(MOTIVE_LABELS).map(([key, label]) => (
            <button key={key} className={motive === key ? "active" : ""} onClick={() => setMotive(key)}>{label} {siteLaunches.filter((l) => (l.motive || "unclear") === key).length}</button>
          ))}
        </nav>
        <button className={clashOnly ? "active" : "button-secondary"} aria-pressed={clashOnly} onClick={() => setClashOnly(!clashOnly)}>⚠️ 只看撞词 {clashCount}</button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Show HN + Product Hunt 每日新发布站（host 去重；PH 按帖子标识入库，官网域名抽到就展示）；已判定 {judged}/{siteLaunches.length}。
        「与我们撞词」= 新站核心词命中我们热词库高分词（竞品早期形态信号）；「已在站点发现」= 与判定层独立站池交叉。
      </p>
      {filtered.length === 0 ? (
        <Empty title="还没有新站数据。">
          worker 每日抓取 Show HN（按时间 50 条）与 Product Hunt feed，LLM 批量做中文转译、核心词与六类动机判定（cheap 档）。
          首跑需要几分钟，明早再看就有完整首批。
        </Empty>
      ) : (
        <div className="discovery-list">
          {filtered.map((l) => (
            <article className="discovery-row" key={l.host}>
              <div className="row-content">
                <div className="row-meta">
                  {l.motive ? (
                    <OpportunityBadge color={l.motive === "business" || l.motive === "pain" ? "#1a7f4b" : undefined}>
                      {MOTIVE_LABELS[l.motive] || l.motive}（{MOTIVE_SOURCE_LABELS[l.motiveSource || "guess"]}）
                    </OpportunityBadge>
                  ) : <span className="pill">待判定</span>}
                  <span className="pill">{l.source === "showhn" ? "Show HN" : "Product Hunt"}</span>
                  {(l.clashTerms || []).length > 0 && <span className="pill" style={{ color: "#8a3a3a", borderColor: "#8a3a3a" }}>⚠️ 与我们撞词：{(l.clashTerms || []).join("、")}</span>}
                  {l.crossLinked && <button className="pill" style={{ cursor: "pointer" }} onClick={() => onJumpSites(l.host)}><CheckCircle2 size={11} /> 已在站点发现 ↗</button>}
                  <span>首见 {l.firstFoundAt ? date(l.firstFoundAt) : ""}</span>
                  {l.source === "showhn" && <span>⬆ {l.hnScore ?? 0} · 💬 {l.hnComments ?? 0}{l.hnBy ? ` · @${l.hnBy}` : ""}</span>}
                </div>
                <a className="article-title" style={{ fontSize: 17, padding: "4px 0 0" }} href={`https://${l.host}`} target="_blank" rel="noopener noreferrer">{l.source === "showhn" ? l.host : `${l.host}（PH 条目）`} ↗</a>
                {l.siteUrl && <p style={{ margin: "4px 0 0", fontSize: 13 }}><a href={l.siteUrl} target="_blank" rel="noopener noreferrer">官网：{l.siteUrl.replace(/^https?:\/\//, "")} ↗</a></p>}
                {l.titleZh && <p style={{ margin: "4px 0 0" }}>{l.titleZh}</p>}
                <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
                  原题：{l.title}
                  {l.motiveReason ? ` · 判定：${l.motiveReason}` : ""}
                </p>
                {(l.keywords || []).length > 0 && (
                  <div className="tags">{(l.keywords || []).map((k: string) => <span key={k}>核心词：{k}</span>)}</div>
                )}
              </div>
              <div className="row-side">
                <a className="button-secondary" href={l.sourceUrl} target="_blank" rel="noopener noreferrer">原帖 ↗</a>
                <button onClick={() => { void navigator.clipboard.writeText(l.host); }}>复制域名</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

export function SiteEvaluatorView({ ws, data }: { ws: Workspace; data: Snapshot }) {
  const { seoTerms, siteProjects, siteDiscoveries, opportunities, siteLaunches, busy, act, setNotice, navigate, setDiscussionContext } = ws;
  const [siteType, setSiteType] = useState("all");
  const [ignored, setIgnored] = useState<string[]>([]);
  // 单入口（第六轮批 B §2.5①）：站群候选独立 tab 撤销——应用形态机会统一在「机会引擎」（kind 筛选），站群卡不再孤岛
  const [tab, setTab] = useState<"sites" | "launches" | "opportunities">("opportunities");
  const [siteSort, setSiteSort] = useState("ref");
  const candidates = useMemo(
    () => (seoTerms || []).filter((t) => t.siteCandidate === true && !ignored.includes(t.term)),
    [seoTerms, ignored],
  );
  const filtered = siteType === "all" ? candidates : candidates.filter((t) => t.siteType === siteType);
  const projects = siteProjects || [];
  const discoveries = siteDiscoveries || [];
  // 客户端排序兜底：useWorkspaceData 拉的是默认（可参考度）序；切「首见」时本地按首见重排。
  // portfolio 站折叠到列表尾部（展开按钮查看）。
  const siteSorted = useMemo(() => {
    const list = [...discoveries];
    if (siteSort === "first") list.sort((a, b) => String(b.firstFoundAt).localeCompare(String(a.firstFoundAt)));
    return [...list.filter((d) => !d.portfolio), ...list.filter((d) => d.portfolio)];
  }, [discoveries, siteSort]);
  const opportunityList = opportunities || [];
  const launchList = siteLaunches || [];

  return (
    <>
      <nav className="discovery-modes" aria-label="应用机会板块">
        <button className={tab === "opportunities" ? "active" : ""} aria-current={tab === "opportunities" ? "page" : undefined} onClick={() => setTab("opportunities")}><Sparkles size={13} /> 机会引擎 {opportunityList.length}</button>
        <button className={tab === "sites" ? "active" : ""} aria-current={tab === "sites" ? "page" : undefined} onClick={() => setTab("sites")}><Globe size={13} /> 站点发现 {discoveries.length}</button>
        <button className={tab === "launches" ? "active" : ""} aria-current={tab === "launches" ? "page" : undefined} onClick={() => setTab("launches")}>🚀 新站发现 {launchList.length}</button>
      </nav>
      {tab === "launches" && <SiteLaunchesTab siteLaunches={launchList} onJumpSites={(host) => { setTab("sites"); setNotice("新站发现交叉站：" + host + "（已在站点发现列表中，可按排序查看）。"); }} />}
      {tab === "opportunities" && <OpportunitiesTab ws={ws} opportunities={opportunityList} />}
      {tab === "sites" && <ManualReturnPanel ws={ws} />}
      {tab === "sites" && <BenchmarkPanel ws={ws} />}
      {tab === "sites" && (
        discoveries.length === 0 ? (
          <Empty title="还没有站点发现。">
            判定层每天对 score TOP100 强相关海外词查 SERP 竞争度（vercel/github.io/pages.dev/netlify.app），
            查到的同题独立站会自动出现在这里。首跑约需 3-5 分钟。
          </Empty>
        ) : (
          <>
          <div className="filter-row">
            <Select aria-label="按排序" placeholder="可参考度排序" value={siteSort} onChange={(e) => setSiteSort(e.target.value)}>
              <option value="ref">可参考度（撞词 &gt; 非品牌 &gt; 有功能）</option>
              <option value="first">首见时间</option>
            </Select>
            <span className="muted">portfolio 个人作品集降权折叠 · 撞词 = 命中词命中我们热词库高分词</span>
          </div>
          <div className="discovery-list">
            {siteSorted.map((s) => (
              <article className="discovery-row" key={s.host}>
                <div className="row-content">
                  <div className="row-meta">
                    <span className="pill">{s.platform}</span>
                    {s.brand ? <span className="pill"><Ban size={11} /> 不建议做</span> : <span className="pill"><CheckCircle2 size={11} /> 候选</span>}
                    {(s.clashTerms || []).length > 0 && <span className="pill" style={{ color: "#1a7f4b", borderColor: "#1a7f4b" }}>与我们撞词：{(s.clashTerms || []).join("、")}</span>}
                    {s.brandReason && <span>原因：{s.brandReason}</span>}
                    <span>首次发现 {s.firstFoundAt ? date(s.firstFoundAt) : ""}</span>
                    <span>SERP 最低排名 {s.bestRank}</span>
                  </div>
                  <a className="article-title" style={{ fontSize: 17, padding: "4px 0 0" }} href={`https://${s.host}`} target="_blank" rel="noopener noreferrer">{s.host} ↗</a>
                  <div className="tags">
                    {(s.terms || []).slice(0, 6).map((t: string) => <span key={t}>命中词：{t}</span>)}
                  </div>
                </div>
                <div className="row-side">
                  {launchList.some((l) => l.host === s.host) && (
                    <button className="button-secondary" onClick={() => setTab("launches")}>🚀 新站发现也有 ↗</button>
                  )}
                  <button onClick={() => { void navigator.clipboard.writeText(s.host); setNotice("已复制域名：" + s.host); }}>复制域名</button>
                </div>
              </article>
            ))}
          </div>
          </>
        )
      )}
    </>
  );
}

// 标杆站监控（第七轮批3 W7-10 新增5）：哥飞挖需求四源之「高流量站页面分析」的常驻 UI。
// 标杆站列表（可增删）/最近分析时间/页面数；点开=关键词排名页面列表，需求词一键加入词库候选。
function BenchmarkPanel({ ws }: { ws: Workspace }) {
  const [sites, setSites] = useState<any[] | null>(null);
  const [openHost, setOpenHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [newHost, setNewHost] = useState("");
  const seoEnabled = !!ws.data?.config?.seoDataSource?.enabled && !!ws.data?.config?.seoDataSource?.hasToken;
  const load = () => void api<any>("benchmark-sites").then((r) => setSites(r.items || [])).catch(() => setSites([]));
  useEffect(() => { load(); }, []);
  async function act(fn: () => Promise<void>) { setBusy(true); try { await fn(); load(); await ws.refresh(); } catch (e) { ws.setNotice("操作失败：" + (e as Error).message); } finally { setBusy(false); } }
  return (
    <section className="surface" style={{ padding: "16px 18px", marginBottom: 14 }}>
      <p className="dash-label" style={{ marginTop: 0 }}>📊 标杆站监控<span className="dash-label-sub">哥飞挖需求法之「高流量站页面分析」——每月 1 日 site_keywords 自动采集（SEO 数据源开启时）</span></p>
      {!seoEnabled && <p className="muted" style={{ margin: "0 0 8px" }}>配置 SEO 数据源后解锁：每月自动分析标杆站的关键词排名页面，高流量页需求词一键加入词库候选。<button className="text-button" onClick={() => ws.navigate("settings")}>前往设置 →</button></p>}
      {sites === null ? <Skeleton rows={2} label="标杆站加载中" /> : (
        <>
          <div className="discovery-list">
            {sites.map((s) => (
              <article className="discovery-row" key={s.host} style={{ padding: "10px 4px" }}>
                <div className="row-content">
                  <div className="row-meta">
                    <strong>{s.name || s.host}</strong>
                    <span>最近分析 {s.lastAnalyzedAt ? date(s.lastAnalyzedAt) : "未分析"}</span>
                    <span>页面数据 {s.pageCount || 0} 条</span>
                    <span>高流量页 {s.trafficPages || 0}</span>
                  </div>
                </div>
                <div className="row-side">
                  <button className="button-secondary" onClick={() => { const h = openHost === s.host ? "" : s.host; setOpenHost(h); if (h) void api<any>(`benchmark-pages?host=${encodeURIComponent(h)}`).then((r) => { setSites((prev) => (prev || []).map((x) => x.host === h ? { ...x, samplePages: r.items || [] } : x)); }).catch(() => {}); }}>{openHost === s.host ? "收起" : "页面列表"}</button>
                  <button disabled={busy} onClick={() => void act(async () => { await api("benchmark-sites", { action: "remove", host: s.host }); })}>删除</button>
                </div>
              </article>
            ))}
            {openHost && (
              <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px" }}>
                {(sites.find((x) => x.host === openHost)?.samplePages || []).length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>暂无页面数据（SEO 数据源开启后每月 1 日自动采集）。</p>
                ) : sites.find((x) => x.host === openHost)?.samplePages.map((pg: any) => (
                  <div key={pg.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
                    <span style={{ flex: 1, fontSize: 13 }}>
                      {pg.url ? <a href={pg.url} target="_blank" rel="noopener noreferrer">{pg.keyword || pg.url} ↗</a> : pg.keyword}
                      {typeof pg.traffic === "number" && ` · 流量 ${pg.traffic.toLocaleString()}`}{typeof pg.volume === "number" && ` · 月搜 ${pg.volume.toLocaleString()}`}
                    </span>
                    {pg.keyword && <button disabled={busy} onClick={() => void act(async () => { const r = await api<any>("benchmark-words", { items: [{ keyword: pg.keyword, host: openHost }] }); ws.setNotice(r.note || "已加入词库候选。"); })}>+ 词库候选</button>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input style={{ flex: 1, maxWidth: 320 }} placeholder="添加标杆站域名（如 octavebase.com）" value={newHost} onChange={(e) => setNewHost(e.target.value)} />
            <button disabled={busy || !newHost.trim()} onClick={() => void act(async () => { await api("benchmark-sites", { action: "add", host: newHost.trim() }); setNewHost(""); })}>添加</button>
          </div>
        </>
      )}
    </section>
  );
}

// 手动回传（批4 W7-11④）：粘贴哥飞站内查询结果 → 后端解析（JSON/文本双模式）落词库指标
// （✋manual-gephei 权重最高）→ 站群卡价值面板即时点亮；带最近 3 条回传记录。仅数据源开启时显示。
function ManualReturnPanel({ ws }: { ws: Workspace }) {
  const seoEnabled = !!ws.data?.config?.seoDataSource?.enabled;
  const [raw, setRaw] = useState("");
  const [recent, setRecent] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const load = () => void api<any>("seo-terms/manual/recent").then((r) => setRecent(r.items || [])).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!seoEnabled) return null;
  return (
    <section className="surface" style={{ padding: "16px 18px", marginBottom: 14 }}>
      <p className="dash-label" style={{ marginTop: 0 }}>✋ 手动回传<span className="dash-label-sub">粘贴哥飞站内查询结果（JSON 或 每行「词 月搜 KD CPC」文本），✋手动数据权重最高，站群卡价值面板即时点亮</span></p>
      <textarea
        style={{ width: "100%", minHeight: 72, fontFamily: "monospace", fontSize: 12 }}
        placeholder={'JSON：[{"keyword":"ai agent","volume":880,"kd":12,"cpc":0.6}]' + "\n" + '或文本（每行）：ai agent  880  12  0.6'}
        onChange={(e) => setRaw(e.target.value)}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <button disabled={busy || raw.trim().length < 2} onClick={() => {
          setBusy(true);
          void api<any>("seo-terms/manual", { raw }).then((r) => { ws.setNotice(""); setRaw(""); load(); ws.refresh(); }).catch(() => {}).finally(() => setBusy(false));
        }}>{busy ? "回传中…" : "回传落库"}</button>
        {recent.length > 0 && (
          <span className="muted" style={{ fontSize: 12 }}>
            最近：{recent.map((r, i) => `${new Date(r.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} ${r.applied} 词${i < recent.length - 1 ? " · " : ""}`)}
          </span>
        )}
      </div>
    </section>
  );
}
