// agent 读接口的列表分页与 consume filter 路径的游标解码。
// limit 夹在 1-100（默认 20）；cursor 为明文偏移量；消费游标为 base64 JSON {offset}。
export function paginated(rows: any[], searchParams: URLSearchParams) {
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit")) || 20));
  const offset = Number(searchParams.get("cursor")) || 0;
  const page = rows.slice(offset, offset + limit);
  const next = offset + limit < rows.length ? String(offset + limit) : undefined;
  return { items: page, nextCursor: next, total: rows.length };
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
