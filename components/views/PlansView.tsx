"use client";
// 研究策略 · 信号台版（完全重设计批）：
// ① 统计条（策略/启用调度/数据源/运行中）② 工具行（＋新建策略）
// ③ 策略卡 2 列网格（分类/调度胶囊归一头部 + 目标钳 2 行 + 观察设计 fold + 资源脚注 + 运行右贴）。
// 「立即整理热词」是热词页动作，不再在此页重复。
import { Layers, Play } from "lucide-react";
import { useState } from "react";
import { api } from "../ui";
import { kindPlanLabels } from "../ui";
import { PlanPreview } from "../ResearchBrief";
import type { Workspace, Snapshot } from "../useWorkspaceData";

export function PlansView({ ws, data }: { ws: Workspace; data: Snapshot }) {
  const { busy, setPlan, navigate, act, setNotice } = ws;
  const [analyzeBusy, setAnalyzeBusy] = useState("");
  const plans = data.plans || [];
  const scheduled = plans.filter((p) => p.scheduleEnabled).length;
  const enabledSources = (data.sources || []).filter((s) => s.enabled !== false).length;
  const activeRuns = data.stats?.activePlanIds?.length ?? 0;

  return (
    <>
      {/* ① 统计条 */}
      <div className="stat-strip">
        <div className="stat-card"><strong>{plans.length}</strong><span>研究策略</span><small>{scheduled} 个启用每日调度</small></div>
        <div className="stat-card accent"><strong>{scheduled}</strong><span>⏰ 启用调度</span><small>每晚自动采集与分析</small></div>
        <div className="stat-card"><strong>{enabledSources}</strong><span>📡 数据源启用</span><small>共 {(data.sources || []).length} 个可配置</small></div>
        <div className="stat-card"><strong>{activeRuns}</strong><span>▶ 运行中</span><small>{activeRuns ? "运行记录页可查进度" : "当前无运行任务"}</small></div>
      </div>

      {/* ② 工具行 */}
      <p className="dash-label">🧭 策略列表<span className="dash-label-sub">目标、来源、关键词与预算共同决定每天的产出质量</span>
        <button className="primary radar-refresh" onClick={() =>
          setPlan({
            ...plans[0],
            id: crypto.randomUUID(),
            name: "新的研究策略",
            scheduleEnabled: false,
          })
        }>＋ 新建策略</button>
      </p>

      {/* ③ 策略卡网格 */}
      <div className="plan-grid">
        {plans.map((p) => {
          const running = data.stats.activePlanIds.includes(p.id);
          return (
            <article className="plan-card" key={p.id}>
              <div className="plan-card-head">
                <span className="pill">{kindPlanLabels[p.kind]}</span>
                <span className={"pill" + (p.scheduleEnabled && p.kind !== "activities" ? " sched-on" : "")}>
                  {p.kind === "activities" ? "手动采集" : p.scheduleEnabled ? `⏰ 每天 ${p.dailyTime}` : "手动运行"}
                </span>
                {running && <span className="pill sched-run">▶ 运行中</span>}
              </div>
              <h3 className="plan-name"><Layers size={16} />{p.name}</h3>
              <p className="plan-goal">{p.goal}</p>
              {p.kind !== "activities" && (
                <details className="row-fold">
                  <summary>观察设计（目标 / 来源 / 关键词 / 预算）</summary>
                  <PlanPreview plan={p} sources={data.sources} />
                </details>
              )}
              <div className="plan-foot">
                <small className="muted">
                  {p.maxItems} 条产物 · {p.maxModelCalls} 次调用 · {Math.round(p.maxTokens / 1000)}k tokens
                  {" · 来源 "}{p.sourceIds.length} 个
                </small>
                <div className="term-actions">
                  {p.kind === "activities" ? (
                    <button className="primary" onClick={() => navigate("activities")}>前往活动采集</button>
                  ) : (
                    <button className="primary" disabled={busy || running} title={running ? "该策略已有任务在运行" : undefined} onClick={() =>
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
                  <details className="more-menu" data-popover>
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
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
