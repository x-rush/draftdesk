"use client";
// 运行记录视图（PHASE 5 自 Workbench.tsx 纯移动拆出；JSX 与拆分前逐字一致）。
import { api, date, download, Empty } from "../ui";
import { ResearchBrief } from "../ResearchBrief";
import { useState } from "react";
import type { Workspace, Snapshot } from "../useWorkspaceData";

export function RunsView({ ws, data }: { ws: Workspace; data: Snapshot }) {
  const { busy, act, showResults, setRunId, runId, jobsPage, setJobsPage, pager } = ws;
  // 数据治理（根因 B）：状态筛选 + 空跑记录折叠——30 条里大量「完成·无新增
  // 推荐·0 tokens」零信息卡污染列表。
  const [runFilter, setRunFilter] = useState<"all" | "completed" | "failed" | "active">("all");
  const [hideNoFindings, setHideNoFindings] = useState(true);
  const isNoFindings = (j: any) => j.state === "completed" && j.outcome === "no-findings";
  const jobsAll = data.jobs;
  const jobs = jobsAll
    .filter((j) => (runFilter === "all" ? true : runFilter === "active" ? ["queued", "running"].includes(j.state) : j.state === runFilter))
    .filter((j) => !(hideNoFindings && isNoFindings(j)));
  return (
    <>
      <div className="budget-strip">
        <span className="budget-label">今日 token 预留 · 保守预算包含最大输出，不等于账单</span>
        <strong className="budget-number">
          {data.budget.reserved.toLocaleString()}
          <small> / {data.budget.limit.toLocaleString()} tokens</small>
        </strong>
        <span className="budget-note">实际模型用量在每个任务的条目中显示。</span>
      </div>
      <nav className="discovery-modes" aria-label="运行状态筛选" style={{ marginBottom: "var(--s3)" }}>
        {([["all", "全部", jobsAll.length], ["active", "进行中", jobsAll.filter((j) => ["queued", "running"].includes(j.state)).length], ["failed", "失败", jobsAll.filter((j) => j.state === "failed").length], ["completed", "完成", jobsAll.filter((j) => j.state === "completed").length]] as const).map(([key, label, count]) => (
          <button key={key} className={runFilter === key ? "active" : ""} aria-current={runFilter === key ? "page" : undefined} onClick={() => setRunFilter(key)}>{label} {count}</button>
        ))}
        <label className="check" style={{ margin: "0 0 0 auto" }}>
          <input type="checkbox" checked={hideNoFindings} onChange={(e) => setHideNoFindings(e.target.checked)} />
          隐藏空跑（无新增推荐）
        </label>
      </nav>
      {!jobs.length ? (
        <Empty title={jobsAll.length ? "当前筛选下没有任务" : "研究尚未开始"}>
          {jobsAll.length ? "调整上方筛选或隐藏开关再看。" : "在研究策略中运行一次，完整流程会记录在这里。"}
        </Empty>
      ) : (
        jobs.map((j) => (
          <article className="discovery-row" key={j.id}>
            <div className="row-content">
              <div className="row-meta">
                <span className={"pill state-" + j.state}>{{ queued: "等待", running: "运行中", completed: "完成", failed: "失败", cancelled: "已取消" }[j.state]}</span>
                <span>{date(j.createdAt)}</span>
                <span>{j.external ? "外部证据分析" : "内置采集"}</span>
                <span>{j.evidenceIds.length} 条证据 · {j.searchCount ?? "未记录"} 次搜索</span>
                <span>{j.calls} 次调用 · {j.actualTokens.toLocaleString()} tokens</span>
              </div>
              <button className="article-title" onClick={() => { if (j.state === "completed") showResults(j.id); }}>{j.plan.name}</button>
              <p>{j.outcome === "no-findings" ? "完成 · 本轮无新增推荐" : j.stage}</p>
            </div>
            <div className="row-side">
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {j.state === "completed" && <button className="button-secondary" onClick={() => showResults(j.id)}>查看本次结果</button>}
                {["queued", "running"].includes(j.state) && (
                  <button disabled={busy || j.cancelRequested} onClick={() => void act(async () => { await api("cancel", { id: j.id }); })}>
                    {j.cancelRequested ? "正在取消" : "取消任务"}
                  </button>
                )}
                {["failed", "cancelled"].includes(j.state) && j.evidenceIds.length > 0 &&
                  <button disabled={busy || data.stats.activePlanIds.includes(j.planId)}
                    onClick={() => void act(async () => {
                      await api("jobs", { planId: j.planId, evidenceIds: j.evidenceIds });
                    })}>使用保留证据重试</button>}
              </div>
            </div>
            <div style={{ width: "100%" }}>
              {j.error && <p className="error" style={{ maxWidth: 760 }}>{j.error}</p>}
              {j.warnings.map((w, i) => (
                <p className="warning" key={i}>
                  {w}
                </p>
              ))}
              {!isNoFindings(j) && <ResearchBrief job={j} />}
              {!isNoFindings(j) && <details className="row-fold">
              <summary>步骤、预算与技能版本{["failed", "cancelled"].includes(j.state) && j.evidenceIds.length > 0 ? " · 重试说明" : ""}</summary>
              {j.calls > 0 && j.state !== "completed" && <p className="muted">进行中或中断的调用可能尚未回传用量，0 不代表未计费。</p>}
              <ol className="timeline">
                {j.steps.map((s, i) => (
                  <li key={i}>
                    <strong>{s.name}</strong>
                    <span>{s.detail}</span>
                    <small>{date(s.at)}</small>
                  </li>
                ))}
              </ol>
              <p>
                预留 {j.reservedTokens.toLocaleString()} /{" "}
                {j.plan.maxTokens.toLocaleString()} tokens
              </p>
              {Object.entries(j.skillVersions).map(([k, v]) => (
                <small className="version" key={k}>
                  {k} · {v}
                </small>
              ))}
              <button
                onClick={() =>
                  void act(async () =>
                    download(
                      j.id + "-research.json",
                      await api("job-context/" + j.id),
                    ),
                  )
                }
              >
                导出中间分析
              </button>
            </details>}
            </div>
          </article>
        ))
      )}
      {runId && <button onClick={() => setRunId("")}>查看全部运行记录</button>}
      {pager(data.pagination.jobs, setJobsPage)}
    </>
  );
}
