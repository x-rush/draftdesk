// 归档读写口（R10.37 B-2）：兑现 R10.34「可查可恢复」承诺的另一半。
// 读口 GET /archives（总览）与 GET /archives/:collection（分页只读，白名单集合）；
// 恢复端点 POST /archives/:collection/:id/restore——归档行移回主集合
//（剥 archivedAt/expiredReason/archivedReason，其余原样），主集合同 id 冲突 400。
// UI 入口在「设置→数据」归档管理卡片。
import type { RouteDef } from "../http/router";
import { json } from "../http/middleware";
import { AppError, now } from "../store";

// 归档集合 → 主集合映射（恢复落点）
export const ARCHIVE_TARGETS: Record<string, string> = {
  "outlines-archive": "outlines",
  "artifacts-archive": "artifacts",
  "decisions-archive": "decisions",
  "outlines-merge-archive": "outlines", // R10.35 迁移归档：本质是大纲行
  "opportunities-archive": "opportunities",
};

function rowsOf(db: any, collection: string) {
  return db.db.prepare(`SELECT id, body FROM documents WHERE collection='${collection}' ORDER BY id`).all() as Array<{ id: string; body: string }>;
}

export const routes: RouteDef[] = [
  {
    // 总览：各归档集合行数（设置页归档管理卡片第一屏）
    methods: ["GET"],
    pattern: "archives",
    handler: ({ db }) => {
      const items = Object.keys(ARCHIVE_TARGETS).map((collection) => ({
        collection,
        count: rowsOf(db, collection).length,
      }));
      return json({ items });
    },
  },
  {
    methods: ["GET"],
    pattern: "archives/:collection",
    handler: ({ db, params, query }) => {
      const collection = params.collection;
      if (!(collection in ARCHIVE_TARGETS)) throw new AppError(`未知归档集合「${collection}」；允许值：${Object.keys(ARCHIVE_TARGETS).join(", ")}。`, 404, "ARCHIVE_UNKNOWN");
      const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
      const offset = Math.max(Number(query.get("offset")) || 0, 0);
      const all = rowsOf(db, collection);
      const page = all.slice(offset, offset + limit).map((r) => {
        const body = JSON.parse(r.body);
        return {
          id: r.id, title: body.title || body.topic || r.id, decision: body.decision, createdAt: body.createdAt,
          archivedAt: body.archivedAt, expiredReason: body.expiredReason, platform: body.platform, platforms: body.platforms,
        };
      });
      return json({ collection, total: all.length, limit, offset, items: page });
    },
  },
  {
    methods: ["POST"],
    pattern: "archives/:collection/:id/restore",
    handler: ({ db, params }) => {
      const collection = params.collection;
      if (!(collection in ARCHIVE_TARGETS)) throw new AppError(`未知归档集合「${collection}」；允许值：${Object.keys(ARCHIVE_TARGETS).join(", ")}。`, 404, "ARCHIVE_UNKNOWN");
      const row = db.get<any>(collection, params.id);
      if (!row) throw new AppError("归档条目不存在。", 404, "ARCHIVE_NOT_FOUND");
      const target = ARCHIVE_TARGETS[collection];
      if (db.get(target, params.id)) throw new AppError(`主集合已存在同 id 条目（${params.id}），恢复会覆盖——请先处理冲突。`, 409, "ARCHIVE_RESTORE_CONFLICT");
      const { archivedAt, expiredReason, archivedReason, ...rest } = row;
      const restored = { ...rest, restoredAt: now() };
      db.put(target, params.id, restored);
      db.del(collection, params.id);
      return json({ ok: true, restoredTo: target, id: params.id, row: restored });
    },
  },
];
