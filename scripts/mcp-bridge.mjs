#!/usr/bin/env node
// DraftDesk MCP stdio 桥：给只支持本地 stdio MCP 的运行器用。
// 说话对象：agent ↔ 本脚本（stdio JSON-RPC）；本脚本 ↔ 工作台（REST /api/v1/agent/*）。
// 用法：
//   DRAFTDESK_URL=http://127.0.0.1:5173 DRAFTDESK_READ_TOKEN=dd_... node scripts/mcp-bridge.mjs
// 令牌需带 read 权限（工作台「外部接入」创建连接时勾选读取授权）。
// 工具清单与内置 HTTP MCP 端点（/api/v1/mcp）保持一致；改端请同步这里与 docs/external-onboarding.md。

const BASE = (process.env.DRAFTDESK_URL || "http://127.0.0.1:5173").replace(/\/+$/, "");
const TOKEN = process.env.DRAFTDESK_READ_TOKEN || "";

const TOOLS = [
  {
    name: "search_hotspots",
    description: "搜索工作台近 N 天的原始热榜条目（跨批次，含被策略筛除的），返回标题、原链接、来源、榜单热度与筛除原因。热榜标题仅为线索，不构成事实认证。",
    inputSchema: { type: "object", properties: { q: { type: "string" }, source: { type: "string" }, days: { type: "integer", minimum: 1, maximum: 30 }, limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: { type: "string" } } },
  },
  {
    name: "search_evidence",
    description: "检索工作台证据库（标题+摘要文本匹配），返回摘要级内容、来源类型与出处指标。摘要不等于全文或事实认证。",
    inputSchema: { type: "object", properties: { q: { type: "string" }, sourceType: { type: "string" }, days: { type: "integer", minimum: 1, maximum: 30 }, limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: { type: "string" } } },
  },
  {
    name: "list_artifacts",
    description: "列出研究产物（news/topic/trend/idea/activity），全部质量分层带标签：ready 通过检查、review 待验证、rejected 已否决；消费 review 条目前先补证。",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["news", "topic", "trend", "idea", "activity"] }, quality: { type: "string", enum: ["ready", "review", "rejected"] }, days: { type: "integer", minimum: 1, maximum: 30 }, limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: { type: "string" } } },
  },
  {
    name: "get_artifact",
    description: "按 ID 读取单条产物详情：含分析字段与引用证据的摘要内联。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "get_workspace_stats",
    description: "工作台库存概览：产物各类型/质量数量、证据总量、热榜批次数与最近任务状态。",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callRest(name, args) {
  const a = args || {};
  const qs = (obj) => "?" + new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
  let path;
  if (name === "search_hotspots") path = "/api/v1/agent/hotspots" + qs(a);
  else if (name === "search_evidence") path = "/api/v1/agent/evidence" + qs(a);
  else if (name === "list_artifacts") path = "/api/v1/agent/artifacts" + qs(a);
  else if (name === "get_artifact") path = "/api/v1/agent/artifacts/" + encodeURIComponent(String(a.id || ""));
  else if (name === "get_workspace_stats") path = "/api/v1/agent/stats";
  else throw new Error("未知工具：" + name);
  const response = await fetch(BASE + path, { headers: { Authorization: "Bearer " + TOKEN, Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`工作台 HTTP ${response.status}：${text.slice(0, 300)}`);
  return text;
}

async function handle(message) {
  if (Array.isArray(message)) return Promise.all((await Promise.all(message.map((m) => handle(m)))).filter(Boolean));
  if (!message || message.jsonrpc !== "2.0") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "无效请求" } };
  if (message.id === undefined || message.id === null) return null;
  const { id, method } = message;
  if (method === "initialize")
    return { jsonrpc: "2.0", id, result: { protocolVersion: message.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "draftdesk-bridge", version: "1.0.0" }, instructions: "拾题工作台只读数据源（stdio 桥）。quality=review 为待验证、rejected 为已否决，引用前核对原链接。" } };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    try {
      const text = await callRest(String(message.params?.name || ""), message.params?.arguments);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
    } catch (error) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(error && error.message || error) }], isError: true } };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "方法不存在：" + method } };
}

if (!TOKEN) {
  console.error("缺少 DRAFTDESK_READ_TOKEN（需带 read 权限的连接令牌）");
  process.exit(1);
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    handle(message).then((reply) => {
      if (reply !== null) process.stdout.write(JSON.stringify(reply) + "\n");
    });
  }
});
process.stdin.on("end", () => process.exit(0));
