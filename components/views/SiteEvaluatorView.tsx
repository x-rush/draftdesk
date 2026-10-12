"use client";
// 应用机会 · 站群评估器（信息架构 v2-5）：
// 数据源 = seo-terms 中 siteCandidate:true 的词；域名/站型/需求大纲均来自外部 Agent 数据。
// [讨论][推进=立项建站（site-projects, pending）]；忽略为会话级隐藏。
// 站点发现 tab（海外定位批 6）：site-discoveries 独立站卡片（host/命中词/首次发现/它做的是什么）。
// 机会引擎 tab（第五轮 §1）：四信号源统一机会卡（opportunities），auto/agent 来源标注 + 生成按钮。
// 新站发现 tab（第五轮 §2）：site-launches Show HN/PH 新站（六类判定/中文转译/核心词/撞词标记）。
import { useMemo, useState, type ReactNode } from "react";
import { Ban, CheckCircle2, Globe, Sparkles, Zap } from "lucide-react";
import { Select } from "../Select";
import type { Workspace, Snapshot } from "../useWorkspaceData";
import { Empty, api, date } from "../ui";

const SIGNAL_LABELS: Record<string, string> = { complaint: "用户抱怨", newtech: "新技术", news: "新资讯", trend: "热词趋势" };
const KIND_LABELS: Record<string, string> = { app: "应用", site: "站群/内容页" };
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
  const [generating, setGenerating] = useState(false);
  const filtered = opportunities.filter((o) =>
    (!signal || (o.signals || []).includes(signal)) && (!source || o.source === source));
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
                  {(o.signals || []).map((s: string) => <span key={s} className="pill">{SIGNAL_LABELS[s] || s}</span>)}
                  <span className="pill"><Zap size={11} /> {o.source}</span>
                  {o.platform && <span>{o.platform}</span>}
                  {typeof o.watchRefs === "number" && o.watchRefs > 0 && <span>引用 {o.watchRefs} 次</span>}
                  <span>{date(o.createdAt)}</span>
                </div>
                <button className="article-title" style={{ fontSize: 16, padding: "4px 0 0" }} onClick={() => { void navigator.clipboard.writeText(o.title); setNotice("已复制：" + o.title); }}>{o.title}</button>
                <p style={{ margin: "4px 0 0" }}>{o.oneLiner}</p>
                <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
                  形态：{o.form} · 初判理由：{o.verdictReason}
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
  const [tab, setTab] = useState<"candidates" | "sites" | "launches" | "opportunities">("candidates");
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
        <button className={tab === "candidates" ? "active" : ""} aria-current={tab === "candidates" ? "page" : undefined} onClick={() => setTab("candidates")}>站群候选 {candidates.length}</button>
        <button className={tab === "sites" ? "active" : ""} aria-current={tab === "sites" ? "page" : undefined} onClick={() => setTab("sites")}><Globe size={13} /> 站点发现 {discoveries.length}</button>
        <button className={tab === "launches" ? "active" : ""} aria-current={tab === "launches" ? "page" : undefined} onClick={() => setTab("launches")}>🚀 新站发现 {launchList.length}</button>
        <button className={tab === "opportunities" ? "active" : ""} aria-current={tab === "opportunities" ? "page" : undefined} onClick={() => setTab("opportunities")}><Sparkles size={13} /> 机会引擎 {opportunityList.length}</button>
      </nav>
      {tab === "launches" && <SiteLaunchesTab siteLaunches={launchList} onJumpSites={(host) => { setTab("sites"); setNotice("新站发现交叉站：" + host + "（已在站点发现列表中，可按排序查看）。"); }} />}
      {tab === "opportunities" && <OpportunitiesTab ws={ws} opportunities={opportunityList} />}
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
      {tab === "candidates" && (
      <>
      <div className="filter-row">
        <Select aria-label="按站型筛选" value={siteType} onChange={(e) => setSiteType(e.target.value)}>
          <option value="all">全部站型</option>
          <option value="资讯站">资讯站（广告变现）</option>
          <option value="工具站">工具站（订阅变现）</option>
        </Select>
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
