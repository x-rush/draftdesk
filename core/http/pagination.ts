// agent 读接口的列表分页与 consume filter 路径的游标解码。
// limit 夹在 1-100（默认 20）；cursor 为明文偏移量；消费游标为 base64 JSON {offset}。
import type { KV } from "../store/kv";

// SQL 分页版（PHASE 4）：排序与截取下沉 SQLite，响应形状与内存版完全一致
export function paginatedSql(kv: KV, collection: string, searchParams: URLSearchParams) {
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit")) || 20));
  const offset = Number(searchParams.get("cursor")) || 0;
  const { items, total } = kv.listPaged(collection, { limit, offset, orderBy: "createdAt", direction: "DESC" });
  return { items, nextCursor: offset + limit < total ? String(offset + limit) : undefined, total };
}

export function decodeConsumeCursor(raw?: string): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    return Number.isInteger(parsed?.offset) && parsed.offset >= 0 ? parsed.offset : 0;
  } catch {
    return 0;
  }
}
