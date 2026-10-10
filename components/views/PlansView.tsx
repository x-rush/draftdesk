"use client";
// 研究策略视图（PHASE 5 自 Workbench.tsx 纯移动拆出；JSX 与拆分前逐字一致）。
import { Layers, Play } from "lucide-react";
import { useState } from "react";
import { api } from "../ui";
import { kindPlanLabels } from "../ui";
import { PlanPreview } from "../ResearchBrief";
import type { Workspace, Snapshot } from "../useWorkspaceData";

export function PlansView({ ws, data }: { ws: Workspace; data: Snapshot }) {
  const { busy, setPlan, navigate, act, setNotice } = ws;
  const [extractBusy, setExtractBusy] = useState(false);
  const [extractNote, setExtractNote] = useState("");
  return (
    <>
      <div className="toolbar">
        <button
          disabled={extractBusy}
          onClick={() => void (async () => {
            setExtractBusy(true);
            try {
              const r = await api<{ triggered: boolean; alreadyDone: boolean }>("seen-terms/extract", {});
              setExtractNote(r.alreadyDone ? "今日已整理。" : "热词提取已触发，约 1-2 分钟后热词雷达自动更新。");
            } catch (e) { setExtractNote((e as Error).message); } finally { setExtractBusy(false); }
          })()}>
          {extractBusy ? "整理中…" : "立即整理热词"}
        </button>
        {extractNote && <span role="status">{extractNote}</span>}
        <button
          className="primary"
          onClick={() =>
            setPlan({
              ...data.plans[0],
              id: crypto.randomUUID(),
              name: "新的研究策略",
              scheduleEnabled: false,
            })
          }
        >
          ＋ 新建策略
        </button>
        <span>自动运行默认关闭 · 可随时调整</span>
      </div>
      <div className="plan-list">
        {data.plans.map((p) => (
          <section className="plan-row" key={p.id}>
            <div className="plan-icon">
              <Layers size={23} />
            </div>
            <div className="plan-content">
              <span className="pill">{kindPlanLabels[p.kind]}</span>
              <h2>{p.name}</h2>
              <p>{p.goal}</p>
              {p.kind !== "activities" && <PlanPreview plan={p} sources={data.sources} />}
              {p.kind !== "activities" && <div className="tags">
                {p.sourceIds.map((id) => (
                  <span key={id}>
                    {data.sources.find((s) => s.id === id)?.name ||
                      id}
                  </span>
                ))}
              </div>}
              <small>
                {p.kind === "activities" ? "登录浏览器中手动启动采集" : p.scheduleEnabled
                  ? `每天 ${p.dailyTime}（北京）`
                  : "手动运行"}{" "}
                · 最多 {p.maxItems} 条产物 · {p.maxModelCalls}{" "}
                次模型调用 · {p.maxTokens.toLocaleString()} token
                上限
              </small>
            </div>
            <div className="plan-actions">
              {p.kind === "activities" ? <button className="primary" onClick={() => navigate("activities")}>前往活动采集</button> : <button
                disabled={
                  busy ||
                  data.stats.activePlanIds.includes(p.id)
                }
                className="primary"
                onClick={() =>
                  void act(async () => {
                    await api("jobs", { planId: p.id });
                    navigate("runs");
                    setNotice("研究任务已入队。");
                  })
                }
              >
                <Play size={15} />
                运行
              </button>}
              <button onClick={() => setPlan(p)}>调整策略</button>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
