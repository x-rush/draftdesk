// Store 组合根：六域模块（kv/auth/consumption/decisions/jobs/budget）+ 跨域聚合方法
// （config/snapshot/intake/证据与产物落库）。对外类名、方法签名与拆分前的单体 Store
// 完全一致——http/routes、pipeline、worker、scripts、tests 的调用面零改动。
import { randomUUID } from "node:crypto";
import path from "node:path";
import { activityStatus } from "../activities";
import type { DiscoveryRecord } from "../discovery";
import { hotspotFeed } from "../hotspots";
import { recordHistory, metricComparison, type MetricSnapshot } from "../history";
import { decisionOf } from "../research-policy";
import { validateIntake } from "../intake-validation";
import { consumptionSummary, consumptionHotspotKeys } from "../agent-read";
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
} from "../schema";
// AppError/ERROR_CODES 真身在 ../errors（领域层共用，避免反向依赖传输层）；此处 re-export 保持既有 import 面不变。
import { AppError, ERROR_CODES } from "../errors";
export { AppError, ERROR_CODES };
import { hash, now, canonicalUrl } from "./helpers";
export { hash, now, canonicalUrl };
import { KV } from "./kv";
import { runMigrations } from "./migrations";
import { createAuth, type Auth } from "./auth";
import { createConsumption, type Consumption } from "./consumption";
import { createDecisions, type Decisions } from "./decisions";
import { createJobs, type Jobs } from "./jobs";
import { createBudget, type Budget } from "./budget";

