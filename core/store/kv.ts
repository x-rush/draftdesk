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
}
