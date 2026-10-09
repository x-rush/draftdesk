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
  }
  close() {
    // 幂等：双关（异常路径的 finally 兜底）不抛，避免掩盖原始错误
    try {
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
  sqlRows(sql: string, ...params: any[]): Array<Record<string, unknown>> {
    return this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  }
}
