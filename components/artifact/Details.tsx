"use client";
// 产物详情渲染（PHASE 5 自 ArtifactPanel.tsx 纯移动拆出；JSX 与拆分前逐字一致）。
import { ActivityCard } from "../Activities";
import type { ArtifactDraft } from "../../core/schema";

export const detailLabels: Record<string, string> = {
  whatChanged: "发生了什么变化",
  availability: "可用性与门槛",
  limitations: "限制",
  angle: "原创角度",
  readerPromise: "读者能获得什么",
  outline: "创作提纲",
  materialChecklist: "素材准备",
  keyword: "关键词",
  region: "适用地域",
  window: "观察窗口",
  intent: "搜索意图",
  comparison: "同口径对比",
  opportunity: "可行动机会",
  cautions: "口径与偏差",
  job: "用户要完成的任务",
  trigger: "触发场景",
  frequency: "发生频率",
  alternatives: "现有替代",
  differentiation: "与替代方案的差异",
  mvp: "最小产品流程",
  nonGoals: "暂不做什么",
  willingnessToPay: "付费证据或假设",
  experiment: "验证实验",
  successCriteria: "成功条件",
  stopCriteria: "停止条件",
  name: "公开姓名／账号",
  identity: "身份与归属",
  publicChannels: "公开渠道",
  recentWork: "近期作品",
  angles: "值得研究的角度",
  identityCaveat: "身份核对限制",
};
export function Details({ draft }: { draft: ArtifactDraft }) {
  if (draft.kind === "activity") return <ActivityCard activity={draft} />;
  return (
    <div className="detail-sections">
      {Object.entries(draft.details)
        .filter(([k]) => !["platforms", "signalEvidenceIds"].includes(k))
        .map(([key, value]) => (
          <section key={key}>
            <h3>{detailLabels[key] || key}</h3>
            {Array.isArray(value) ? (
              <ol>
                {value.map((s, i) => (
                  <li key={i}>{String(s)}</li>
                ))}
              </ol>
            ) : (
              <p>{String(value)}</p>
            )}
          </section>
        ))}
      {draft.kind === "topic" &&
        draft.details.platforms.map((p) => (
          <section className="platform-variant" key={p.name}>
            <h3>{p.name}版本</h3>
            <ul>
              {p.titles.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <p>{p.hook}</p>
            <ol>
              {p.structure.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </section>
        ))}
    </div>
  );
}
