// 共享纯函数：时间戳 / 散列 / URL 归一化。单独成文件避免与 store/index 互相依赖。
import { createHash } from "node:crypto";

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