export class Store {
  kv: KV;
  /** 兼容字段：拆分前 Store.db 公开可访问（sources.ts、回归测试直接使用） */
  get db() {
    return this.kv.db;
  }
  private _auth: Auth;
  private _consumption: Consumption;
  private _decisions: Decisions;
  private _jobs: Jobs;
  private _budget: Budget;
  constructor(
    directory = process.env.DRAFTDESK_DATA_DIR ||
      path.join(process.cwd(), "data"),
  ) {
    this.kv = new KV(directory);
    runMigrations({ kv: this.kv, directory });
    this._auth = createAuth(this.kv);
    this._consumption = createConsumption(this.kv);
    this._decisions = createDecisions(this.kv, this._consumption.consumeIdentities, this._consumption.unconsumeIdentities);
    this._jobs = createJobs(this.kv, () => this.config());
    this._budget = createBudget(this.kv, () => this.config());
  }
  close() {
    this.kv.close();
  }
  transaction<T>(fn: () => T): T {
    return this.kv.transaction(fn);
  }
  get<T>(collection: string, id: string): T | undefined {
    return this.kv.get<T>(collection, id);
  }
  list<T>(collection: string): T[] {
    return this.kv.list<T>(collection);
  }
  put<T>(collection: string, id: string, value: T) {
    return this.kv.put<T>(collection, id, value);
  }
  del(collection: string, id: string) {
    return this.kv.del(collection, id);
  }
  createConnection(name: string, scopes: string[] = ["submit"]) {
    return this._auth.createConnection(name, scopes);
  }
  authenticate(token: string, scope: "submit" | "read" | "consume" | "suggest" = "submit", from?: string) {
    return this._auth.authenticate(token, scope, from);
  }
  consumeIdentities(target: "hotspots" | "evidence", identities: string[], reason: string, consumedBy: string, producedRef?: string, dryRun = false) {
    return this._consumption.consumeIdentities(target, identities, reason, consumedBy, producedRef, dryRun);
  }
  unconsumeIdentities(target: "hotspots" | "evidence", identities: string[], dryRun = false) {
    return this._consumption.unconsumeIdentities(target, identities, dryRun);
  }
  decisionTarget(id: string): { collection: "artifacts" | "outlines" | "decisions"; row: any } {
    return this._decisions.decisionTarget(id);
  }
  setDecision(id: string, input: { decision: string; platforms?: string[]; rejectReason?: string; publishedRef?: string; decidedBy?: "human" | "agent" }) {
    return this._decisions.setDecision(id, input);
  }
  addSuggestion(id: string, suggestion: { by: string; verdict: string; score?: number; platforms?: string[]; reason?: string }) {
    return this._decisions.addSuggestion(id, suggestion);
  }
  decisionsQueue(status?: string) {
    return this._decisions.decisionsQueue(status);
  }
  decisionsStats() {
    return this._decisions.decisionsStats();
  }
  enqueue(planId: string, evidenceIds: string[] = [], scheduledKey?: string, receiptId?: string, retry = false, targetKeywords?: string[]) {
    return this._jobs.enqueue(planId, evidenceIds, scheduledKey, receiptId, retry, targetKeywords);
  }
  claim() {
    return this._jobs.claim();
  }
  patchJob(id: string, patch: Partial<Job>) {
    return this._jobs.patchJob(id, patch);
  }
  step(id: string, name: string, state: string, detail: string) {
    return this._jobs.step(id, name, state, detail);
  }
  lock(id: string) {
    return this._jobs.lock(id);
  }
  unlock(id: string) {
    return this._jobs.unlock(id);
  }
  renewLock(id: string) {
    return this._jobs.renewLock(id);
  }
  dayBudget() {
    return this._budget.dayBudget();
  }
  reserve(tokens: number) {
    return this._budget.reserve(tokens);
  }
  settleReservation(day: string, reservation: number, usage: number, jobId?: string) {
    return this._budget.settleReservation(day, reservation, usage, jobId);
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
      artifacts: this.list<Artifact>("artifacts").filter((a) => !a.archived && (a.kind as string) !== "person").map((a) => ({ ...a, quality: decisionOf(a) })),
      events: this.list("events"),
      metrics: metrics.map((m) => ({ ...m, comparison: metricComparison(metrics, m) })),
      evidence: this.list<Evidence>("evidence"),
      discovery: this.list<DiscoveryRecord>("discovery").filter((d) => d.at >= new Date(Date.now() - 14 * 86400000).toISOString()).sort((a, b) => b.at.localeCompare(a.at)),
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
      submissions: this.list<any>("receipts").map((r) => ({ ...r, jobs: allJobs.filter((j) => j.receiptId === r.id || (!j.receiptId && j.external && j.evidenceIds.length === r.evidenceIds.length && j.evidenceIds.every((id) => r.evidenceIds.includes(id)))) })),
      budget: this.dayBudget(),
    };
    if (!params) return { ...snapshot, discovery: snapshot.discovery.slice(0, 5), evidence: snapshot.evidence.slice(0, 300), jobs: snapshot.jobs.slice(0, 40), submissions: snapshot.submissions.slice(0, 30) };
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(params.get("pageSize"))) || 20));
    const paginate = <T,>(items: T[], key: string) => {
      const pages = Math.max(1, Math.ceil(items.length / pageSize));
      const page = Math.min(pages, Math.max(1, Math.floor(Number(params.get(key)) || 1)));
      return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: items.length, pages };
    };
    const view = params.get("view") || "discover", kind = params.get("kind") || "all", quality = params.get("quality") || "active";
    const activityTime = params.get("activityTime") || (view === "activities" ? "actionable" : "all");
    const query = (params.get("q") || "").trim().toLocaleLowerCase();
    const artifacts = paginate(snapshot.artifacts.filter((a) =>
      (view !== "library" || ["approved", "drafting", "published"].includes(a.decision || "pending")) &&
      (!params.get("jobId") || a.jobId === params.get("jobId")) &&
      (!params.get("creation") || params.get("creation") === "all" || (a.creationStatus || "inbox") === params.get("creation")) && (view !== "trends" || a.kind === "trend") &&
      (view !== "activities" || a.kind === "activity") &&
      (a.kind !== "activity" || ((!params.get("activityPlatform") || params.get("activityPlatform") === "all" || a.details.platform === params.get("activityPlatform")) && (activityTime === "all" || (activityTime === "actionable" ? (activityStatus(a) === "ongoing" || activityStatus(a) === "upcoming") : activityStatus(a) === activityTime)))) && (view !== "ideas" || a.kind === "idea") &&
      (view !== "discover" || kind === "all" || a.kind === kind) &&
      (quality === "all" || (quality === "active" ? a.quality !== "rejected" : a.quality === quality)) &&
      [a.title, a.summary, a.audience, ...a.tags].join(" ").toLocaleLowerCase().includes(query)), "page");
    const jobs = paginate(snapshot.jobs.filter((j) => !params.get("runId") || j.id === params.get("runId")), "jobsPage"), submissions = paginate(snapshot.submissions, "receiptsPage");
    const counts: Record<string, number> = {};
    snapshot.artifacts.forEach((a) => (counts[a.kind] = (counts[a.kind] || 0) + 1));
    const researchDiscovery = snapshot.discovery.filter((d) => d.mode !== "hotspot");
    const qualityCounts = { ready: 0, review: 0, rejected: 0 };
    snapshot.artifacts.forEach((a) => { if (a.quality in qualityCounts) qualityCounts[a.quality as keyof typeof qualityCounts]++; });
    const consumedHotspotKeys = new Set(consumptionHotspotKeys(this));
    const hotspotSummary = hotspotFeed(snapshot.discovery, new URLSearchParams("hotspotConsumed=include"), 1, consumedHotspotKeys);
    const hotspotConsumption = consumptionSummary(this, "hotspots");
    return { ...snapshot, discovery: params.get("jobId") ? researchDiscovery.find((d) => d.jobId === params.get("jobId")) || null : researchDiscovery[0] || null,
      hotspots: view === "hotspots" ? hotspotFeed(snapshot.discovery, params, pageSize, consumedHotspotKeys) : null, artifacts: artifacts.items, jobs: jobs.items,
      submissions: submissions.items.map((r) => ({ ...r, artifacts: snapshot.artifacts.filter((a) => r.artifactIds?.includes(a.id) || r.jobs.some((j: Job) => j.id === a.jobId)) })),
      evidence: snapshot.evidence.filter((e) => artifacts.items.some((a) => a.evidenceIds.includes(e.id))),
      events: [], metrics: [],
      jobActivity: snapshot.jobs.filter((j) => ["queued", "running"].includes(j.state)).concat(snapshot.jobs.filter((j) => !["queued", "running"].includes(j.state)).slice(0, 50)).map((j) => ({ id: j.id, state: j.state, createdAt: j.createdAt, name: j.plan?.name || "研究任务", total: snapshot.artifacts.filter((a) => a.jobId === j.id).length, review: snapshot.artifacts.filter((a) => a.jobId === j.id && a.quality === "review").length })),
      stats: { artifacts: snapshot.artifacts.length, review: qualityCounts.review, qualityCounts, hotspotTotal: hotspotSummary.total, hotspotRemaining: hotspotConsumption.remaining, hotspotConsumed: hotspotConsumption.consumed, sourceFailures: hotspotSummary.sourceHealth.filter((s) => s.status === "failed").length, failedRuns: snapshot.jobs.filter((j) => j.state === "failed").length, counts,
        running: snapshot.jobs.filter((j) => ["queued", "running"].includes(j.state)).length,
        activePlanIds: snapshot.jobs.filter((j) => ["queued", "running"].includes(j.state)).map((j) => j.planId) },
      pagination: { artifacts: { ...artifacts, items: undefined }, jobs: { ...jobs, items: undefined }, submissions: { ...submissions, items: undefined } }
    };
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
    return this.kv.transaction(() => {
      const a = this.get<Artifact>("artifacts", input.id);
      if (!a) throw new AppError("内容不存在", 404);
      if (a.revision !== input.revision)
        throw new AppError("内容已更新，请刷新后重试。", 409);
      if (input.creationStatus && !["inbox", "planned", "writing", "published"].includes(input.creationStatus)) throw new AppError("无效创作状态");
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
  intake(raw: unknown, connectionId: string) {
    const check = validateIntake(raw);
    if (!check.ok) throw new AppError("数据格式不符合协议：" + check.errors.map((e) => `${e.path}: ${e.message}`).join("；"));
    const payload = intakeSchema.parse(raw);
    const digest = hash(JSON.stringify(payload));
    return this.kv.transaction(() => {
      const old = this.kv.db
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
      this.kv.db
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
}
let singleton: Store | undefined;
export function store() {
  return (singleton ??= new Store());
}
