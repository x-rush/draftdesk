import { AppError } from "../errors";

export const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

export function checkRequest(req: Request) {
  const host = (req.headers.get("host") || new URL(req.url).host).toLowerCase();
  const name = host.split(":")[0];
  if (
    ![
      "localhost",
      "127.0.0.1",
      ...(process.env.DRAFTDESK_ALLOWED_HOSTS || "").split(","),
    ].includes(name)
  )
    throw new AppError("此实例仅接受配置的工作台域名。", 403);
  const origin = req.headers.get("origin");
  if (origin && !["http://" + host, "https://" + host].includes(origin))
    throw new AppError("拒绝跨站请求。", 403);
  if (req.headers.get("sec-fetch-site") === "cross-site")
    throw new AppError("拒绝跨站请求。", 403);
}

export async function body(req: Request, maxLength = 1000000) {
  if (!req.headers.get("content-type")?.includes("application/json"))
    throw new AppError("请求需使用 application/json。", 415);
  const reader = req.body?.getReader();
  if (!reader) throw new AppError("缺少请求正文");
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > maxLength) {
      await reader.cancel();
      throw new AppError("请求超过 1 MB。", 413);
    }
    chunks.push(part.value);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assertNoReplacementChar(parsed);
    return parsed;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("JSON 格式无效。");
  }
}

// U+FFFD 是编码损坏的确定性标志（GBK→UTF-8 转换残段）：任何写入口的请求文本
// 携带它一律 400，防止乱码入库。读路径不受影响（存量乱码由迁移修复）。
function assertNoReplacementChar(value: unknown) {
  if (typeof value === "string") {
    if (value.includes("\uFFFD"))
      throw new AppError("请求文本包含无效字符（U+FFFD，疑似编码错误）；请以 UTF-8 重新提交。", 400);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) assertNoReplacementChar(v);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) assertNoReplacementChar(v);
  }
}

// participants 服务端强制：enabled=false → 写入 403 SOURCE_DISABLED；canWrite=false → 写入 403 PERMISSION_DENIED。
// 未登记的来源默认放行（向后兼容）。
export function enforceParticipants(db: any, connection: { name: string }) {
  const participants = db.get("config", "participants");
  const producerKey = `agent:${connection.name}`;
  const pCfg = participants?.[producerKey];
  if (pCfg?.enabled === false)
    throw new AppError(`来源已停用：${producerKey}（participants.enabled=false）`, 403, "SOURCE_DISABLED");
  if (pCfg?.canWrite === false)
    throw new AppError(`来源只读：${producerKey}（participants.canWrite=false）`, 403, "PERMISSION_DENIED");
}
