"use client";
// 运行记录视图（PHASE 5 自 Workbench.tsx 纯移动拆出；JSX 与拆分前逐字一致）。
import { api, date, download, Empty } from "../ui";
import { ResearchBrief } from "../ResearchBrief";
import type { Workspace, Snapshot } from "../useWorkspaceData";

export function RunsView({ ws, data }: { ws: Workspace; data: Snapshot }) {
  const { busy, act, showResults, setRunId, runId, jobsPage, setJobsPage, pager } = ws;
  return (
    <>
      <div className="budget-strip">
        <strong>
          今日 token 预留：{data.budget.reserved.toLocaleString()} /{" "}
          {data.budget.limit.toLocaleString()}
        </strong>
        <span>
          保守预算包含最大输出，不等于账单；实际模型用量在每个任务中显示。
        </span>
      </div>
      {!data.jobs.length ? (
        <Empty title="研究尚未开始">
          在研究策略中运行一次，完整流程会记录在这里。
        </Empty>
      ) : (
        data.jobs.map((j) => (
          <section className="run" key={j.id}>
            <header>
              <div>
                <h2>{j.plan.name}</h2>
                {j.state === "completed" && <button onClick={() => showResults(j.id)}>查看本次结果</button>}
                <small>
                  {date(j.createdAt)} ·{" "}
                  {j.external ? "外部证据分析" : "内置采集"}
                </small>
              </div>
              <span className={"pill state-" + j.state}>
                {
                  {
                    queued: "等待",
                    running: "运行中",
                    completed: "完成",
                    failed: "失败",
                    cancelled: "已取消",
                  }[j.state]
                }
              </span>
              {["queued", "running"].includes(j.state) && (
                <button
                  disabled={busy || j.cancelRequested}
                  onClick={() =>
                    void act(async () => {
                      await api("cancel", { id: j.id });
                    })
                  }
                >
                  {j.cancelRequested ? "正在取消" : "取消任务"}
                </button>
              )}
            </header>
            <p>
              {j.outcome === "no-findings" ? "完成 · 本轮无新增推荐" : j.stage} · {j.evidenceIds.length} 条证据 · {j.searchCount ?? "未记录"} 次搜索（含补证） · {j.calls}{" "}
              次模型调用 · 已回传用量 {j.actualTokens.toLocaleString()}{" "}
              tokens
            </p>
            {j.calls > 0 && j.state !== "completed" && <p className="muted">进行中或中断的调用可能尚未回传用量，0 不代表未计费。</p>}
            {j.error && <p className="error">{j.error}</p>}
            {["failed", "cancelled"].includes(j.state) && j.evidenceIds.length > 0 &&
              <button disabled={busy || data.stats.activePlanIds.includes(j.planId)}
                onClick={() => void act(async () => {
                  await api("jobs", { planId: j.planId, evidenceIds: j.evidenceIds });
                })}>使用保留证据重试（不重复搜索）</button>}
            {j.warnings.map((w, i) => (
              <p className="warning" key={i}>
                {w}
              </p>
            ))}
            <ResearchBrief job={j} />
            <details>
              <summary>步骤、预算与技能版本</summary>
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
            </details>
          </section>
        ))
      )}
      {runId && <button onClick={() => setRunId("")}>查看全部运行记录</button>}
      {pager(data.pagination.jobs, setJobsPage)}
    </>
  );
}
