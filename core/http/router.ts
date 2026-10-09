// 路由表内核：注册序即优先级（first-match-wins），与旧 if 链顺序一一对应。
import type { Store } from "../store";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
// none=UI 路由（带令牌一律 403）；submit=收件（intake 族，鉴权但不许碰其他接口）；
// read/consume/suggest=外部 Agent 三档 scope。
export type Scope = "none" | "submit" | "read" | "consume" | "suggest";

export interface RouteContext {
  db: Store;
  req: Request;
  route: string; // path.join("/")，authenticate 的 from 参数用
  params: Record<string, string>;
  query: URLSearchParams;
  // 惰性读 body：按路由各自控制时机与限额（SSE/流式/5MB 场景不能中间件统一预读）
  readBody: (maxBytes?: number) => Promise<any>;
  // scope 鉴权后的连接（none scope 路由无此值）；producedBy 归属从它取
  connection?: { id: string; name: string };
}

export interface RouteDef {
  methods: HttpMethod[];
  // "agent/clusters" 精确匹配；":id" 单段参数；":rest..." 收尾通配（零段或多段）
  pattern: string;
  scope?: Scope;
  participants?: boolean;
  // true=方法不符先 405 再鉴权（read/consume 命名空间现状）；
  // false/缺省=先鉴权再 405（suggest 命名空间现状：POST clusters 无令牌 = 401）
  methodGuardFirst?: boolean;
  // 命名空间内被拒绝方法的显式截获器：命中即 405，先于一切鉴权与令牌检查。
  // 用途：agent/consume 等具体路由只声明允许的方法，被拒方法若无截获器会落进
  // agent :rest... GET 兜底（pattern+method 匹配压过 fallback），405 变 401/404。
  preAuth405?: boolean;
  handler: (ctx: RouteContext) => Response | Promise<Response>;
}

// ":rest..." 零段或多段收尾；":id" 单段参数；字面段精确匹配
function matchPattern(segs: string[], path: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.startsWith(":") && s.endsWith("...")) {
      params[s.slice(1, -3)] = path.slice(i).join("/");
      return params;
    }
    if (i >= path.length) return null;
    // 注意：与旧 if 链一致，path 段原样使用，不做 URL 解码
    if (s.startsWith(":")) params[s.slice(1)] = path[i];
    else if (s !== path[i]) return null;
  }
  return segs.length === path.length ? params : null;
}

export class RouteRegistry {
  private defs: RouteDef[] = [];

  register(def: RouteDef) {
    this.defs.push(def);
  }

  // 先找 pattern+method 全匹配；全无时退回第一个 pattern 匹配（供方法不符的 405 路径走
  // 该命名空间的鉴权顺序）。fallback 的选取依赖注册序，迁移时严禁打乱文件拼接顺序。
  matchPath(method: HttpMethod, path: string[]): { def: RouteDef; params: Record<string, string> } | null {
    let fallback: { def: RouteDef; params: Record<string, string> } | null = null;
    for (const def of this.defs) {
      const params = matchPattern(def.pattern.split("/"), path);
      if (!params) continue;
      if (def.methods.includes(method)) return { def, params };
      if (!fallback) fallback = { def, params };
    }
    return fallback;
  }
}
