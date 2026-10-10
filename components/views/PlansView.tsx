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
  const [analyzeBusy, setAnalyzeBusy] = useState("");
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
          <section className="plan-row card-row" key={p.id}>
            <div className="plan-icon" aria-hidden="true">
              <Layers size={23} />
            </div>
            <div className="plan-content">
              <div className="card-row-top">
                <h2 className="card-title">{p.name}</h2>
                <span className="card-badges"><span className="pill">{kindPlanLabels[p.kind]}</span></span>
              </div>
              <p className="card-summary">{p.goal}</p>
              {p.kind !== "activities" && (
                <details className="row-fold">
                  <summary>观察设计</summary>
                  <PlanPreview plan={p} sources={data.sources} />
                </details>
              )}
              <div className="card-row-bottom">
                <span className="card-meta">
                  {p.kind === "activities" ? "登录浏览器中手动启动采集" : p.scheduleEnabled ? `每天 ${p.dailyTime}（北京）` : "手动运行"}
                  {" · "}{p.maxItems} 条产物 · {p.maxModelCalls} 次调用 · {p.maxTokens.toLocaleString()} token 上限
                  {p.kind !== "activities" && " · 来源：" + p.sourceIds.map((id) => data.sources.find((s) => s.id === id)?.name || id).join("、")}
                </span>
                <span className="card-actions">
                  {p.kind === "activities" ? (
                    <button className="primary" onClick={() => navigate("activities")}>前往活动采集</button>
                  ) : (
                    <button className="primary" disabled={busy || data.stats.activePlanIds.includes(p.id)} onClick={() =>
                      void act(async () => {
                        await api("jobs", { planId: p.id });
                        navigate("runs");
                        setNotice("研究任务已入队。");
                      })
                    }>
                      <Play size={15} />
                      运行
                    </button>
                  )}
                  <details className="more-menu">
                    <summary className="button" aria-label={`更多操作：${p.name}`} style={{ padding: "7px 11px" }}>⋯更多</summary>
                    <span className="menu-pop">
                      {p.kind !== "activities" && (
                        <button disabled={busy || analyzeBusy === p.id} onClick={() => void (async () => {
                          setAnalyzeBusy(p.id);
                          try {
                            const r = await api<{ triggered: boolean; running: boolean }>("plans/" + p.id + "/analyze", {});
                            setNotice(r.triggered ? "内置分析已入队（整理→提词→审核）。" : "该策略已有分析在运行。");
                            await ws.refresh();
                          } catch (e) { setNotice((e as Error).message); } finally { setAnalyzeBusy(""); }
                        })()}>{analyzeBusy === p.id ? "分析入队中…" : "立即分析"}</button>
                      )}
                      <button onClick={() => setPlan(p)}>调整策略</button>
                    </span>
                  </details>
                </span>
              </div>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
