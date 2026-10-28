// info 型强词回流内容线（第八轮 R8-2②）：relevance=strong 且 demandIntent=info 且
// observations≥3 的词（哥飞数据缺口之外的「资讯型」强词），生成「贴图号短资讯」
// 选题提示卡进审查台待拍队列（decisions 集合 pending 档），老大分拍。
// ⚠️ 站群池仍只收 tool 意图词，两通道互不干扰（R8-2② 拍板）。
// 零外部调用纯库内计算；每日一道闸；幂等（同词已建卡不重复）。
import type { Store } from "./store";
import { shanghaiDayOf } from "./tick-guard";
import { now } from "./store";
import { termId } from "./seen-terms";

const CARD_SPEC = "图卡文案包规格：3-6 张图卡，首图即观点，每张文案 ≤54 字，视觉风格关键词 3-5 个";

export function infoReflowTick(db: Store, nowDate: Date = new Date()): void {
  const day = shanghaiDayOf(nowDate); // R10.31：上海日
  if (db.get("meta", "info-reflow-done:" + day)) return;
  const isInfoStrong = (t: any) => t.relevance === "strong" && t.demandIntent === "info"
    && (t.observations ?? 0) >= 3 && !t.offTopic;
  const existingTitles = new Set(db.list<any>("decisions").map((d) => d.title));
  const candidates = db.list<any>("seen-terms")
    .filter((t) => isInfoStrong(t) && !existingTitles.has(`【贴图号短资讯】${String(t.term || t.id)}`));
  if (!candidates.length) { db.put("meta", "info-reflow-done:" + day, { at: now(), created: 0 }); return; }
  let created = 0;
  for (const t of candidates.slice(0, 10)) {
    const term = String(t.term || t.id).trim();
    const record = {
      id: "dec-" + termId(term).slice(0, 24) + "-" + day.replace(/-/g, ""),
      title: `【贴图号短资讯】${term}`,
      notes: `${CARD_SPEC}。溯源：seen-terms/${termId(term)}（观测 ${t.observations} 次，哥飞意图对照 ${t.intent ?? "无"}）。`,
      platforms: ["tiebuhao"],
      decision: "pending" as const,
      decidedBy: "builtin",
      createdAt: now(),
    };
    db.put("decisions", record.id, record);
    created++;
  }
  db.put("meta", "info-reflow-done:" + day, { at: now(), created });
  if (created) console.log(`[info-reflow] info 型强词回流：${created} 张贴图号短资讯卡进审查台待拍`);
}
