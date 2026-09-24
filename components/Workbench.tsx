"use client";
import { creationLabels, readWorkspaceLocation, newlyFinished, type JobActivity } from "../core/workspace-ui";
import { ActivityCard, ActivityTools } from "./Activities";
import {DiscoveryLens} from "./DiscoveryLens";
import type {DiscoveryRecord} from "../core/discovery";
import { Pagination, type PageInfo } from "./Pagination";
import { Select } from "./Select";
import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Compass,
  FlaskConical,
  TrendingUp,
  MessageSquare,
  Settings2,
  Plug,
  Library,
  Layers,
  Play,
  PanelLeft,
  ArrowUpRight,
  Search,
  RefreshCw,
  Users,
  Leaf,
} from "lucide-react";
import type { Artifact, Plan, Source, Job } from "../core/schema";
import { decisionLabels, decisionOf } from "../core/research-policy";
import { ArtifactPanel } from "./ArtifactPanel";
import { PlanEditor, SourceEditor } from "./ResearchSetup";
import { Discussion } from "./Discussion";
import { Connections } from "./Connections";
import { PlanPreview, ResearchBrief } from "./ResearchBrief";
import {
  api,
  date,
  download,
  Drawer,
  Empty,
  Field,
  kindLabels,
  kindPlanLabels,
} from "./ui";
const nav = [
  ["discover", "每日发现", Compass],
  ["library", "我的选题库", Library],
  ["trends", "热词趋势", TrendingUp],
  ["ideas", "应用机会", FlaskConical],
  ["people", "人物观察", Users],
  ["activities", "创作活动", Compass],
  ["chat", "研究讨论", MessageSquare],
  ["plans", "研究策略", Layers],
  ["sources", "数据源", BookOpen],
  ["runs", "运行记录", Play],
  ["skills", "研究 Skills", Leaf],
  ["connections", "外部接入", Plug],
  ["settings", "模型与设置", Settings2],
] as const;
const headings: Record<string, [string, string]> = {
  discover: [
    "找到值得写，也值得做的事",
    "先看变化与个人影响，再决定投入哪一个想法。",
  ],
  library: [
    "把值得继续的想法留下",
    "收藏不是发布。每条选题都可以继续补证据、推敲和创作。",
  ],
  trends: [
    "热词之外，读懂真实信号",
    "保留地域、时间与指标口径；热度和需求分开判断。",
  ],
  ideas: [
    "先验证一个具体问题",
    "产品动态提供可能性，真实用户任务决定是否值得做。",
  ],
  activities:["找到值得参与的创作活动","AI、Vibe Coding 与可参与的创作激励；先核对规则，再选择内容方向。"],
  people: [
    "观察作者的作品与方法",
    "追踪公开工作，不把同名、转载或个人推测当事实。",
  ],
  chat: ["让观点多走一步", "带着证据讨论，整理成可继续编辑的内容或应用方案。"],
  plans: [
    "设计你的研究节奏",
    "目标、来源、关键词和预算，共同决定每天的研究质量。",
  ],
  sources: [
    "从可靠的线索开始",
    "清楚知道每个来源能提供什么，以及不能证明什么。",
  ],
  runs: ["看得见每一步研究", "采集、整理、分析与审稿，各自留下可追溯的记录。"],
  skills: [
    "把好方法变成可重复的流程",
    "按需加载的研究规程，配合数据合同与质量门槛执行。",
  ],
  connections: [
    "你的智能体，统一的工作台",
    "内置研究与外部工具使用同一套证据和产物标准。",
  ],
  settings: [
    "连接模型，设好边界",
    "百炼统一用于分析与讨论；预算和密钥留在服务端。",
  ],
};
type Snapshot = {
  jobActivity: JobActivity[];
  pagination: {artifacts:PageInfo;jobs:PageInfo;submissions:PageInfo};
  stats:{artifacts:number;review:number;counts:Record<string,number>;running:number;activePlanIds:string[]};
  config: any;
  plans: Plan[];
  sources: Source[];
  artifacts: Artifact[];
  jobs: Job[];
  connections: any[];
  conversations: any[];
  submissions: any[];
  worker?: { heartbeat: string };
  budget: { reserved: number; limit: number };
  evidence: any[];
  discovery: DiscoveryRecord|null;
};
export function Workbench() {
  const [data, setData] = useState<Snapshot | null>(null),
    [view, setView] = useState("discover"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [mobile, setMobile] = useState(false),
    [selected, setSelected] = useState<Artifact | null>(null),
    [plan, setPlan] = useState<Plan | null>(null),
    [source, setSource] = useState<Source | null>(null),
    [discussionArtifact, setDiscussionArtifact] = useState<
      Artifact | undefined
    >(),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState("all"),
    [quality, setQuality] = useState("active"),
    [skills, setSkills] = useState<any[]>([]),
    [skill, setSkill] = useState<any>(),
    [legacy, setLegacy] = useState<any[]>([]),
    [legacyOpen, setLegacyOpen] = useState<any>(),
    [today, setToday] = useState("");
  const [page,setPage]=useState(1), [jobsPage,setJobsPage]=useState(1), [receiptsPage,setReceiptsPage]=useState(1);
  const [loading,setLoading]=useState(false);
  const [activityPlatform,setActivityPlatform]=useState("all"),[activityTime,setActivityTime]=useState("all");
  const [locationReady,setLocationReady]=useState(false), [creation,setCreation]=useState("all"), [jobId,setJobId]=useState(""), [runId,setRunId]=useState("");
  const [finished,setFinished]=useState<Snapshot["jobActivity"]>([]);
  const [discoveryMode,setDiscoveryMode]=useState<"results"|"watch"|"coverage">("results");
  const [sourceChecks,setSourceChecks]=useState<Record<string,string>>({});
  const knownJobs=useRef(new Map<string,string>()), activityReady=useRef(false), activitySince=useRef(Date.now()), restoreScroll=useRef(true);
  const requestKey = new URLSearchParams({activityPlatform,activityTime,creation,jobId,runId,page:String(page),jobsPage:String(jobsPage),receiptsPage:String(receiptsPage),view,kind,quality,q:query,pageSize:"20"}).toString();
  const currentKey=useRef(requestKey), requestVersion=useRef(0);
  currentKey.current=requestKey;
  async function refresh() {
    const key=currentKey.current, version=++requestVersion.current;
    const next=await api<Snapshot>("workspace?"+key);
    if(currentKey.current===key && requestVersion.current===version) {
      setData(next);
      const completed=activityReady.current?newlyFinished(next.jobActivity,knownJobs.current,activitySince.current):[];
      if(completed.length)setFinished(old=>[...completed,...old.filter(j=>!completed.some(n=>n.id===j.id))].slice(0,8));
      next.jobActivity.forEach(j=>knownJobs.current.set(j.id,j.state));activityReady.current=true;
      if(restoreScroll.current){restoreScroll.current=false;let y=0;try{y=Number(sessionStorage.getItem("draftdesk.scroll."+key))||0;}catch{}requestAnimationFrame(()=>window.scrollTo(0,y));}
    }
  }
  useEffect(()=>{
    const restore=()=>{const v=readWorkspaceLocation(window.location.search);setActivityPlatform(v.activityPlatform);setActivityTime(v.activityTime);setView(v.view);setQuery(v.q);setKind(v.kind);setQuality(v.quality);setPage(v.page);setJobsPage(v.jobsPage);setReceiptsPage(v.receiptsPage);setCreation(v.creation);setJobId(v.jobId);setRunId(v.runId);setSelected(null);restoreScroll.current=true;setLocationReady(true);};
    restore();window.addEventListener("popstate",restore);return()=>window.removeEventListener("popstate",restore);
  },[]);
  useEffect(()=>{
    if(!locationReady)return;
    window.history.replaceState(null,"","?"+requestKey);
    const save=()=>{try{sessionStorage.setItem("draftdesk.scroll."+requestKey,String(window.scrollY));}catch{}};
    window.addEventListener("scroll",save,{passive:true});return()=>window.removeEventListener("scroll",save);
  },[requestKey,locationReady]);
  useEffect(()=>{
    if(!locationReady)return;
    let alive=true;
    setLoading(true);
    void refresh().catch(e=>{if(alive)setError(e.message)}).finally(()=>{if(alive)setLoading(false)});
    const timer=setInterval(()=>{void refresh().catch(()=>{});},4000);
    return ()=>{alive=false;clearInterval(timer);requestVersion.current++;};
  },[requestKey,locationReady]);
  useEffect(() => {
    setToday(new Date().toLocaleDateString("zh-CN", {month:"long",day:"numeric",weekday:"long",timeZone:"Asia/Shanghai"}));
    void api<any[]>("skills")
      .then(setSkills)
      .catch(() => {});
    void (async () => {
      try {
        const raw = localStorage.getItem("draftdesk.workspace.v1");
        if (raw && !localStorage.getItem("draftdesk.migrated.v2")) {
          await api("migrate-local", JSON.parse(raw));
          localStorage.setItem("draftdesk.migrated.v2", "yes");
        }
        setLegacy(await api<any[]>("legacy"));
      } catch {
        setError("旧选题自动迁移未完成，原浏览器数据仍保留；可导出后重试。");
      }
    })();
  }, []);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function navigate(v: string) {
    window.history.pushState(null,"","?view="+v);
    setCreation("all");setJobId("");setRunId("");
    setView(v);
    setPage(1);setJobsPage(1);setReceiptsPage(1);
    setMobile(false);
    setQuery("");
    setNotice("");
    setError("");
  }
  function showResults(id:string){navigate("discover");setJobId(id);setQuality("all");setKind("all");}
  async function moveSelected(direction:number){
    if(!data || !selected)return;
    const index=data.artifacts.findIndex(a=>a.id===selected.id);
    const next=data.artifacts[index+direction];
    if(next){setSelected(next);return;}
    const nextPage=data.pagination.artifacts.page+direction;
    if(nextPage<1||nextPage>data.pagination.artifacts.pages)return;
    setBusy(true);
    try{const q=new URLSearchParams(currentKey.current);q.set("page",String(nextPage));const result=await api<Snapshot>("workspace?"+q);const target=direction>0?result.artifacts[0]:result.artifacts.at(-1);if(target){setPage(nextPage);setSelected(target);}}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const titles = headings[view], running=data?.stats.running || 0;
  const filtered = data?.artifacts || [];
  const pager=(info:PageInfo,change:(page:number)=>void)=><Pagination info={info} onChange={change} disabled={loading || busy}/>;
  return (
    <div className="app-shell">
      <aside className={"sidebar " + (mobile ? "open" : "")}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("discover");
          }}
        >
          <span>
            <Leaf size={24} />
          </span>
          <strong>
            拾题<small>DraftDesk</small>
          </strong>
          <b>02</b>
        </a>
        <div className="workspace-label">
          <span className="avatar">我</span>
          <div>
            <strong>个人研究工作台</strong>
            <small>证据 → 观点 → 行动</small>
          </div>
        </div>
        <nav aria-label="工作台导航">
          {nav.map(([id, label, Icon], index) => (
            <div key={id}>
              {id === "plans" && <small className="nav-divider">研究引擎</small>}
              <button
                className={view === id ? "active" : ""}
                onClick={() => navigate(id)}
              >
                <Icon size={18} />
                {label}
                {id === "runs" && running > 0 && <em>{running}</em>}
              </button>
            </div>
          ))}
        </nav>
        <footer>
          <span className="dot" />
          本机 Docker · 个人版
          <button
            title="导出不含密钥的工作数据"
            disabled={busy}
            onClick={() =>
              void act(async () =>
                download("draftdesk-workspace.json", await api("export")),
              )
            }
          >
            导出工作数据
          </button>
        </footer>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <button
              className="icon menu"
              aria-label="打开导航"
              onClick={() => setMobile(!mobile)}
            >
              <PanelLeft size={20} />
            </button>
            <span>我的工作台</span>
            <span className="slash">/</span>
            <strong>{nav.find((n) => n[0] === view)?.[1]}</strong>
          </div>
          <div>
            <span
              className={
                "worker-status " +
                (data?.worker &&
                Date.now() - Date.parse(data.worker.heartbeat) < 60000
                  ? "online"
                  : "")
              }
            >
              {data?.worker &&
              Date.now() - Date.parse(data.worker.heartbeat) < 60000
                ? "研究引擎在线"
                : data
                  ? "研究引擎未就绪"
                  : "正在检查研究引擎"}
            </span>
            <button
              className="icon"
              aria-label="刷新工作台"
              onClick={() => void act(refresh)}
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <p className="date-stamp">
                {today}
              </p>
              <h1>{titles[0]}</h1>
              <p>{titles[1]}</p>
            </div>
            {data &&
              ["discover", "trends", "ideas", "people", "activities"].includes(view) && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => navigate("plans")}
                >
                  开始一次研究 <ArrowUpRight size={16} />
                </button>
              )}
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => void act(refresh)}>重新连接</button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          {!data && !error && (
            <Empty title="正在打开工作台">读取持久化研究数据…</Empty>
          )}
          {finished.map(j=><section className="task-notice" role="status" key={j.id}><div><strong>{j.name} · {j.state==="completed"?"已完成":j.state==="failed"?"失败":"已取消"}</strong><p>{j.state==="completed"?`新增 ${j.total} 条结果，其中 ${j.review} 条待验证。`:"查看运行说明，处理来源或配置后可手动重试。"}</p></div><button onClick={()=>{if(j.state==="completed")showResults(j.id);else{navigate("runs");setRunId(j.id);}}}>{j.state==="completed"?"查看本次结果":"查看运行说明"}</button><button aria-label="关闭任务提示" onClick={()=>setFinished(old=>old.filter(x=>x.id!==j.id))}>关闭</button></section>)}
          {data && (
            <>
              {["discover", "library", "trends", "ideas", "people", "activities"].includes(
                view,
              ) && (
                <>
                  {view === "activities"&&<ActivityTools onChange={refresh} onRun={()=>navigate("runs")} plans={data.plans} active={data.stats.activePlanIds.includes("creator-activities")}/> }
                  {view === "discover" && (
                    <section className="daily-brief">
                      <div>
                        <span>{data.discovery?`最近一次搜罗 · ${date(data.discovery.at)}`:"工作台概览"}</span>
                        <h2>
                          {data.stats.artifacts
                            ? "从证据出发，挑一个具体切口。"
                            : "第一份研究，从你的问题开始。"}
                        </h2>
                        <p>
                          {data.config.hasApiKey
                            ? "运行研究策略，或接收外部智能体的证据包。所有结果先私有。"
                            : "先配置百炼模型，或让 Hermes / OpenClaw 提交研究证据。"}
                        </p>
                        <button
                          className="text-button"
                          onClick={() =>
                            navigate(
                              data.config.hasApiKey ? "plans" : "settings",
                            )
                          }
                        >
                          {data.config.hasApiKey
                            ? "查看研究策略"
                            : "配置百炼连接"}{" "}
                          <ArrowUpRight size={15} />
                        </button>
                      </div>
                      <dl>
                        <div>
                          <dt>{data.discovery?"读取条目":"研究产物"}</dt>
                          <dd>{data.discovery?data.discovery.sources.reduce((n,s)=>n+s.raw,0):data.stats.artifacts}</dd>
                        </div>
                        <div>
                          <dt>{data.discovery?"待观察":"待补证据"}</dt>
                          <dd>{data.discovery?data.discovery.candidates.filter(c=>c.status==="watch").length:data.stats.review}</dd>
                        </div>
                        <div>
                          <dt>{data.discovery?"入模证据":"正在运行"}</dt>
                          <dd>{data.discovery?data.discovery.sources.reduce((n,s)=>n+s.selected,0):running}</dd>
                        </div>
                      </dl>
                    </section>
                  )}
                  {view === "discover"&&<nav className="discovery-modes" aria-label="每日发现视图">{(["results","watch","coverage"] as const).map(mode=><button key={mode} className={discoveryMode===mode?"active":""} aria-current={discoveryMode===mode?"page":undefined} onClick={()=>setDiscoveryMode(mode)}>{mode==="results"?"推荐结果":mode==="watch"?`待观察${data.discovery?` ${data.discovery.candidates.filter(c=>c.status==="watch").length}`:""}`:"采集覆盖"}</button>)}</nav>}
                  {(view!=="discover"||discoveryMode==="results")&&<>
                  {jobId&&<p className="context-note">正在查看本次研究的全部结果（含待验证和已否决）。<button onClick={()=>{setJobId("");setPage(1);}}>查看所有研究</button></p>}
                  <div className="filter-row">
                    <label className="search">
                      <Search size={17} />
                      <input
                        aria-label="搜索研究内容"
                        placeholder="搜索主题、读者或标签"
                        value={query}
                        onChange={(e) => {setQuery(e.target.value);setPage(1);}}
                      />
                    </label>
                    <Select
                      aria-label="质量状态"
                      value={quality}
                      onChange={(e) => {setQuality(e.target.value);setPage(1);}}
                    >
                      <option value="active">推荐与待验证</option>
                      <option value="ready">推荐 · 通过检查</option>
                      <option value="review">待验证</option>
                      <option value="rejected">已否决</option>
                      <option value="all">全部（含已否决）</option>
                    </Select>
                    {view==="activities"&&<><Select aria-label="活动平台" value={activityPlatform} onChange={e=>{setActivityPlatform(e.target.value);setPage(1);}}>{["all","哔哩哔哩","抖音","快手","小红书"].map(v=><option key={v} value={v}>{v==="all"?"全部平台":v}</option>)}</Select><Select aria-label="活动时间" value={activityTime} onChange={e=>{setActivityTime(e.target.value);setPage(1);}}>{Object.entries({all:"全部时间",ongoing:"进行中",upcoming:"未开始",unknown:"时间待核实",ended:"已结束"}).map(([k,v])=><option key={k} value={k}>{v}</option>)}</Select></>}
                    {view==="library"&&<Select aria-label="筛选创作状态" value={creation} onChange={e=>{setCreation(e.target.value);setPage(1);}}><option value="all">全部创作状态</option>{Object.entries(creationLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</Select>}
                  </div>
                  {loading&&<p role="status">正在加载列表…</p>}
                  {view === "discover" && (
                    <div className="tabs">
                      <button
                        className={kind === "all" ? "active" : ""}
                        onClick={() => {setKind("all");setPage(1);}}
                      >
                        全部
                      </button>
                      {Object.entries(kindLabels).map(([k, label]) => (
                        <button
                          className={kind === k ? "active" : ""}
                          key={k}
                          onClick={() => {setKind(k);setPage(1);}}
                        >
                          {label}
                          <span>
                            {data.stats.counts[k] || 0}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {view === "trends" && (
                    <p className="context-note">
                      指标来自原始来源，保留地域、时间与单位。不把单次上榜解释为增长，也不把热度等同付费需求。
                    </p>
                  )}
                  {view === "ideas" && (
                    <p className="context-note">
                      此区域始终私有。每个机会都应包含现有替代、最小流程、实验与停止条件。
                    </p>
                  )}
                  {!filtered.length ? (
                    <Empty
                      title={
                        jobId ? "本次研究没有符合条件的结果" : query ? "没有匹配的研究内容" : "这里还没有研究结果"
                      }
                    >
                      {jobId ? <button onClick={()=>{const id=jobId;navigate("runs");setRunId(id);}}>查看研究说明与缺失证据</button> : view === "library"
                        ? "从每日发现收藏值得继续的内容。"
                        : "运行一条研究策略，或在外部接入页导入证据包，再进行分析。"}
                    </Empty>
                  ) : (
                    <div className="discovery-list">
                      {filtered.map((a, index) => (
                        <article className="discovery-row" key={a.id}>
                          <div className="row-number">
                            {String((data.pagination.artifacts.page - 1) * data.pagination.artifacts.pageSize + index + 1).padStart(2, "0")}
                          </div>
                          <div className="row-content">
                            <div className="row-meta">
                              {a.saved&&<span className="creation-badge">{creationLabels[a.creationStatus || "inbox"]}</span>}
                              <span>{kindLabels[a.kind]}</span>
                              <span>
                                {a.visibility === "private" ? "私有" : "公开"}
                              </span>
                              <span>{date(a.createdAt)}</span>
                              <span className={"quality-badge " + a.quality}>
                                {decisionLabels[decisionOf(a)]}
                              </span>
                            </div>
                            <button
                              className="article-title"
                              onClick={() => setSelected(a)}
                            >
                              {a.title}
                            </button>
                            <p>{a.personalImpact}</p>
                            {a.kind==="activity"&&<ActivityCard activity={a}/>}
                            <div className="tags">
                              {a.tags.map((t) => (
                                <button key={t} onClick={() => {setQuery(t);setPage(1);}}>
                                  {t}
                                </button>
                              ))}
                            </div>
                            {a.kind === "trend" && (
                              <small>
                                {a.details.region} · {a.details.window} ·{" "}
                                {a.details.intent}
                              </small>
                            )}
                          </div>
                          <div className="row-side">
                            <small>{a.evidenceIds.length} 条证据</small>
                            <button onClick={() => setSelected(a)}>
                              查看研究 <ArrowUpRight size={15} />
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                  {pager(data.pagination.artifacts,setPage)}
                  </>}
                  {view==="discover"&&discoveryMode!=="results"&&<DiscoveryLens record={data.discovery} mode={discoveryMode}/>}
                  {view === "library" && legacy.length > 0 && (
                    <section className="legacy-section">
                      <h2>
                        已迁移的旧版选题 <span>{legacy.length}</span>
                      </h2>
                      <p>
                        原始观点、标签、素材和时间完整保留。它们不被当作已经证据化的新研究产物。
                      </p>
                      {legacy.map((t) => (
                        <button
                          className="legacy-row"
                          key={t.id}
                          onClick={() => setLegacyOpen(t)}
                        >
                          <strong>{t.title}</strong>
                          <small>{t.audience || "未设置读者"}</small>
                          <ArrowUpRight size={16} />
                        </button>
                      ))}
                    </section>
                  )}
                </>
              )}
              {view === "plans" && (
                <>
                  <div className="toolbar">
                    <button
                      className="primary"
                      onClick={() =>
                        setPlan({
                          ...data.plans[0],
                          id: crypto.randomUUID(),
                          name: "新的研究策略",
                          scheduleEnabled: false,
                        })
                      }
                    >
                      ＋ 新建策略
                    </button>
                    <span>自动运行默认关闭 · 可随时调整</span>
                  </div>
                  <div className="plan-list">
                    {data.plans.map((p) => (
                      <section className="plan-row" key={p.id}>
                        <div className="plan-icon">
                          <Layers size={23} />
                        </div>
                        <div className="plan-content">
                          <span className="pill">{kindPlanLabels[p.kind]}</span>
                          <h2>{p.name}</h2>
                          <p>{p.goal}</p>
                          {p.kind!=="activities"&&<PlanPreview plan={p} sources={data.sources}/>}
                          {p.kind!=="activities"&&<div className="tags">
                            {p.sourceIds.map((id) => (
                              <span key={id}>
                                {data.sources.find((s) => s.id === id)?.name ||
                                  id}
                              </span>
                            ))}
                          </div>}
                          <small>
                            {p.kind==="activities"?"登录浏览器中手动启动采集":p.scheduleEnabled
                              ? `每天 ${p.dailyTime}（北京）`
                              : "手动运行"}{" "}
                            · 最多 {p.maxItems} 条产物 · {p.maxModelCalls}{" "}
                            次模型调用 · {p.maxTokens.toLocaleString()} token
                            上限
                          </small>
                        </div>
                        <div className="plan-actions">
                          {p.kind==="activities"?<button className="primary" onClick={()=>navigate("activities")}>前往活动采集</button>:<button
                            disabled={
                              busy ||
                              data.stats.activePlanIds.includes(p.id)
                            }
                            className="primary"
                            onClick={() =>
                              void act(async () => {
                                await api("jobs", { planId: p.id });
                                navigate("runs");
                                setNotice("研究任务已入队。");
                              })
                            }
                          >
                            <Play size={15} />
                            运行
                          </button>}
                          <button onClick={() => setPlan(p)}>调整策略</button>
                        </div>
                      </section>
                    ))}
                  </div>
                </>
              )}
              {view === "sources" && (
                <>
                  <div className="toolbar">
                    <button
                      className="primary"
                      onClick={() =>
                        setSource({
                          id: crypto.randomUUID(),
                          name: "新的公开来源",
                          type: "rss",
                          sourceType: "media",
                          enabled: true,
                          note: "",
                        })
                      }
                    >
                      ＋ 添加来源
                    </button>
                  </div>
                  <div className="source-list">
                    {data.sources.map((s) => (
                      <article className="source-row" key={s.id}>
                        <div>
                          <span className="pill">{s.type.toUpperCase()}</span>
                          <h2>{s.name}</h2>
                          <p>{s.note}</p>
                          <small>
                            {s.url ||
                              s.query ||
                              s.region ||
                              "使用策略中的关键词"}{" "}
                            · {s.enabled ? "已启用" : "已停用"}
                          </small>
                        </div>
                        <div className="source-actions">
                          {s.type === "aggregated" && <button disabled={sourceChecks[s.id]==="检测中…"} onClick={async()=>{
                            setSourceChecks(old=>({...old,[s.id]:"检测中…"}));
                            try{const result=await api<{count:number;updatedAt:string}>("source-check",{sourceId:s.id});setSourceChecks(old=>({...old,[s.id]:`可用 · ${result.count} 条 · 更新于 ${date(result.updatedAt)}`}));}
                            catch(e){setSourceChecks(old=>({...old,[s.id]:`失败 · ${(e as Error).message}`}));}
                          }}>检测连接</button>}
                          <button onClick={() => setSource(s)}>配置</button>
                          {sourceChecks[s.id] && <small role="status">{sourceChecks[s.id]}</small>}
                        </div>
                      </article>
                    ))}
                  </div>
                  <p className="context-note">
                    百度热搜、Google Trends 地域榜、GitHub Trending 与 Hacker News Top 已接入。本地 DailyHotApi 已验证知乎、抖音、头条、贴吧和掘金；B站曾超时、复测成功，默认停用；微博和快手本机仍失败。可逐个检测连接后启用。聚合榜单显示获取方式和更新时间，只作线索，需核对原平台内容。登录后的创作者活动须走活动采集流程。
                  </p>
                </>
              )}
              {view === "runs" && (
                <>
                  <div className="budget-strip">
                    <strong>
                      今日 token 预留：{data.budget.reserved.toLocaleString()} /{" "}
                      {data.budget.limit.toLocaleString()}
                    </strong>
                    <span>
                      保守预算包含最大输出，不等于账单；实际模型用量在每个任务中显示。
                    </span>
                  </div>
                  {!data.jobs.length ? (
                    <Empty title="研究尚未开始">
                      在研究策略中运行一次，完整流程会记录在这里。
                    </Empty>
                  ) : (
                    data.jobs.map((j) => (
                      <section className="run" key={j.id}>
                        <header>
                          <div>
                            <h2>{j.plan.name}</h2>
                            {j.state==="completed"&&<button onClick={()=>showResults(j.id)}>查看本次结果</button>}
                            <small>
                              {date(j.createdAt)} ·{" "}
                              {j.external ? "外部证据分析" : "内置采集"}
                            </small>
                          </div>
                          <span className={"pill state-" + j.state}>
                            {
                              {
                                queued: "等待",
                                running: "运行中",
                                completed: "完成",
                                failed: "失败",
                                cancelled: "已取消",
                              }[j.state]
                            }
                          </span>
                          {["queued", "running"].includes(j.state) && (
                            <button
                              disabled={busy || j.cancelRequested}
                              onClick={() =>
                                void act(async () => {
                                  await api("cancel", { id: j.id });
                                })
                              }
                            >
                              {j.cancelRequested ? "正在取消" : "取消任务"}
                            </button>
                          )}
                        </header>
                        <p>
                          {j.outcome === "no-findings" ? "完成 · 本轮无新增推荐" : j.stage} · {j.evidenceIds.length} 条证据 · {j.searchCount ?? "未记录"} 次搜索（含补证） · {j.calls}{" "}
                          次模型调用 · 已回传用量 {j.actualTokens.toLocaleString()}{" "}
                          tokens
                        </p>
                        {j.calls > 0 && j.state !== "completed" && <p className="muted">进行中或中断的调用可能尚未回传用量，0 不代表未计费。</p>}
                        {j.error && <p className="error">{j.error}</p>}
                        {["failed", "cancelled"].includes(j.state) && j.evidenceIds.length > 0 &&
                          <button disabled={busy || data.stats.activePlanIds.includes(j.planId)}
                            onClick={() => void act(async () => {
                              await api("jobs", { planId: j.planId, evidenceIds: j.evidenceIds });
                            })}>使用保留证据重试（不重复搜索）</button>}
                        {j.warnings.map((w, i) => (
                          <p className="warning" key={i}>
                            {w}
                          </p>
                        ))}
                        <ResearchBrief job={j}/>
                        <details>
                          <summary>步骤、预算与技能版本</summary>
                          <ol className="timeline">
                            {j.steps.map((s, i) => (
                              <li key={i}>
                                <strong>{s.name}</strong>
                                <span>{s.detail}</span>
                                <small>{date(s.at)}</small>
                              </li>
                            ))}
                          </ol>
                          <p>
                            预留 {j.reservedTokens.toLocaleString()} /{" "}
                            {j.plan.maxTokens.toLocaleString()} tokens
                          </p>
                          {Object.entries(j.skillVersions).map(([k, v]) => (
                            <small className="version" key={k}>
                              {k} · {v}
                            </small>
                          ))}
                          <button
                            onClick={() =>
                              void act(async () =>
                                download(
                                  j.id + "-research.json",
                                  await api("job-context/" + j.id),
                                ),
                              )
                            }
                          >
                            导出中间分析
                          </button>
                        </details>
                      </section>
                    ))
                  )}
                </>
              )}
              {view === "runs" && <>{runId&&<button onClick={()=>setRunId("")}>查看全部运行记录</button>}{pager(data.pagination.jobs,setJobsPage)}</>}
              {view === "skills" && (
                <div className="skill-list">
                  <p className="lead">项目 Skills v1.1 · 参考资料随任务加载并记录版本。已加入选题、趋势与需求判断评测；工程检查通过不等于真实模型质量验收。内容策划与需求研究方法改编来源：Corey Haines / marketingskills（MIT），完整来源与边界见下载包。</p>
                  {skills.map((s) => (
                    <button
                      className="skill-row"
                      key={s.id}
                      onClick={() => setSkill(s)}
                    >
                      <div className="skill-index">
                        {String(skills.indexOf(s) + 1).padStart(2, "0")}
                      </div>
                      <div>
                        <h2>{s.name}</h2>
                        <p>{s.purpose}</p>
                        <small>
                          {s.id} · v{s.version} · {s.digest}
                        </small>
                      </div>
                      <ArrowUpRight size={20} />
                    </button>
                  ))}
                </div>
              )}
              {view === "connections" && (
                <Connections
                  connections={data.connections}
                  receipts={data.submissions}
                  pagination={pager(data.pagination.submissions,setReceiptsPage)}
                  plans={data.plans}
                  onChange={refresh}
                  sources={data.sources} jobs={data.jobs} artifacts={data.artifacts} onOpen={setSelected}
                />
              )}
              {view === "chat" && (
                <Discussion
                  key={discussionArtifact?.id || "free"}
                  artifact={discussionArtifact}
                  history={data.conversations}
                  onChange={refresh}
                />
              )}
              {view === "settings" && (
                <Settings config={data.config} onChange={refresh} />
              )}
            </>
          )}
        </main>
        <footer className="page-footer">
          让每个好想法，都有依据和下一步。
          <span>DraftDesk 2 · 私人研究工作台</span>
        </footer>
      </div>
      {selected && (
        <ArtifactPanel
          key={selected.id}
          artifact={selected}
          navigation={data && data.artifacts.some(a=>a.id===selected.id)?<div className="detail-navigation"><button disabled={busy || data.pagination.artifacts.page===1&&data.artifacts[0]?.id===selected.id} onClick={()=>void moveSelected(-1)}>上一条</button><span>按当前列表顺序浏览 · Esc 关闭</span><button disabled={busy || data.pagination.artifacts.page===data.pagination.artifacts.pages&&data.artifacts.at(-1)?.id===selected.id} onClick={()=>void moveSelected(1)}>下一条</button></div>:undefined}
          onClose={() => setSelected(null)}
          onChange={refresh}
          onDiscuss={(a) => {
            setDiscussionArtifact(a);
            setSelected(null);
            navigate("chat");
          }}
        />
      )}
      {plan && data && (
        <PlanEditor
          initial={plan}
          sources={data.sources}
          onClose={() => setPlan(null)}
          onSaved={refresh}
        />
      )}
      {source && (
        <SourceEditor
          initial={source}
          onClose={() => setSource(null)}
          onSaved={refresh}
        />
      )}{" "}
      {skill && (
        <Drawer
          title={skill.name}
          subtitle={"版本 " + skill.version + " · " + skill.digest}
          onClose={() => setSkill(undefined)}
          wide
        >
          <pre className="skill-content">{skill.content}</pre>
        </Drawer>
      )}
      {legacyOpen && (
        <Drawer
          title={legacyOpen.title}
          subtitle="旧版选题原始数据，完整保留"
          onClose={() => setLegacyOpen(undefined)}
        >
          <p className="lead">{legacyOpen.audience}</p>
          <p className="pre-wrap">{legacyOpen.viewpoint}</p>
          {legacyOpen.links?.map((u: string) => (
            <p key={u}>
              <a
                href={/^https?:\/\//.test(u) ? u : "#"}
                target="_blank"
                rel="noreferrer"
              >
                {u}
              </a>
            </p>
          ))}
          <p>
            素材状态：{legacyOpen.status} · 截止：
            {legacyOpen.deadline || "未设置"}
          </p>
          <button onClick={() => download("legacy-topic.json", legacyOpen)}>
            导出完整原数据
          </button>
        </Drawer>
      )}
    </div>
  );
}
function Settings({
  config,
  onChange,
}: {
  config: any;
  onChange: () => Promise<void>;
}) {
  const [value, setValue] = useState({
      baseUrl: config.baseUrl,
      model: config.model,
      profile: config.profile,
      dailyTokenLimit: config.dailyTokenLimit,
      apiKey: "",
      tavilyKey: "",
      clearApiKey: false,
      clearTavilyKey: false,
    }),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="settings-form surface"
      onSubmit={(e) => {
        e.preventDefault();
        void act(async () => {
          await api("config", value);
          setValue({
            ...value,
            apiKey: "",
            tavilyKey: "",
            clearApiKey: false,
            clearTavilyKey: false,
          });
          setNotice("设置已保存，输入框中的密钥已清空。");
        });
      }}
    >
      <h2>阿里云百炼</h2>
      <p>
        研究、审稿与讨论共用同一模型。填写百炼 API Key，而非阿里云 AccessKey ID
        / Secret。
      </p>
      <Field label="API Base URL">
        <input
          type="url"
          required
          value={value.baseUrl}
          onChange={(e) => setValue({ ...value, baseUrl: e.target.value })}
        />
      </Field>
      <Field label="模型标识">
        <input
          required
          value={value.model}
          onChange={(e) => setValue({ ...value, model: e.target.value })}
        />
      </Field>
      <Field
        label={
          "百炼 API Key · " +
          (config.hasApiKey ? "已配置，留空保留" : "尚未配置")
        }
      >
        <input
          type="password"
          autoComplete="new-password"
          value={value.apiKey}
          onChange={(e) => setValue({ ...value, apiKey: e.target.value })}
        />
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={value.clearApiKey}
          onChange={(e) =>
            setValue({ ...value, clearApiKey: e.target.checked })
          }
        />
        清除已保存的百炼密钥
      </label>
      <hr />
      <h2>搜索与质量预算</h2>
      <Field
        label={
          "Tavily Key · " +
          (config.hasTavilyKey ? "已配置，留空保留" : "可选，网页搜索需要")
        }
      >
        <input
          type="password"
          autoComplete="new-password"
          value={value.tavilyKey}
          onChange={(e) => setValue({ ...value, tavilyKey: e.target.value })}
        />
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={value.clearTavilyKey}
          onChange={(e) =>
            setValue({ ...value, clearTavilyKey: e.target.checked })
          }
        />
        清除已保存的搜索密钥
      </label>
      <Field label="受众与内容定位">
        <textarea
          required
          rows={4}
          value={value.profile}
          onChange={(e) => setValue({ ...value, profile: e.target.value })}
        />
      </Field>
      <Field
        label="每日模型 token 预留上限"
        hint="覆盖内置研究与讨论；保守预留不返还，可防止连续失败产生无上限调用。不是人民币账单。"
      >
        <input
          type="number"
          min={30000}
          max={2000000}
          required
          value={value.dailyTokenLimit}
          onChange={(e) =>
            setValue({ ...value, dailyTokenLimit: Number(e.target.value) })
          }
        />
      </Field>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <footer className="form-actions">
        <button
          type="button"
          disabled={busy || !config.hasApiKey}
          onClick={() =>
            void act(async () => {
              const r = await api("test-model", {});
              setNotice("已保存配置：" + r.message);
            })
          }
        >
          测试模型连接
        </button>
        <button type="button" disabled={busy || !config.hasTavilyKey}
          onClick={() => void act(async () => {
            const r = await api("test-search", {});
            setNotice(r.message);
          })}>
          测试搜索（1 次 basic）
        </button>
        <button className="primary" disabled={busy}>
          {busy ? "处理中…" : "保存设置"}
        </button>
      </footer>
    </form>
  );
}
