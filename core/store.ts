import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  createHash,
  randomUUID,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { defaultConfig, defaultPlans, defaultSources } from "./defaults";
import { recordHistory, metricComparison, type MetricSnapshot } from "./history";
import { decisionOf } from "./research-policy";
import { validateIntake } from "./intake-validation";
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
  ) {
    super(message);
  }
}
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
    return { ...c, hasApiKey: !!apiKey, hasTavilyKey: !!tavilyKey };
  }
  snapshot() {
    const metrics = this.list<MetricSnapshot>("metrics");
    return {
      config: this.publicConfig(),
      plans: this.list<Plan>("plans").sort((a, b) =>
        a.dailyTime.localeCompare(b.dailyTime),
      ),
      sources: this.list<Source>("sources"),
      artifacts: this.list<Artifact>("artifacts").filter((a) => !a.archived).map(a => ({...a, quality: decisionOf(a)})),
      events: this.list("events"),
      metrics: metrics.map(m => ({...m, comparison: metricComparison(metrics, m)})),
      evidence: this.list<Evidence>("evidence").slice(0, 300),
      jobs: this.list<Job>("jobs").slice(0, 40),
      connections: this.list<any>("connections").map(({ digest, ...v }) => v),
      conversations: this.list<any>("conversations").map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        artifactId: c.artifactId,
        messageCount: c.messages.length,
      })),
      worker: this.get("meta", "worker"),
      submissions: this.list<any>("receipts").slice(0, 30).map(r=>({...r,jobs:this.list<Job>("jobs").filter(j=>j.receiptId===r.id || (!j.receiptId && j.external && j.evidenceIds.length===r.evidenceIds.length && j.evidenceIds.every(id=>r.evidenceIds.includes(id))))})),
      budget: this.dayBudget(),
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
  enqueue(planId: string, evidenceIds: string[] = [], scheduledKey?: string, receiptId?: string, retry = false) {
    return this.transaction(() => {
      if (receiptId) {
        const receipt=this.get<any>("receipts",receiptId);
        if(!receipt) throw new AppError("收件回执不存在",404);
        evidenceIds=receipt.evidenceIds;
        const old=this.list<Job>("jobs").find(j=>j.planId===planId && (j.receiptId===receiptId || (!j.receiptId && j.external && j.evidenceIds.length===evidenceIds.length && j.evidenceIds.every(id=>evidenceIds.includes(id)))));
        if(old && (!retry || !["failed","cancelled"].includes(old.state))) return old;
      }
      const plan = this.get<Plan>("plans", planId);
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
      saved: false,
      archived: false,
    };
    return this.put("artifacts", a.id, a);
  }
  updateArtifact(input: {
    id: string;
    revision: number;
    draft?: unknown;
    saved?: boolean;
    visibility?: string;
    archived?: boolean;
  }) {
    return this.transaction(() => {
      const a = this.get<Artifact>("artifacts", input.id);
      if (!a) throw new AppError("内容不存在", 404);
      if (a.revision !== input.revision)
        throw new AppError("内容已更新，请刷新后重试。", 409);
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
        saved: input.saved ?? a.saved,
        archived: input.archived ?? a.archived,
        revision: a.revision + 1,
        updatedAt: now(),
      });
    });
  }
  createConnection(name: string) {
    const token = "dd_" + randomBytes(32).toString("hex");
    const c = {
      id: randomUUID(),
      name,
      digest: hash(token),
      createdAt: now(),
      lastUsedAt: null,
      revoked: false,
    };
    this.put("connections", c.id, c);
    return { id: c.id, name, token };
  }
  authenticate(token: string) {
    const digest = hash(token);
    const c = this.list<any>("connections").find(
      (c) =>
        !c.revoked &&
        timingSafeEqual(Buffer.from(c.digest), Buffer.from(digest)),
    );
    if (!c) throw new AppError("提交令牌无效或已撤销。", 401);
    return c;
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
}
let singleton: Store | undefined;
export function store() {
  return (singleton ??= new Store());
}
