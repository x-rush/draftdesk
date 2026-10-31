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
  const builtin = (data.config?.consumerMode || "external") === "builtin";

  // R10.25-2：external 下本页只剩「分析口径配置」一个真实作用（供外部 Agent 与采集过滤读取）——
  // 统计条/新建向导/多策略卡网格/手动分析按钮全部隐藏（builtin 才显示）。
  if (!builtin) {
    const primary = plans.find((p) => p.kind !== "activities") || plans[0];
    return (
      <>
        <p className="dash-label"><Compass size={14} /> 分析口径配置<span className="dash-label-sub">供外部 Agent 语义处理与采集过滤读取；分析执行在 external 模式下由外部 Agent（02:00）完成</span></p>
        {primary ? (
          <article className="plan-card">
            <div className="plan-card-head">
              <span className="pill">{kindPlanLabels[primary.kind]}</span>
              <span className="pill" title="口径只读消费：01:00 全量采集 + 外部 Agent 语义处理">分析口径 · 外部 Agent 消费</span>
            </div>
            <h3 className="plan-name"><Layers size={16} />{primary.name}</h3>
            <p className="plan-goal">{primary.goal}</p>
            <details className="row-fold">
              <summary>口径详情（目标 / 来源 / 关键词 / 预算）</summary>
              <PlanPreview plan={primary} sources={data.sources} />
            </details>
            <div className="plan-foot">
              <div className="term-actions">
                <details className="more-menu" data-popover>
                  <summary className="button" aria-label="调整分析口径" style={{ padding: "7px 11px" }}><ChevronDown size={13} /></summary>
                  <span className="menu-pop">
                    <button onClick={() => setPlan(primary)}>调整口径</button>
                  </span>
                </details>
              </div>
            </div>
          </article>
        ) : (
          <p className="muted">暂无分析口径；切到 builtin 模式可新建策略。</p>
        )}
      </>
    );
  }

  return (
    <>
      {/* ① 统计条 */}
      <div className="stat-strip">
        <div className="stat-card"><strong>{plans.length}</strong><span>分析口径</span><small>分析口径配置 · 每日 01:00 全量采集统一执行</small></div>
        <div className="stat-card accent"><strong>{enabledSources}</strong><span><RadioTower size={13} /> 全量采集源</span><small>每日 01:00 一次采回</small></div>
        <div className="stat-card"><strong>{(data.sources || []).length}</strong><span><RadioTower size={13} /> 数据源总数</span><small>启用 {enabledSources} · 停用 {(data.sources || []).length - enabledSources}</small></div>
        <div className="stat-card"><strong>{activeRuns}</strong><span><Play size={12} /> 运行中</span><small>{activeRuns ? "运行记录页可查进度" : "当前无运行任务"}</small></div>
      </div>

      {/* ② 工具行 */}
      <p className="dash-label"><Compass size={14} /> 策略列表<span className="dash-label-sub">目标、来源、关键词与预算共同决定每天的产出质量</span>
        <button className="primary radar-refresh" onClick={() =>
          setPlan({
            ...plans[0],
            id: crypto.randomUUID(),
            kind: plans.find((p) => p.kind !== "activities")?.kind || "trends", // R10.45 P3：新建不再继承当前选中卡的 kind（如 activities）
            name: "新的分析口径",
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
                  ) : (
                    <button className="primary" disabled={busy || analyzeBusy === p.id || running} title="按本策略口径重读源并跑内置分析（与每日 01:00 全量采集相互独立，会重复消耗模型额度）" onClick={() => void (async () => {
                      setAnalyzeBusy(p.id);
                      try {
                        const r = await api<{ triggered: boolean; running: boolean }>("plans/" + p.id + "/analyze", {});
                        setNotice(r.triggered ? "已入队：按本策略口径重读源 + 内置分析（整理→提词→审核）。" : "该策略已有分析在运行。");
                        await ws.refresh();
                      } catch (e) { setNotice((e as Error).message); } finally { setAnalyzeBusy(""); }
                    })()}><Play size={15} /> {analyzeBusy === p.id ? "分析入队中…" : "手动跑一次分析"}</button>
                  )}
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
