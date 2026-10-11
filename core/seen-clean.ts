// 存量清洗（种子池污染清洗批 ③/④）：按 seed 血缘反查跑题种子家族 → 归档出库。
// 不删（status=archived 备查 90 天后由 janitor 常规清理），跑题种子本体一并出池。
// 白名单（④ 别误伤）命中即豁免：AI 短剧家族（AI短剧/skyreels/星灵/短剧授权平台——
// 中文内容线金矿）、AI生成内容版权/爱 奇 艺 收益、无血缘提词（Anthropic/Claude/Codex/Baseten）。
import { termId, bumpSeenTermsVersion } from "./seen-terms";

// 11 个跑题种子（LLM 误标 offTopic:false 回流种子池后展开出汽车/灰产家族的根源）
export const POLLUTION_SEEDS = [
  "自动驾驶", "自動駕駛", "自动点击器", "自动连点器", "自动精灵",
  "台湾自驾", "台湾自駕", "tesla", "uber", "toyota", "台湾法规",
];

const WHITELIST = /短剧|skyreels|星灵|爱奇艺|爱 奇 艺|版权|anthropic|claude|codex|baseten/i;

type CleanStore = {
  list<T>(collection: string): T[];
  get<T>(collection: string, id: string): T | undefined;
  put<T>(collection: string, id: string, value: T): T;
};

export function cleanSeedPollution(kv: CleanStore): { roots: number; family: number; archived: number } {
  const byId = new Map<string, any>();
  for (const doc of kv.list<any>("seen-terms")) byId.set(String(doc.id ?? termId(doc.term)), doc);

  const seedSet = new Set(POLLUTION_SEEDS.map(termId));
  // 种子本体（含历史变体拼写）出池；白名单豁免
  const roots = [...byId.values()].filter((d) => seedSet.has(termId(d.term)) && !WHITELIST.test(d.term));

  // BFS 血缘反查：doc.seed ∈ 已污染集合 → 该词属于家族。seed 只记首见，
  // 所以家族词的首见种子就是污染根源（或它的后代），单链回溯即可覆盖全族。
  // 污染源 = 清单内全部种子 id（含库中已不存在的）∪ 找到的根文档。
  const polluted = new Set<string>([...seedSet, ...roots.map((d) => String(d.id))]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const doc of byId.values()) {
      const id = String(doc.id);
      if (polluted.has(id) || WHITELIST.test(doc.term)) continue;
      if (doc.seed && polluted.has(termId(String(doc.seed)))) {
        polluted.add(id);
        grew = true;
      }
    }
  }

  const today = new Date().toISOString();
  let archived = 0;
  for (const doc of [...byId.values()]) {
    const id = String(doc.id);
    if (!polluted.has(id) || doc.status === "archived") continue;
    kv.put("seen-terms", id, {
      ...doc,
      status: "archived",
      relevance: "off",
      offTopic: true,
      archivedReason: "seed-pollution-clean-v1",
      archivedAt: today,
      updatedAt: today,
    });
    archived++;
  }
  if (archived) bumpSeenTermsVersion(kv);
  return { roots: roots.length, family: polluted.size - seedSet.size, archived };
}
