// 文档存取内核：documents 单表 KV + 四张子系统表（submissions/schedules/budgets/locks）。
// 上层模块（auth/consumption/decisions/jobs/budget）全部经它读写，不再直接摸 DatabaseSync 之外的路径。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export class KV {
  db: DatabaseSync;
  readonly directory: string;
  constructor(
    directory = process.env.DRAFTDESK_DATA_DIR ||
      path.join(process.cwd(), "data"),
  ) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, "draftdesk.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS documents(collection TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(collection,id));
   CREATE TABLE IF NOT EXISTS submissions(connection TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(connection,id));
   CREATE TABLE IF NOT EXISTS schedules(key TEXT PRIMARY KEY,job_id TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS budgets(day TEXT PRIMARY KEY,reserved INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS locks(id TEXT PRIMARY KEY,expires INTEGER NOT NULL);
  `);
    this.ensureHotPathIndexes();
  }
  // ---- 性能下推基座（R10.38）：高频过滤字段的 VIRTUAL 生成列 + 复合索引 ----
  // 背景：db.list = 取集合全部行逐行 JSON.parse——seen-terms 18312 行 52-75ms/次，
  // 夜间挖掘链 4-5 个 tick 各自全扫。生成列让「按字段过滤/排序」在 SQLite C 层完成，
  // 只把命中行的 body 交给 JS。VIRTUAL 零迁移成本（不重写表），写成本=每次 put 多几次
  // C 级 json_extract + 索引维护（微秒级）；查询不命中索引时最多退化回原行为，不炸。
  // 列名与 body 字段同名；首建索引需扫一次全表（46MB 活库秒级，仅首次部署那一次）。
  private ensureHotPathIndexes() {
    // 注意：table_info 隐藏生成列（SQLite 3.54 实测 hidden=2），幂等检查必须用 table_xinfo——
    // 否则重开时误判列缺失，ALTER 抛 duplicate column（曾引发全部重开型测试雪崩）。
    const cols = new Set((this.db.prepare("PRAGMA table_xinfo(documents)").all() as Array<{ name: string }>).map((c) => c.name));
    const generated: Array<[string, string]> = [
      ["decision", "$.decision"], ["createdAt", "$.createdAt"], ["clusterId", "$.clusterId"],
      ["status", "$.status"], ["category", "$.category"], ["at", "$.at"], ["relevance", "$.relevance"], ["jobId", "$.jobId"],
    ];
    for (const [name, path] of generated)
      if (!cols.has(name))
        this.db.exec(`ALTER TABLE documents ADD COLUMN "${name}" TEXT GENERATED ALWAYS AS (json_extract(body,'${path}')) VIRTUAL`);
    this.db.exec(`
   CREATE INDEX IF NOT EXISTS idx_doc_decision ON documents(collection,"decision");
   CREATE INDEX IF NOT EXISTS idx_doc_created ON documents(collection,"createdAt");
   CREATE INDEX IF NOT EXISTS idx_doc_cluster ON documents(collection,"clusterId");
   CREATE INDEX IF NOT EXISTS idx_doc_status ON documents(collection,"status");
   CREATE INDEX IF NOT EXISTS idx_doc_category ON documents(collection,"category");
   CREATE INDEX IF NOT EXISTS idx_doc_at ON documents(collection,"at");
   CREATE INDEX IF NOT EXISTS idx_doc_relevance ON documents(collection,"relevance");
   CREATE INDEX IF NOT EXISTS idx_doc_job ON documents(collection,"jobId");
  `);
  }
  close() {
    // 幂等：双关（异常路径的 finally 兜底）不抛，避免掩盖原始错误
    try {
      // R10.38：checkpoint(TRUNCATE) 同步清零 WAL——Windows 下 close 后 -wal/-shm 句柄
      // 释放有延迟（测试 finally rmSync 曾 EPERM），先清 WAL 消除竞态窗口。
      try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* 忙时跳过：close 兜底 */ }
      this.db.close();
    } catch (e) {
      if (!/not open/i.test(String(e))) throw e;
    }
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
  // ---- SQL 助手（PHASE 4）：排序/聚合/截取在 SQLite C 层完成，只把目标行交给 JS，
  // 避免整表 JSON.parse。field/direction 只接受内部常量，不拼外部输入。 ----
  listPaged<T>(collection: string, opts: { limit: number; offset: number; orderBy?: string; direction?: "ASC" | "DESC" }): { items: T[]; total: number } {
    const field = opts.orderBy || "createdAt";
    const dir = opts.direction === "ASC" ? "ASC" : "DESC";
    const total = (this.db.prepare("SELECT COUNT(*) c FROM documents WHERE collection=?").get(collection) as { c: number }).c;
    const rows = this.db
      .prepare(`SELECT body FROM documents WHERE collection=? ORDER BY json_extract(body,'$.${field}') ${dir} LIMIT ? OFFSET ?`)
      .all(collection, opts.limit, opts.offset) as Array<{ body: string }>;
    return { items: rows.map((r) => JSON.parse(r.body)), total };
  }
  // 追加式集合的最新一条（rowid 定位）。注意：不能用 ORDER BY json_extract(field)——
  // 那要把整集合的大 JSON 全部解析一遍再排序（discovery 上实测 207ms/次）；
  // rowid DESC 一次定位。仅适用于「写入即最新」的集合（discovery：at=写入时刻、新 uuid）。
  latestInserted<T>(collection: string): T | undefined {
    const row = this.db
      .prepare("SELECT body FROM documents WHERE collection=? ORDER BY rowid DESC LIMIT 1")
      .get(collection) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  // 热路径语句缓存：zone/分页 SQL 每请求重复编译浪费 3-6ms/条；按 SQL 串缓存已编译语句。
  private stmtCache = new Map<string, { all(...params: any[]): unknown[] }>();
  private prepared(sql: string) {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }
  sqlRows(sql: string, ...params: any[]): Array<Record<string, unknown>> {
    // node:sqlite 参数不足时静默错位绑定（占位符吃到相邻实参，曾致列表恒空而计数正常）
    // ——显式断言参数个数把这类 bug 变成响亮报错。node:sqlite 无 parameterCount 属性，
    // 用 SQL 文本统计问号（内部 SQL 的问号只出现在占位符位置）。
    const expected = (sql.match(/\?/g) || []).length;
    if (params.length !== expected)
      throw new Error(`SQL 参数个数不匹配：绑定 ${params.length}，占位符 ${expected}——${sql.slice(0, 120)}`);
    return this.prepared(sql).all(...params) as Array<Record<string, unknown>>;
  }
  // 下推查询（R10.38）：WHERE 片段引用生成列（带引号标识符），值全走参数绑定——
  // where 只允许代码内常量字符串，禁止拼接外部输入。命中生成列索引时 SQL 层过滤，
  // 只 parse 命中行；未命中索引（列不在生成列清单内）时退化为全集合扫描，行为等价。
  selectWhere<T>(collection: string, where: string, ...params: unknown[]): Array<{ id: string; body: T }> {
    return (this.sqlRows(`SELECT id, body FROM documents WHERE collection=? AND (${where})`, collection, ...params) as Array<{ id: string; body: string }>)
      .map((r) => ({ id: r.id, body: JSON.parse(r.body) as T }));
  }
}
