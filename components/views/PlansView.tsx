"use client";
// 研究策略 · 信号台版（完全重设计批）：
// ① 统计条（策略/启用调度/数据源/运行中）② 工具行（＋新建策略）
// ③ 策略卡 2 列网格（分类/调度胶囊归一头部 + 目标钳 2 行 + 观察设计 fold + 资源脚注 + 运行右贴）。
// 「立即整理热词」是热词页动作，不再在此页重复。
import { ChevronDown, Clock, Compass, Layers, Play, RadioTower } from "lucide-react";
import { useState } from "react";
import { api } from "../ui";
import { kindPlanLabels } from "../ui";
import { PlanPreview } from "../ResearchBrief";
import type { Workspace, Snapshot } from "../useWorkspaceData";

export function PlansView({ ws, data }: { ws: Workspace; data: Snapshot }) {
  const { busy, setPlan, navigate, act, setNotice } = ws;
  const [analyzeBusy, setAnalyzeBusy] = useState("");
  const plans = data.plans || [];
  const enabledSources = (data.sources || []).filter((s) => s.enabled !== false).length;
  const activeRuns = data.stats?.activePlanIds?.length ?? 0;

  return (
    <>
      {/* ① 统计条 */}
      <div className="stat-strip">
        <div className="stat-card"><strong>{plans.length}</strong><span>研究策略</span><small>分析口径配置 · 每日 01:00 全量采集统一执行</small></div>
        <div className="stat-card accent"><strong>{enabledSources}</strong><span><RadioTower size={13} /> 全量采集源</span><small>每日 01:00 一次采回</small></div>
        <div className="stat-card"><strong>{enabledSources}</strong><span><RadioTower size={13} /> 数据源启用</span><small>共 {(data.sources || []).length} 个可配置</small></div>
        <div className="stat-card"><strong>{activeRuns}</strong><span><Play size={12} /> 运行中</span><small>{activeRuns ? "运行记录页可查进度" : "当前无运行任务"}</small></div>
      </div>

      {/* ② 工具行 */}
      <p className="dash-label"><Compass size={14} /> 策略列表<span className="dash-label-sub">目标、来源、关键词与预算共同决定每天的产出质量</span>
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
                <span className="pill" title="R10 起：每日 01:00 全量采集统一执行，本策略定义分析口径">分析口径 · 每日 01:00 全量采集承接</span>
                {running && <span className="pill sched-run"><Play size={11} /> 运行中</span>}
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
                    <button className="primary" style={{ whiteSpace: "nowrap" }} onClick={() => navigate("activities")}>前往采集</button>
                  ) : (data.config?.consumerMode || "external") === "builtin" ? (
                    <>
                      <button className="primary" disabled={busy || analyzeBusy === p.id || running} title="按本策略口径重读源并跑内置分析（与每日 01:00 全量采集相互独立，会重复消耗模型额度）" onClick={() => void (async () => {
                        setAnalyzeBusy(p.id);
                        try {
                          const r = await api<{ triggered: boolean; running: boolean }>("plans/" + p.id + "/analyze", {});
                          setNotice(r.triggered ? "已入队：按本策略口径重读源 + 内置分析（整理→提词→审核）。" : "该策略已有分析在运行。");
                          await ws.refresh();
                        } catch (e) { setNotice((e as Error).message); } finally { setAnalyzeBusy(""); }
                      })()}><Play size={15} /> {analyzeBusy === p.id ? "分析入队中…" : "手动跑一次分析"}</button>
                    </>
                  ) : null}
                  <details className="more-menu" data-popover>
                    <summary className="button" aria-label={`更多操作：${p.name}`} style={{ padding: "7px 11px" }}><ChevronDown size={13} /></summary>
                    <span className="menu-pop">
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
