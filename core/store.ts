import { activityStatus } from "./activities";
import type {DiscoveryRecord} from "./discovery";
import {hotspotFeed,urlKey} from "./hotspots";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createHash,
  randomUUID,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { defaultConfig, defaultPlans, defaultSources, defaultPersona, defaultAiPolicy, defaultConsumerMode } from "./defaults";
import { recordHistory, metricComparison, type MetricSnapshot } from "./history";
import { decisionOf } from "./research-policy";
import { validateIntake } from "./intake-validation";
import { consumptionSummary, consumptionHotspotKeys } from "./agent-read";
import {
  artifactSchema,
  evidenceSchema,
  intakeSchema,
  type Artifact,
  type ArtifactDraft,
  type Config,
  type Evidence,
  type Job,
  type Plan,
  type Source,
} from "./schema";
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code?: string,
  ) {
    super(message);
  }
}
// 稳定错误码枚举：外部 Agent 靠 code 判断而非读中文字符串。
export const ERROR_CODES = {
  TARGET_MISMATCH: "TARGET_MISMATCH",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  SOURCE_DISABLED: "SOURCE_DISABLED",
  NOT_FOUND: "NOT_FOUND",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  SCOPE_MISMATCH: "SCOPE_MISMATCH",
  RATE_LIMITED: "RATE_LIMITED",
} as const;
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const now = () => new Date().toISOString();
export function canonicalUrl(value: string) {
  const u = new URL(value);
  u.hash = "";
  for (const key of [...u.searchParams.keys()])
    if (/^utm_|^(fbclid|gclid)$/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  return u.href;
}
export class Store {
  db: DatabaseSync;
  constructor(
    directory = process.env.DRAFTDESK_DATA_DIR ||
      path.join(process.cwd(), "data"),
  ) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, "draftdesk.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS documents(collection TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(collection,id));
   CREATE TABLE IF NOT EXISTS submissions(connection TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(connection,id));
   CREATE TABLE IF NOT EXISTS schedules(key TEXT PRIMARY KEY,job_id TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS budgets(day TEXT PRIMARY KEY,reserved INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS locks(id TEXT PRIMARY KEY,expires INTEGER NOT NULL);
  `);
    this.transaction(() => {
      if (!this.get("meta", "initialized")) {
        this.put("config", "main", defaultConfig);
        defaultSources.forEach((s) => this.put("sources", s.id, s));
        defaultPlans.forEach((p) => this.put("plans", p.id, p));
        this.put("meta", "initialized", { version: 2 });
      }
      if(!this.get("meta","activities-v1")){
        const plan=defaultPlans.find(p=>p.id==="creator-activities")!;
        if(!this.get("plans",plan.id))this.put("plans",plan.id,plan);
        this.put("meta","activities-v1",{version:1});
      }
      if(!this.get("meta","cn-hotlists-v1")){
        for(const source of defaultSources.filter(s=>s.type==="hotlist"))if(!this.get("sources",source.id))this.put("sources",source.id,source);
        const trend=this.get<Plan>("plans","trend-radar");
        if(trend && JSON.stringify(trend.sourceIds)==='["trends-us","web"]')this.put("plans",trend.id,{...trend,sourceIds:["baidu-hot",...trend.sourceIds]});
        this.put("meta","cn-hotlists-v1",{version:1});
      }
      if(!this.get("meta","cn-hotwords-v1")){
        const trend=this.get<Plan>("plans","trend-radar");
        if(trend && JSON.stringify(trend.keywords)==='["AI","ChatGPT","Claude","Gemini"]')this.put("plans",trend.id,{...trend,keywords:defaultPlans.find(p=>p.id==="trend-radar")!.keywords});
        this.put("meta","cn-hotwords-v1",{version:1});
      }
      if(!this.get("meta","global-hotlists-v1")){
        for(const source of defaultSources.filter(s=>["github-trending","hacker-news-top","trends-gb","trends-jp","trends-tw","trends-in","trends-kr","trends-de","producthunt-feed"].includes(s.id)))
          if(!this.get("sources",source.id))this.put("sources",source.id,source);
        this.put("meta","global-hotlists-v1",{version:1});
      }
      if(!this.get("meta","aggregate-hotlists-v1")){
        for(const source of defaultSources.filter(s=>s.type==="aggregated"))
          if(!this.get("sources",source.id))this.put("sources",source.id,source);
        this.put("meta","aggregate-hotlists-v1",{version:1});
      }
      if(!this.get("meta","job-budget-v2")){
        // 研究流水线最坏需要 3 阶段 × 2 次模型调用；旧默认预算会在修复轮中途撞墙，
        // 把已付费任务变成失败。这里对存量策略一次性上调到能完成全流程的尺寸。
        for(const p of this.list<Plan>("plans")){
          const next={...p};
          if(next.maxModelCalls<8)next.maxModelCalls=8;
          if(next.maxTokens<400000)next.maxTokens=400000;
          if(next.maxModelCalls!==p.maxModelCalls||next.maxTokens!==p.maxTokens)this.put("plans",p.id,next);
        }
        this.put("meta","job-budget-v2",{version:1});
      }
      if(!this.get("meta","seo-radar-v1")){
        // 趋势/应用机会策略升级：新增搜索联想来源（SEO/站群/web-app 机会的需求露头信号），
        // 趋势策略改以 Google Trends+联想词为主、关键词门禁扩到机会方向。
        for(const source of defaultSources.filter(s=>s.type==="suggest"))
          if(!this.get("sources",source.id))this.put("sources",source.id,source);
        const trend=this.get<Plan>("plans","trend-radar");
        const trendDefault=defaultPlans.find(p=>p.id==="trend-radar")!;
        if(trend)this.put("plans",trend.id,{...trend,sourceIds:trendDefault.sourceIds,keywords:trendDefault.keywords,focusTerms:trendDefault.focusTerms,goal:trendDefault.goal});
        const products=this.get<Plan>("plans","small-products");
        const productsDefault=defaultPlans.find(p=>p.id==="small-products")!;
        if(products)this.put("plans",products.id,{...products,sourceIds:productsDefault.sourceIds,keywords:productsDefault.keywords,goal:productsDefault.goal});
        this.put("meta","seo-radar-v1",{version:1});
      }
      if(!this.get("meta","open-radar-v2")){
        // 采集层去话题门禁：热度本身就是信号，AI 话题之外的社会热度同样采集；
        // 转化判断（AI 内容 / web-app 工具 / SEO 站群）移到分析层目标里。
        // 联想种子改为需求形状词（替代/怎么查/alternative to…），不绑定已被做掉的具体机会。
        for(const source of defaultSources.filter(s=>s.type==="suggest"))this.put("sources",source.id,source);
        const trend2=this.get<Plan>("plans","trend-radar");
        const trend2Default=defaultPlans.find(p=>p.id==="trend-radar")!;
        if(trend2)this.put("plans",trend2.id,{...trend2,keywords:[],focusTerms:[],goal:trend2Default.goal});
        const products2=this.get<Plan>("plans","small-products");
        const products2Default=defaultPlans.find(p=>p.id==="small-products")!;
        if(products2)this.put("plans",products2.id,{...products2,keywords:products2Default.keywords,goal:products2Default.goal});
        this.put("meta","open-radar-v2",{version:1});
      }
      if(!this.get("meta","people-removal-v1")){
        // 人物观察功能已移除：清掉对应策略与任务，防止调度或流水线再触达已删除的人物技能链。
        // 旧库存量仍可能是 "people"，比较用宽松字符串而不是收窄后的联合类型。
        for(const p of this.list<Plan>("plans"))if((p.kind as string)==="people")this.del("plans",p.id);
        for(const j of this.list<Job>("jobs"))if((j.plan?.kind as string)==="people")this.del("jobs",j.id);
        this.put("meta","people-removal-v1",{version:1});
      }
      if(!this.get("meta","decision-layer-v1")){
        // 决策层重构（P1）：quality=证据可信度（字段名保留，语义正名）；decision=人的拍板状态机。
        // 存量映射：saved=true→approved（decidedBy=human），其余 pending；saved 布尔废弃；archived 保留为终态标记。
        // legacy 集合归档导出后移出活动集合；persona 种子仅首版初始化。
        const stamp0=now();
        for(const a of this.list<any>("artifacts")){
          if(a.decision)continue;
          const {saved,...rest}=a;
          this.put("artifacts",a.id,{...rest,decision:saved?"approved":"pending",...(saved?{decidedBy:"human",decidedAt:stamp0}:{})});
        }
        const legacyDocs=this.list<any>("legacy");
        if(legacyDocs.length){
          writeFileSync(path.join(directory,`legacy-archive-${stamp0.slice(0,10)}.json`),JSON.stringify({archivedAt:stamp0,count:legacyDocs.length,items:legacyDocs},null,2));
          for(const l of legacyDocs)this.del("legacy",l.id);
        }
        if(!this.get("config","persona"))this.put("config","persona",defaultPersona);
        // 存量簇补 status 默认值
        for(const c of this.list<any>("clusters")){if(!c.status){this.put("clusters",c.id,{...c,status:"active"});}}
        this.put("meta","decision-layer-v1",{version:1});
      }
      if(!this.get("meta","ai-policy-v1")){
        if(!this.get("config","aiPolicy"))this.put("config","aiPolicy",defaultAiPolicy);
        this.put("meta","ai-policy-v1",{version:1});
      }
      if(!this.get("meta","consumer-mode-v1")){
        if(!this.get("config","consumerMode"))this.put("config","consumerMode",defaultConsumerMode);
        if(!this.get("config","planMode"))this.put("config","planMode","collect-and-analyze");
        this.put("meta","consumer-mode-v1",{version:1});
      }
      if(!this.get("meta","cluster-status-v1")){
        for(const c of this.list<any>("clusters")){if(!c.status)this.put("clusters",c.id,{...c,status:"active"});}
        this.put("meta","cluster-status-v1",{version:1});
      }
            if(!this.get("meta","official-api-hotlists-v1")){
        // B站热门/微博热搜改走官方公开 JSON 接口（HTML 入口有访客验证，聚合上游又常年失败）。
        // 种子两个新来源；热词策略仅在未被用户改动过默认来源清单时同步加入，改过的不碰。
        for(const id of ["weibo-hotsearch","bilibili-popular"]){
          const source=defaultSources.find(s=>s.id===id);
          if(source&&!this.get("sources",id))this.put("sources",id,source);
        }
        const trend3=this.get<Plan>("plans","trend-radar");
        if(trend3&&JSON.stringify(trend3.sourceIds)===JSON.stringify(["suggest-cn","suggest-global","trends-us","trends-gb","baidu-hot","dailyhot-juejin","web"]))
          this.put("plans",trend3.id,{...trend3,sourceIds:defaultPlans.find(p=>p.id==="trend-radar")!.sourceIds});
        this.put("meta","official-api-hotlists-v1",{version:1});
      }
    });
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  get<T>(collection: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT body FROM documents WHERE collection=? AND id=?")
      .get(collection, id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  list<T>(collection: string): T[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM documents WHERE collection=? ORDER BY rowid DESC",
        )
        .all(collection) as Array<{ body: string }>
    ).map((r) => JSON.parse(r.body));
  }
  put<T>(collection: string, id: string, value: T) {
    this.db
      .prepare(
        "INSERT INTO documents(collection,id,body) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET body=excluded.body",
      )
      .run(collection, id, JSON.stringify(value));
    return value;
  }
  del(collection: string, id: string) {
    this.db
      .prepare("DELETE FROM documents WHERE collection=? AND id=?")
      .run(collection, id);
  }
  config() {
    const c = this.get<Config>("config", "main")!;
    return {
      ...c,
      baseUrl: process.env.DRAFTDESK_AI_BASE_URL || c.baseUrl,
      model: process.env.DRAFTDESK_AI_MODEL || c.model,
      apiKey: process.env.DRAFTDESK_AI_API_KEY || c.apiKey,
      tavilyKey: process.env.TAVILY_API_KEY || c.tavilyKey,
    };
  }
  publicConfig() {
    const { apiKey, tavilyKey, ...c } = this.config();
    return { ...c, hasApiKey: !!apiKey, hasTavilyKey: !!tavilyKey, consumerMode: this.get("config", "consumerMode") || "external", planMode: this.get("config", "planMode") || "collect" };
  }
  snapshot(params?: URLSearchParams) {
    const metrics = this.list<MetricSnapshot>("metrics");
    const allJobs = this.list<Job>("jobs");
    const snapshot = {
      config: this.publicConfig(),
      plans: this.list<Plan>("plans").sort((a, b) =>
        a.dailyTime.localeCompare(b.dailyTime),
      ),
      sources: this.list<Source>("sources"),
      artifacts: this.list<Artifact>("artifacts").filter((a) => !a.archived && (a.kind as string) !== "person").map(a => ({...a, quality: decisionOf(a)})),
      events: this.list("events"),
      metrics: metrics.map(m => ({...m, comparison: metricComparison(metrics, m)})),
      evidence: this.list<Evidence>("evidence"),
      discovery: this.list<DiscoveryRecord>("discovery").filter(d=>d.at>=new Date(Date.now()-14*86400000).toISOString()).sort((a,b)=>b.at.localeCompare(a.at)),
      jobs: allJobs,
      connections: this.list<any>("connections").map(({ digest, ...v }) => v),
      conversations: this.list<any>("conversations").map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        artifactId: c.artifactId,
        messageCount: c.messages.length,
      })),
      worker: this.get("meta", "worker"),
      submissions: this.list<any>("receipts").map(r=>({...r,jobs:allJobs.filter(j=>j.receiptId===r.id || (!j.receiptId && j.external && j.evidenceIds.length===r.evidenceIds.length && j.evidenceIds.every(id=>r.evidenceIds.includes(id))))})),
      budget: this.dayBudget(),
    };
    if (!params) return {...snapshot, discovery:snapshot.discovery.slice(0,5), evidence:snapshot.evidence.slice(0,300), jobs:snapshot.jobs.slice(0,40), submissions:snapshot.submissions.slice(0,30)};
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(params.get("pageSize"))) || 20));
    const paginate = <T,>(items:T[], key:string) => {
      const pages = Math.max(1,Math.ceil(items.length/pageSize));
      const page = Math.min(pages,Math.max(1,Math.floor(Number(params.get(key)) || 1)));
      return {items:items.slice((page-1)*pageSize,page*pageSize),page,pageSize,total:items.length,pages};
    };
    const view=params.get("view") || "discover", kind=params.get("kind") || "all", quality=params.get("quality") || "active";
    const activityTime=params.get("activityTime") || (view==="activities"?"actionable":"all");
    const query=(params.get("q") || "").trim().toLocaleLowerCase();
    const artifacts=paginate(snapshot.artifacts.filter(a=>
      (view!=="library" || ["approved","drafting","published"].includes(a.decision||"pending")) &&
      (!params.get("jobId") || a.jobId===params.get("jobId")) &&
      (!params.get("creation") || params.get("creation")==="all" || (a.creationStatus || "inbox")===params.get("creation")) && (view!=="trends" || a.kind==="trend") &&
      (view!=="activities" || a.kind==="activity") &&
      (a.kind!=="activity" || ((!params.get("activityPlatform") || params.get("activityPlatform")==="all" || a.details.platform===params.get("activityPlatform")) && (activityTime==="all" || (activityTime==="actionable" ? (activityStatus(a)==="ongoing"||activityStatus(a)==="upcoming") : activityStatus(a)===activityTime)))) && (view!=="ideas" || a.kind==="idea") &&
      (view!=="discover" || kind==="all" || a.kind===kind) &&
      (quality==="all" || (quality==="active" ? a.quality!=="rejected" : a.quality===quality)) &&
      [a.title,a.summary,a.audience,...a.tags].join(" ").toLocaleLowerCase().includes(query)),"page");
    const jobs=paginate(snapshot.jobs.filter(j=>!params.get("runId") || j.id===params.get("runId")),"jobsPage"), submissions=paginate(snapshot.submissions,"receiptsPage");
    const counts:Record<string,number>={};
    snapshot.artifacts.forEach(a=>counts[a.kind]=(counts[a.kind] || 0)+1);
    const researchDiscovery=snapshot.discovery.filter(d=>d.mode!=="hotspot");
    const qualityCounts={ready:0,review:0,rejected:0};
    snapshot.artifacts.forEach(a=>{if(a.quality in qualityCounts)qualityCounts[a.quality as keyof typeof qualityCounts]++;});
    const consumedHotspotKeys=new Set(consumptionHotspotKeys(this));
    const hotspotSummary=hotspotFeed(snapshot.discovery,new URLSearchParams("hotspotConsumed=include"),1,consumedHotspotKeys);
    const hotspotConsumption=consumptionSummary(this,"hotspots");
    return {...snapshot, discovery:params.get("jobId")?researchDiscovery.find(d=>d.jobId===params.get("jobId"))||null:researchDiscovery[0]||null,
      hotspots:view==="hotspots"?hotspotFeed(snapshot.discovery,params,pageSize,consumedHotspotKeys):null, artifacts:artifacts.items, jobs:jobs.items,
      submissions:submissions.items.map(r=>({...r,artifacts:snapshot.artifacts.filter(a=>r.artifactIds?.includes(a.id)||r.jobs.some((j:Job)=>j.id===a.jobId))})),
      evidence:snapshot.evidence.filter(e=>artifacts.items.some(a=>a.evidenceIds.includes(e.id))),
      events:[], metrics:[],
      jobActivity:snapshot.jobs.filter(j=>["queued","running"].includes(j.state)).concat(snapshot.jobs.filter(j=>!["queued","running"].includes(j.state)).slice(0,50)).map(j=>({id:j.id,state:j.state,createdAt:j.createdAt,name:j.plan?.name || "研究任务",total:snapshot.artifacts.filter(a=>a.jobId===j.id).length,review:snapshot.artifacts.filter(a=>a.jobId===j.id&&a.quality==="review").length})),
      stats:{artifacts:snapshot.artifacts.length,review:qualityCounts.review,qualityCounts,hotspotTotal:hotspotSummary.total,hotspotRemaining:hotspotConsumption.remaining,hotspotConsumed:hotspotConsumption.consumed,sourceFailures:hotspotSummary.sourceHealth.filter(s=>s.status==="failed").length,failedRuns:snapshot.jobs.filter(j=>j.state==="failed").length,counts,
        running:snapshot.jobs.filter(j=>["queued","running"].includes(j.state)).length,
        activePlanIds:snapshot.jobs.filter(j=>["queued","running"].includes(j.state)).map(j=>j.planId)},
      pagination:{artifacts:{...artifacts,items:undefined},jobs:{...jobs,items:undefined},submissions:{...submissions,items:undefined}}
    };
  }
  dayBudget() {
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
    }).format(new Date());
    const row = this.db
      .prepare("SELECT reserved FROM budgets WHERE day=?")
      .get(day) as { reserved: number } | undefined;
    return {
      day,
      reserved: row?.reserved || 0,
      limit: this.config().dailyTokenLimit,
    };
  }
  reserve(tokens: number) {
    const b = this.dayBudget();
    if (b.reserved + tokens > b.limit)
      throw new AppError(
        "今日模型预算不足；可明日再运行，或在设置调整上限。",
        429,
      );
    this.db
      .prepare(
        "INSERT INTO budgets(day,reserved) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET reserved=reserved+excluded.reserved",
      )
      .run(b.day, tokens);
  }
  settleReservation(day: string, reservation: number, usage: number, jobId?: string) {
    // A provider-reported usage total is the only basis for returning unused
    // headroom. Unknown usage and interrupted calls keep the full reservation.
    if (!Number.isSafeInteger(usage) || usage <= 0) return;
    const charged = Math.max(usage + 500, Math.ceil(usage * 1.2));
    const delta = charged - reservation;
    this.transaction(() => {
      this.db.prepare("UPDATE budgets SET reserved=MAX(0,reserved+?) WHERE day=?").run(delta, day);
      if (jobId) {
        const job = this.get<Job>("jobs", jobId);
        if (job) this.put("jobs", jobId, {
          ...job,
          reservedTokens: Math.max(0, job.reservedTokens + delta),
          actualTokens: job.actualTokens + usage,
        });
      }
    });
  }
  addEvidence(input: unknown, producer: string) {
    const v = evidenceSchema.parse(input);
    const normalized = canonicalUrl(v.url);
    const fingerprint = hash(
      normalized + "\n" + v.excerpt + "\n" + JSON.stringify(v.metric || null)
        + "\n" + v.region + "\n" + v.sourceType + "\n" + v.title,
    );
    const previous = this.list<Evidence>("evidence").find(
      (e) => e.fingerprint === fingerprint,
    );
    if (previous) { recordHistory(this, previous, v.collectedAt); return previous; }
    const e: Evidence = {
      ...v,
      url: normalized,
      id: "ev-" + fingerprint.slice(0, 24),
      fingerprint,
      provenance: producer,
    };
    this.put("evidence", e.id, e);
    recordHistory(this, e);
    return e;
  }
  enqueue(planId: string, evidenceIds: string[] = [], scheduledKey?: string, receiptId?: string, retry = false, targetKeywords?: string[]) {
    return this.transaction(() => {
      if (receiptId) {
        const receipt=this.get<any>("receipts",receiptId);
        if(!receipt) throw new AppError("收件回执不存在",404);
        evidenceIds=receipt.evidenceIds;
        const old=this.list<Job>("jobs").find(j=>j.planId===planId && (j.receiptId===receiptId || (!j.receiptId && j.external && j.evidenceIds.length===evidenceIds.length && j.evidenceIds.every(id=>evidenceIds.includes(id)))));
        if(old && (!retry || !["failed","cancelled"].includes(old.state))) return old;
      }
      const savedPlan = this.get<Plan>("plans", planId);
      const plan = savedPlan && targetKeywords?.length && savedPlan.kind === "activities"
        ? {...savedPlan,keywords:targetKeywords.slice(0,8),goal:`${savedPlan.goal}\n本次用户指定目标关键词：${targetKeywords.join("、")}。只推荐与这些方向有直接关系的活动。`}
        : savedPlan;
      if (!plan) throw new AppError("研究策略不存在。", 404);
      if (
        scheduledKey &&
        this.db
          .prepare("SELECT key FROM schedules WHERE key=?")
          .get(scheduledKey)
      )
        return null;
      if (
        this.list<Job>("jobs").some(
          (j) => j.planId === planId && ["queued", "running"].includes(j.state),
        )
      )
        throw new AppError("此策略已有等待或运行中的任务。", 409);
      if (!this.config().apiKey) throw new AppError("请先配置百炼 API Key。");
      const j: Job = {
        id: randomUUID(),
        planId,
        ...(receiptId ? {receiptId} : {}),
        plan,
        state: "queued",
        stage: "等待执行",
        createdAt: now(),
        steps: [],
        evidenceIds,
        calls: 0,
        reservedTokens: 0,
        actualTokens: 0,
        warnings: [],
        external: evidenceIds.length > 0,
        skillVersions: {},
      };
      this.put("jobs", j.id, j);
      if (scheduledKey)
        this.db
          .prepare("INSERT INTO schedules VALUES(?,?)")
          .run(scheduledKey, j.id);
      return j;
    });
  }
  claim() {
    return this.transaction(() => {
      const all = this.list<Job>("jobs");
      for (const j of all)
        if (j.state === "running" && (j.leaseUntil || 0) < Date.now()) {
          this.put("jobs", j.id, {
            ...j,
            state: j.cancelRequested ? "cancelled" : "failed",
            error: "Worker 中断或租约过期；未自动重试付费步骤。",
            finishedAt: now(),
          });
        }
      if (this.list<Job>("jobs").some((j) => j.state === "running")) return;
      const j = all
        .filter((j) => j.state === "queued")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!j) return;
      return this.put("jobs", j.id, {
        ...j,
        state: "running" as const,
        leaseUntil: Date.now() + 300000,
      });
    });
  }
  patchJob(id: string, patch: Partial<Job>) {
    return this.transaction(() => {
      const j = this.get<Job>("jobs", id);
      if (!j) throw new AppError("任务不存在", 404);
      return this.put("jobs", id, { ...j, ...patch });
    });
  }
  step(id: string, name: string, state: string, detail: string) {
    return this.transaction(() => {
      const j = this.get<Job>("jobs", id)!;
      return this.put("jobs", id, {
        ...j,
        stage: name,
        steps: [...j.steps, { name, state, detail, at: now() }],
      });
    });
  }
  saveArtifact(
    draft: ArtifactDraft,
    jobId: string,
    quality: "ready" | "review" | "rejected",
    issues: string[],
    note = "",
    version = "1.0.0",
  ) {
    const a: Artifact = {
      ...draft,
      id: randomUUID(),
      jobId,
      createdAt: now(),
      updatedAt: now(),
      revision: 1,
      quality: issues.includes("审稿建议：reject") ? "rejected" : quality,
      issues,
      reviewNote: note,
      skillVersion: version,
      visibility: "private",
      decision: "pending" as const,
      archived: false,
    };
    return this.put("artifacts", a.id, a);
  }
  updateArtifact(input: {
    id: string;
    revision: number;
    draft?: unknown;
    visibility?: string;
    archived?: boolean;
    creationStatus?: Artifact["creationStatus"];
    decision?: Artifact["decision"];
    rejectReason?: string;
    platforms?: string[];
  }) {
    return this.transaction(() => {
      const a = this.get<Artifact>("artifacts", input.id);
      if (!a) throw new AppError("内容不存在", 404);
      if (a.revision !== input.revision)
        throw new AppError("内容已更新，请刷新后重试。", 409);
      if (input.creationStatus && !["inbox","planned","writing","published"].includes(input.creationStatus)) throw new AppError("无效创作状态");
      const draft = input.draft ? artifactSchema.parse(input.draft) : a;
      if (draft.kind !== a.kind) throw new AppError("不能更改内容类型");
      if (
        input.visibility === "public" &&
        (!["topic", "news"].includes(a.kind) ||
          decisionOf(a) !== "ready" ||
          input.draft)
      )
        throw new AppError(
          "只有通过质量检查的资讯或选题可公开；编辑后需重新分析。",
        );
      return this.put("artifacts", a.id, {
        ...a,
        ...draft,
        id: a.id,
        quality: input.draft ? "review" : a.quality,
        issues: input.draft ? ["人工编辑后的内容尚未重新分析。"] : a.issues,
        visibility: input.draft
          ? "private"
          : (input.visibility ?? a.visibility),
        creationStatus: input.creationStatus ?? a.creationStatus ?? "inbox",
        // 创作进度推进决策下限：planned→approved、writing→drafting、published→published；
        // 仅当决策仍为 pending（未显式拍板）时跟随，不覆盖人的否决/暂缓。
        decision: input.decision
          ? input.decision
          : a.decision && a.decision !== "pending"
            ? a.decision
            : input.creationStatus === "published"
              ? "published"
              : input.creationStatus === "writing"
                ? "drafting"
                : input.creationStatus === "planned"
                  ? "approved"
                  : "pending",
        decidedBy: input.decision && input.decision !== (a.decision ?? "pending") ? "human" : a.decidedBy,
        decidedAt: input.decision && input.decision !== (a.decision ?? "pending") ? now() : a.decidedAt,
        rejectReason: input.rejectReason ?? a.rejectReason,
        platforms: input.platforms ?? a.platforms,
        archived: input.archived ?? a.archived,
        revision: a.revision + 1,
        updatedAt: now(),
      });
    });
  }
  createConnection(name: string, scopes: string[] = ["submit"]) {
    const token = "dd_" + randomBytes(32).toString("hex");
    const c = {
      id: randomUUID(),
      name,
      digest: hash(token),
      scopes: scopes.filter((s) => ["submit", "read", "consume", "suggest"].includes(s)),
      createdAt: now(),
      lastUsedAt: null,
      revoked: false,
    };
    this.put("connections", c.id, c);
    return { id: c.id, name, scopes: c.scopes, token };
  }
  authenticate(token: string, scope: "submit" | "read" | "consume" | "suggest" = "submit", from?: string) {
    const digest = hash(token);
    const c = this.list<any>("connections").find(
      (c) =>
        !c.revoked &&
        timingSafeEqual(Buffer.from(c.digest), Buffer.from(digest)),
    );
    if (!c) throw new AppError("提交令牌无效或已撤销。", 401);
    // 旧连接无 scopes 字段：视为仅提交（与历史行为一致）
    if (!(c.scopes || ["submit"]).includes(scope))
      throw new AppError(`令牌无 ${scope} 权限；请在工作台创建对应权限的连接令牌。`, 403);
    // 回写 lastUsedAt / lastUsedFrom，距上次记录 >5 分钟才写库（防每个 GET 都写一次）。
    const stamp = now();
    if (!c.lastUsedAt || Date.parse(stamp) - Date.parse(c.lastUsedAt) > 5 * 60000) {
      c.lastUsedAt = stamp;
      c.lastUsedFrom = from || scope;
      this.put("connections", c.id, c);
    }
    return c;
  }
  // 消费标记：不删除原始记录，只加状态层；幂等；dryRun 只统计不写入。
  consumeIdentities(target: "hotspots" | "evidence", identities: string[], reason: string, consumedBy: string, producedRef?: string, dryRun = false) {
    let toConsume = 0, alreadyConsumed = 0;
    const run = (write: boolean) => {
      const stamp = now(), unconsumeUntil = new Date(Date.parse(stamp) + 30 * 86400000).toISOString();
      for (const identity of identities) {
        const id = `${target}:${identity}`;
        if (this.get("consumption", id)) { alreadyConsumed++; continue; }
        if (!write) { toConsume++; continue; }
        this.put("consumption", id, { target, identity, reason, producedRef: producedRef || null, consumedBy, consumedAt: stamp, unconsumeUntil });
        toConsume++;
      }
    };
    if (dryRun) run(false);
    else this.transaction(() => run(true));
    return { ok: true, dryRun, target, toConsume, alreadyConsumed,
      notice: "消费仅改变可见性与计数，不删除原始记录；30 天内可 unconsume。" };
  }
  unconsumeIdentities(target: "hotspots" | "evidence", identities: string[], dryRun = false) {
    let revived = 0, expired = 0;
    const stamp = now();
    const run = (write: boolean) => {
      for (const identity of identities) {
        const c = this.get<any>("consumption", `${target}:${identity}`);
        if (!c) continue;
        if (c.unconsumeUntil <= stamp) { expired++; continue; }
        if (write) this.del("consumption", `${target}:${identity}`);
        revived++;
      }
    };
    if (dryRun) run(false);
    else this.transaction(() => run(true));
    return { ok: dryRun || revived > 0, dryRun, target, revived, expired, notice: "超过 30 天撤销窗口的条目已软化处理，不再计入未消费。" };
  }
  intake(raw: unknown, connectionId: string) {
    const check=validateIntake(raw);
    if(!check.ok) throw new AppError("数据格式不符合协议："+check.errors.map(e=>`${e.path}: ${e.message}`).join("；"));
    const payload = intakeSchema.parse(raw);
    const digest = hash(JSON.stringify(payload));
    return this.transaction(() => {
      const old = this.db
        .prepare(
          "SELECT digest,receipt FROM submissions WHERE connection=? AND id=?",
        )
        .get(connectionId, payload.submissionId) as
        { digest: string; receipt: string } | undefined;
      if (old) {
        if (old.digest !== digest)
          throw new AppError("同一提交 ID 的内容不同，请使用新的 ID。", 409);
        return { ...JSON.parse(old.receipt), duplicate: true };
      }
      const aliases = new Map<string, string>();
      const evidence = payload.evidence.map((e, i) => {
        const saved = this.addEvidence(
          e,
          `${payload.producer.name}/${payload.producer.version}`,
        );
        if (e.id) {
          if (aliases.has(e.id)) throw new AppError("证据 ID 重复");
          aliases.set(e.id, saved.id);
        }
        aliases.set(String(i), saved.id);
        return saved;
      });
      const map = (ids: string[]) =>
        ids.map((id) => {
          const mapped = aliases.get(id);
          if (!mapped) throw new AppError("草稿引用了提交中不存在的证据。");
          return mapped;
        });
      const artifacts = payload.drafts.map((d) => {
        const mapped = {
          ...d,
          evidenceIds: map(d.evidenceIds),
          claims: d.claims.map((c) => ({
            ...c,
            evidenceIds: map(c.evidenceIds),
          })),
        };
        if (mapped.kind === "trend")
          mapped.details = {
            ...mapped.details,
            signalEvidenceIds: map(mapped.details.signalEvidenceIds),
          };
        return this.saveArtifact(
          mapped,
          "external-" + payload.submissionId,
          "review",
          ["外部工具提交，尚未通过工作台研究与审核。"],
        );
      });
      const receipt = {
        id: randomUUID(),
        submissionId: payload.submissionId,
        producer: payload.producer.name,
        receivedAt: now(),
        evidenceIds: evidence.map((e) => e.id),
        artifactIds: artifacts.map((a) => a.id),
        status: "pending-review",
        duplicate: false,
      };
      this.db
        .prepare("INSERT INTO submissions VALUES(?,?,?,?)")
        .run(
          connectionId,
          payload.submissionId,
          digest,
          JSON.stringify(receipt),
        );
      this.put("receipts", receipt.id, receipt);
      const c = this.get<any>("connections", connectionId);
      if (c) this.put("connections", c.id, { ...c, lastUsedAt: now() });
      return receipt;
    });
  }
  lock(id: string) {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM locks WHERE expires<?").run(Date.now());
      if (this.db.prepare("SELECT id FROM locks WHERE id=?").get(id))
        throw new AppError("当前讨论正在处理中。", 409);
      this.db
        .prepare("INSERT INTO locks VALUES(?,?)")
        .run(id, Date.now() + 240000);
    });
  }
  unlock(id: string) {
    this.db.prepare("DELETE FROM locks WHERE id=?").run(id);
  }
  renewLock(id: string) {
    this.db.prepare("UPDATE locks SET expires=? WHERE id=?").run(Date.now() + 240000, id);
  }
  // ---- 决策层（quality=证据可信度由 AI 判；decision=要不要写由人拍板。两层永不互相推导）----
  decisionTarget(id: string): { collection: "artifacts" | "outlines" | "decisions"; row: any } {
    for (const collection of ["artifacts", "outlines", "decisions"] as const) {
      const row = this.get<any>(collection, id);
      if (row) return { collection, row };
    }
    throw new AppError("决策对象不存在", 404);
  }
  // 拍板。联动规则（P3）：rejected/published 自动消费该产物证据对应的热榜；
  // approved/drafting/deferred 不消费（避免把待办藏起来）。手动题（decisions）无热榜映射，不消费。
  setDecision(id: string, input: { decision: string; platforms?: string[]; rejectReason?: string; publishedRef?: string; decidedBy?: "human" | "agent" }) {
    const { collection, row } = this.decisionTarget(id);
    if (collection === "artifacts" && row.archived) throw new AppError("已归档产物不可再拍板。");
    const next: any = {
      ...row,
      decision: input.decision,
      decidedBy: input.decidedBy ?? "human",
      decidedAt: now(),
      ...(input.platforms ? { platforms: input.platforms } : {}),
      ...(input.rejectReason !== undefined ? { rejectReason: input.rejectReason } : {}),
      ...(input.publishedRef !== undefined ? { publishedRef: input.publishedRef } : {}),
    };
    if (collection === "artifacts") { next.revision = (row.revision ?? 0) + 1; next.updatedAt = now(); }
    this.put(collection, id, next);
    // 联动消费：rejected/published 时消费对应条目（P0-2 返工：按形态分支）。
    // artifacts 的 evidenceIds 是 ev-xxx 证据 ID（去 evidence 集合拿 url）；
    // outlines 的 evidenceRefs 直接就是热点 url（urlKey 归一化后即消费身份）。
    if (input.decision === "rejected" || input.decision === "published") {
      const idset = new Set<string>();
      for (const ref of row.evidenceIds || row.evidenceRefs || []) {
        if (/^https?:\/\//i.test(ref)) {
          try { idset.add(urlKey(ref)); } catch { /* 非 https 跳过 */ }
        } else {
          const e = this.get<any>("evidence", ref);
          if (e?.url) { try { idset.add(urlKey(e.url)); } catch { /* 跳过 */ } }
        }
      }
      const ids = [...idset];
      let consumedCount = 0;
      if (ids.length) {
        if (input.decision === "published") {
          const r = this.consumeIdentities("hotspots", ids, "processed-into-artifact", "decision", next.publishedRef, false);
          consumedCount = r.toConsume;
        } else {
          const map: Record<string, string> = { "no-ai-signal": "no-ai-signal", "off-domain": "off-domain", "已写过": "processed-into-artifact", "写不透": "no-ai-signal", "不感兴趣": "off-domain", "其他": "no-ai-signal" };
          const r = this.consumeIdentities("hotspots", ids, map[next.rejectReason || "其他"] || "no-ai-signal", "decision", undefined, false);
          consumedCount = r.toConsume;
        }
      }
      next.consumedCount = consumedCount;
    }
    return next;
  }
  // 建议（suggestions）多源并存、互不覆盖：内置 AI 与外部 Agent 都只能写这里，不能直接改 decision。
  addSuggestion(id: string, suggestion: { by: string; verdict: string; score?: number; platforms?: string[]; reason?: string }) {
    const { collection, row } = this.decisionTarget(id);
    if (row.archived) throw new AppError("已归档产物不再接受建议。");
    const suggestions = [...(row.suggestions || []), { ...suggestion, at: now() }];
    this.put(collection, id, { ...row, suggestions });
    return this.get<any>(collection, id);
  }
  // 决策队列：产物 + 大纲 + 手动题合并（决策挂在原条目上；手动题是唯一的独立记录形态）。
  decisionsQueue(status?: string) {
    const rows: any[] = [];
    for (const a of this.list<any>("artifacts")) {
      if (a.archived || (a.kind as string) === "person") continue;
      rows.push({ sourceType: "artifact", id: a.id, kind: a.kind, title: a.title, summary: a.summary, quality: a.quality || "review", evidenceQuality: a.quality || "review",
        decision: a.decision || "pending", platforms: a.platforms, suggestions: a.suggestions, rejectReason: a.rejectReason,
        publishedRef: a.publishedRef, draftBody: a.draftBody, createdAt: a.createdAt, evidenceCount: (a.evidenceIds || []).length });
    }
    for (const o of this.list<any>("outlines"))
      rows.push({ sourceType: "outline", id: o.id, kind: o.contentType, title: o.title, summary: (o.keyPoints || []).join("；"), clusterId: o.clusterId,
        decision: o.decision, platforms: [o.platform], suggestions: o.suggestions, rejectReason: o.rejectReason, publishedRef: o.publishedRef, producedBy: o.producedBy, draftBody: o.draftBody, createdAt: o.createdAt });
    for (const d of this.list<any>("decisions"))
      rows.push({ sourceType: "manual", id: d.id, kind: "manual", title: d.title, summary: d.notes, decision: d.decision,
        platforms: d.platforms, suggestions: d.suggestions, rejectReason: d.rejectReason, publishedRef: d.publishedRef, producedBy: d.producedBy || "human", draftBody: d.draftBody, createdAt: d.createdAt });
    return rows.filter((r) => !status || r.decision === status)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  decisionsStats() {
    const rows = this.decisionsQueue();
    const byDecision: Record<string, number> = {}, byRejectReason: Record<string, number> = {}, byPlatform: Record<string, number> = {};
    for (const r of rows) {
      byDecision[r.decision] = (byDecision[r.decision] || 0) + 1;
      if (r.decision === "rejected" && r.rejectReason) byRejectReason[r.rejectReason] = (byRejectReason[r.rejectReason] || 0) + 1;
      for (const p of r.platforms || []) byPlatform[p] = (byPlatform[p] || 0) + 1;
    }
    const decided = rows.filter((r) => r.decision !== "pending").length;
    const positive = rows.filter((r) => ["approved", "drafting", "published"].includes(r.decision)).length;
    return { total: rows.length, byDecision, byRejectReason, byPlatform, passRate: decided ? +(positive / decided).toFixed(3) : null };
  }
}
let singleton: Store | undefined;
export function store() {
  return (singleton ??= new Store());
}
