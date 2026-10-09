// 稳定错误码枚举：外部 Agent 靠 code 判断而非读中文字符串。
export const ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  TARGET_MISMATCH: "TARGET_MISMATCH",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  SOURCE_DISABLED: "SOURCE_DISABLED",
  NOT_FOUND: "NOT_FOUND",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  SCOPE_MISMATCH: "SCOPE_MISMATCH",
  BATCH_TOO_LARGE: "BATCH_TOO_LARGE",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  RATE_LIMITED: "RATE_LIMITED",
} as const;

export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code?: string,
  ) {
    super(message);
    // 兜底推断：未显式传 code 时按 status 推断，防止新增 throw 忘了传退化成没有 code。
    if (!this.code) {
      const fallback: Record<number, string> = { 400: "INVALID_PAYLOAD", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED", 409: "CONFLICT", 410: "GONE" };
      this.code = fallback[this.status];
    }
  }
}

// Never echo provider bodies, URLs, or arbitrary exception messages into exports/UI.
export function safeResearchError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error && (error.name === "TimeoutError" || /timeout|timed out/i.test(error.message)))
    return "模型或来源请求超时；原始证据已保留，可缩小证据量后重试。未返回用量的调用仍可能计费。";
  if (error instanceof SyntaxError)
    return "服务返回的内容不是有效 JSON；原始证据已保留，请检查服务兼容性后重试。";
  return "研究连接中断或服务异常；原始证据已保留，请检查网络和服务配置后重试。";
}
