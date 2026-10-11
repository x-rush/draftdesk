"use client";
// 运行记录 · 信号台版（完全重设计批）：
// ① 统计条（今日预留 tokens/进行中/失败/完成有效——点卡切筛选）
// ② 工具行（状态胶囊 + 隐藏空跑 + 任务过滤提示）
// ③ 紧凑运行行（状态胶囊+策略名+meta 同列，动作右贴；错误/警告首条行内、全部日志收进 fold）。
import { api, date, download, Empty } from "../ui";
import { ResearchBrief } from "../ResearchBrief";
import { useState } from "react";
import type { Workspace, Snapshot } from "../useWorkspaceData";

const STATE_LABELS: Record<string, string> = { queued: "等待", running: "运行中", completed: "完成", failed: "失败", cancelled: "已取消" };

export function RunsView({ ws, data }: { ws: Workspace; data: Snapshot }) {
  const { busy, act, showResults, setRunId, runId, jobsPage, setJobsPage, pager } = ws;
  const [runFilter, setRunFilter] = useState<"all" | "completed" | "failed" | "active">("all");
  const [hideNoFindings, setHideNoFindings] = useState(true);
  const isNoFindings = (j: any) => j.state === "completed" && j.outcome === "no-findings";
  const jobsAll = data.jobs;
  const activeCount = jobsAll.filter((j) => ["queued", "running"].includes(j.state)).length;
  const failedCount = jobsAll.filter((j) => j.state === "failed").length;
  const completedCount = jobsAll.filter((j) => j.state === "completed" && !isNoFindings(j)).length;
  const emptyCount = jobsAll.filter(isNoFindings).length;
  const pct = data.budget.limit ? Math.min(999, Math.round((data.budget.reserved / data.budget.limit) * 100)) : 0;
  const jobs = jobsAll
    .filter((j) => (runFilter === "all" ? true : runFilter === "active" ? ["queued", "running"].includes(j.state) : j.state === runFilter))
    .filter((j) => !(hideNoFindings && isNoFindings(j)));

  return (
    <>
      {/* ① 统计条（点卡切筛选） */}
      <div className="stat-strip">
        <button type="button" className={"stat-card clickable accent" + (runFilter === "all" ? " active" : "")} onClick={() => setRunFilter("all")}>
          <strong>{data.budget.reserved.toLocaleString()}</strong><span>今日 token 预留 · {pct}%</span>
          <small>上限 {data.budget.limit.toLocaleString()}；保守预算非账单</small>
        </button>
        <button type="button" className={"stat-card clickable" + (runFilter === "active" ? " active" : "")} onClick={() => setRunFilter(runFilter === "active" ? "all" : "active")}>
          <strong>{activeCount}</strong><span>▶ 进行中</span><small>排队与运行中的任务</small>
        </button>
        <button type="button" className={"stat-card clickable" + (runFilter === "failed" ? " active" : "")} onClick={() => setRunFilter(runFilter === "failed" ? "all" : "failed")}>
          <strong>{failedCount}</strong><span>✕ 失败</span><small>保留证据可一键重试</small>
        </button>
        <button type="button" className={"stat-card clickable" + (runFilter === "completed" ? " active" : "")} onClick={() => setRunFilter(runFilter === "completed" ? "all" : "completed")}>
          <strong>{completedCount}</strong><span>✓ 完成有效</span><small>空跑 {emptyCount} 条{hideNoFindings ? "已隐藏" : "显示中"}</small>
        </button>
      </div>

      {/* ② 工具行 */}
      <div className="radar-toolbar">
        <nav className="discovery-modes" aria-label="运行状态筛选">
          {([["all", "全部", jobsAll.length], ["active", "进行中", activeCount], ["failed", "失败", failedCount], ["completed", "完成", jobsAll.filter((j) => j.state === "completed").length]] as const).map(([key, label, count]) => (
            <button key={key} className={runFilter === key ? "active" : ""} aria-current={runFilter === key ? "page" : undefined} onClick={() => setRunFilter(key)}>{label} {count}</button>
          ))}
        </nav>
        <label className="check" style={{ margin: "0 0 0 auto" }}>
          <input type="checkbox" checked={hideNoFindings} onChange={(e) => setHideNoFindings(e.target.checked)} />
          隐藏空跑（无新增推荐）
        </label>
        {runId && (
          <button className="text-button" onClick={() => setRunId("")}>清除单任务过滤 ✕</button>
        )}
      </div>

      {/* ③ 运行行 */}
      {!jobs.length ? (
        <Empty title={jobsAll.length ? "当前筛选下没有任务" : "研究尚未开始"}>
          {jobsAll.length ? "调整上方筛选或隐藏开关再看。" : "在研究策略中运行一次，完整流程会记录在这里。"}
        </Empty>
      ) : (
        <div className="term-list">
          {jobs.map((j) => {
            const hasDetail = !isNoFindings(j);
            return (
              <div className={"term-row" + (hasDetail ? " top" : "")} key={j.id}>
                <div className="term-main">
                  <span className={"pill state-" + j.state}>{STATE_LABELS[j.state] || j.state}</span>
                  <button
                    className="term-name"
                    onClick={() => { if (j.state === "completed") showResults(j.id); }}
                    title={j.state === "completed" ? "点击查看本次结果" : undefined}
                    style={{ cursor: j.state === "completed" ? "pointer" : "default" }}
                  >
                    {j.plan.name}
                  </button>
                  <span className="term-meta">
                    <span>{date(j.createdAt)}</span>
                    <span>{j.external ? "外部分析" : "内置采集"}</span>
                    <span>证据 {j.evidenceIds.length}</span>
                    <span>{j.calls} 次 · {j.actualTokens.toLocaleString()} tok</span>
                    {isNoFindings(j) ? <span>空跑</span> : j.stage ? <span>{j.stage}</span> : null}
                    {j.cancelRequested && <span>取消中…</span>}
                  </span>
                </div>
                <div className="term-actions">
                  {j.state === "completed" && <button className="button-secondary" onClick={() => showResults(j.id)}>查看结果</button>}
                  {["queued", "running"].includes(j.state) && (
                    <button disabled={busy || j.cancelRequested} onClick={() => void act(async () => { await api("cancel", { id: j.id }); })}>
                      {j.cancelRequested ? "正在取消" : "取消任务"}
                    </button>
                  )}
                  {["failed", "cancelled"].includes(j.state) && j.evidenceIds.length > 0 && (
                    <button className="button-secondary" disabled={busy || data.stats.activePlanIds.includes(j.planId)}
                      title="用本任务保留的证据重新入队，不重新采集"
                      onClick={() => void act(async () => {
                        await api("jobs", { planId: j.planId, evidenceIds: j.evidenceIds });
                      })}>使用保留证据重试</button>
                  )}
                </div>
                {(j.error || j.warnings.length > 0) && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    {j.error && <p className="error" style={{ maxWidth: "none", margin: "4px 0 0", fontSize: 12 }}>{j.error}</p>}
                    {j.warnings.slice(0, 1).map((w: string, i: number) => (
                      <p className="warning" key={i} style={{ maxWidth: "none", margin: "4px 0 0", fontSize: 12 }}>{w}</p>
                    ))}
                  </div>
                )}
                {hasDetail && (
                  <details className="row-fold" style={{ gridColumn: "1 / -1" }}>
                    <summary>结果说明 · 步骤日志 · 导出{["failed", "cancelled"].includes(j.state) && j.evidenceIds.length > 0 ? " · 重试说明" : ""}</summary>
                    {j.warnings.slice(1).map((w: string, i: number) => <p className="warning" key={i}>{w}</p>)}
                    <ResearchBrief job={j} />
                    {j.calls > 0 && j.state !== "completed" && <p className="muted">进行中或中断的调用可能尚未回传用量，0 不代表未计费。</p>}
                    <ol className="timeline">
                      {j.steps.map((s: any, i: number) => (
                        <li key={i}>
                          <strong>{s.name}</strong>
                          <span>{s.detail}</span>
                          <small>{date(s.at)}</small>
                        </li>
                      ))}
                    </ol>
                    <p>预留 {j.reservedTokens.toLocaleString()} / {j.plan.maxTokens.toLocaleString()} tokens</p>
                    {Object.entries(j.skillVersions).map(([k, v]) => (
                      <small className="version" key={k}>{k} · {v}</small>
                    ))}
                    <button onClick={() => void act(async () => download(j.id + "-research.json", await api("job-context/" + j.id)))}>
                      导出中间分析
                    </button>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
      {pager(data.pagination.jobs, setJobsPage)}
    </>
  );
}
