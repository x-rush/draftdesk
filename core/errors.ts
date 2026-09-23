import { AppError } from "./store";

// Never echo provider bodies, URLs, or arbitrary exception messages into exports/UI.
export function safeResearchError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error && (error.name === "TimeoutError" || /timeout|timed out/i.test(error.message)))
    return "模型或来源请求超时；原始证据已保留，可缩小证据量后重试。未返回用量的调用仍可能计费。";
  if (error instanceof SyntaxError)
    return "服务返回的内容不是有效 JSON；原始证据已保留，请检查服务兼容性后重试。";
  return "研究连接中断或服务异常；原始证据已保留，请检查网络和服务配置后重试。";
}
