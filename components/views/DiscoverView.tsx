"use client";
// 每日发现 / 热词趋势 / 应用机会 / 创作活动 / 选题库 五视图共用的列表区
// （PHASE 5 自 Workbench.tsx 纯移动拆出；JSX 与拆分前逐字一致）。
import { ActivityCard, ActivityTools } from "../Activities";
import { DiscoveryLens } from "../DiscoveryLens";
import { api, date, Empty, kindLabels } from "../ui";
import { Search, ArrowUpRight } from "lucide-react";
import { creationLabels } from "../../core/workspace-ui";
import { decisionLabels, decisionOf } from "../../core/research-policy";
import { Select } from "../Select";
import type { Workspace, Snapshot } from "../useWorkspaceData";

export function DiscoverView({ ws, data }: { ws: Workspace; data: Snapshot }) {
  const { view, busy, navigate, refresh, act, setNotice, jobId, setJobId, quality, setQuality, kind, setKind,
    query, setQuery, activityPlatform, setActivityPlatform, activityTime, setActivityTime,
    creation, setCreation, page, setPage, loading, discoveryMode, setDiscoveryMode,
    previewPlan, setPreviewPlan, pager, showResults, setRunId } = ws;
  const filtered = data.artifacts;
  return (
    <>
      {view === "activities" && <ActivityTools onChange={refresh} onRun={() => navigate("runs")} plans={data.plans} active={data.stats.activePlanIds.includes("creator-activities")} />}
      {view === "discover" && <section className="daily-overview" aria-label="工作台概览">
        <div className="daily-overview-head"><div><span>{data.discovery ? `最近研究 · ${data.discovery.planName} · ${date(data.discovery.at)}` : "尚无研究记录"}</span><h2>线索、判断和异常，都从这里进入</h2><p>{data.discovery ? `本轮读取 ${data.discovery.sources.reduce((n, s) => n + s.raw, 0)} 条，入模 ${data.discovery.sources.reduce((n, s) => n + s.selected, 0)} 条；下方可查看本轮覆盖。` : "配置来源后开始第一次研究，原始线索会单独保留。"}</p></div><button onClick={() => navigate(data.config.hasApiKey ? "plans" : "settings")}>{data.config.hasApiKey ? "查看研究策略" : "配置模型"} <ArrowUpRight size={15} /></button></div>
        <div className="overview-links">
          <button onClick={() => navigate("hotspots")}><span>原始热点 · 近 14 天</span><strong>{data.stats.hotspotRemaining}</strong><small>未消费 · 共 {data.stats.hotspotTotal} 条（已消费 {data.stats.hotspotConsumed}）↗</small></button>
          <button onClick={() => { setDiscoveryMode("results"); setQuality("ready"); setPage(1); }}><span>通过检查</span><strong>{data.stats.qualityCounts.ready}</strong><small>查看可考虑的推荐 ↗</small></button>
          <button onClick={() => { setDiscoveryMode("results"); setQuality("review"); setPage(1); }}><span>待验证</span><strong>{data.stats.qualityCounts.review}</strong><small>查看缺失证据 ↗</small></button>
          <button onClick={() => { setDiscoveryMode("results"); setQuality("rejected"); setPage(1); }}><span>已否决</span><strong>{data.stats.qualityCounts.rejected}</strong><small>查看排除理由 ↗</small></button>
          <button onClick={() => navigate("hotspots")}><span>来源读取失败</span><strong>{data.stats.sourceFailures}</strong><small>查看失败来源与旧线索 ↗</small></button>
          <button onClick={() => navigate("runs")}><span>失败任务</span><strong>{data.stats.failedRuns}</strong><small>查看原因与重试入口 ↗</small></button>
        </div>
      </section>}
      {view === "discover" && <><nav className="discovery-modes" aria-label="每日发现视图">{(["results", "watch", "coverage"] as const).map(mode => <button key={mode} className={discoveryMode === mode ? "active" : ""} aria-current={discoveryMode === mode ? "page" : undefined} onClick={() => setDiscoveryMode(mode)}>{mode === "results" ? "分析结果" : mode === "watch" ? `本轮待观察${data.discovery ? ` ${data.discovery.candidates.filter(c => c.status === "watch").length}` : ""}` : "本轮来源覆盖"}</button>)}</nav><button className="text-button" onClick={() => navigate("hotspots")}>查看全部原始热点 →</button></>}
      {(view !== "discover" || discoveryMode === "results") && <>
        {jobId && <p className="context-note">正在查看本次研究的全部结果（含待验证和已否决）。<button onClick={() => { setJobId(""); setPage(1); }}>查看所有研究</button></p>}
        <div className="filter-row">
          <label className="search">
            <Search size={17} />
            <input
              aria-label="搜索研究内容"
              placeholder="搜索主题、读者或标签"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            />
          </label>
          <Select
            aria-label="质量状态"
            value={quality}
            onChange={(e) => { setQuality(e.target.value); setPage(1); }}
          >
            <option value="ready">推荐 · 通过检查</option>
            <option value="review">待验证</option>
            <option value="active">推荐与待验证</option>
            <option value="rejected">已否决</option>
            <option value="all">全部（含已否决）</option>
          </Select>
          {view === "activities" && <><Select aria-label="活动平台" value={activityPlatform} onChange={e => { setActivityPlatform(e.target.value); setPage(1); }}>{["all", "哔哩哔哩", "抖音", "快手", "小红书"].map(v => <option key={v} value={v}>{v === "all" ? "全部平台" : v}</option>)}</Select><Select aria-label="活动时间" value={activityTime} onChange={e => { setActivityTime(e.target.value); setPage(1); }}>{Object.entries({ actionable: "当前可参与", ongoing: "进行中", upcoming: "未开始", unknown: "时间待核实", ended: "已结束", all: "全部时间（含历史）" }).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></>}
          {view === "library" && <Select aria-label="筛选创作状态" value={creation} onChange={e => { setCreation(e.target.value); setPage(1); }}><option value="all">全部创作状态</option>{Object.entries(creationLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
        </div>
        {loading && <p role="status">正在加载列表…</p>}
        {view === "discover" && (
          <div className="tabs">
            <button
              className={kind === "all" ? "active" : ""}
              onClick={() => { setKind("all"); setPage(1); }}
            >
              全部
            </button>
            {Object.entries(kindLabels).map(([k, label]) => (
              <button
                className={kind === k ? "active" : ""}
                key={k}
                onClick={() => { setKind(k); setPage(1); }}
              >
                {label}
                <span>
                  {data.stats.counts[k] || 0}
                </span>
              </button>
            ))}
          </div>
        )}
        {view === "trends" && (
          <p className="context-note">
            指标来自原始来源，保留地域、时间与单位。不把单次上榜解释为增长，也不把热度等同付费需求。
          </p>
        )}
        {view === "activities" && <p className="context-note">默认展示全部活动结果；使用「活动时间」和「质量状态」筛选当前可参与、待验证、已结束或已否决的记录。原始快照请在上方「创作活动」资料视图中查看。</p>}
        {view === "ideas" && (
          <p className="context-note">
            此区域始终私有。每个机会都应包含现有替代、最小流程、实验与停止条件。
          </p>
        )}
        {!filtered.length ? (
          <Empty
            title={
              jobId ? "本次研究没有符合条件的结果" : query ? "没有匹配的研究内容" : view === "activities" && activityTime === "actionable" ? "暂无通过核验且仍可参与的活动" : quality === "ready" && data.stats.review > 0 ? "暂无通过检查的推荐" : "这里还没有研究结果"
            }
          >
            {jobId ? <button onClick={() => { const id = jobId; navigate("runs"); setRunId(id); }}>查看研究说明与缺失证据</button> : view === "library"
              ? "从每日发现收藏值得继续的内容。"
              : view === "activities" ? "可查看待验证活动、检查官方规则，或从四平台活动中心导入新活动。" : quality === "ready" && data.stats.review > 0 ? <button onClick={() => { setQuality("review"); setPage(1); }}>查看待验证内容与缺失证据</button> : "运行一条研究策略，或在外部接入页导入证据包，再进行分析。"}
          </Empty>
        ) : (
          <div className="discovery-list">
            {filtered.map((a, index) => (
              <article className="discovery-row" key={a.id}>
                <div className="row-number">
                  {String((data.pagination.artifacts.page - 1) * data.pagination.artifacts.pageSize + index + 1).padStart(2, "0")}
                </div>
                <div className="row-content">
                  <div className="row-meta">
                    {["approved", "drafting", "published"].includes(a.decision || "pending") && <span className="creation-badge">{creationLabels[a.creationStatus || "inbox"]}</span>}
                    <span>{kindLabels[a.kind]}</span>
                    <span>
                      {a.visibility === "private" ? "私有" : "公开"}
                    </span>
                    <span>{date(a.createdAt)}</span>
                    <span className={"quality-badge " + a.quality}>
                      {decisionLabels[decisionOf(a)]}
                    </span>
                  </div>
                  <button
                    className="article-title"
                    onClick={() => ws.setSelected(a)}
                  >
                    {a.title}
                  </button>
                  <p>{a.personalImpact}</p>
                  {a.kind === "activity" && <ActivityCard activity={a} />}
                  <div className="tags">
                    {a.tags.map((t) => (
                      <button key={t} onClick={() => { setQuery(t); setPage(1); }}>
                        {t}
                      </button>
                    ))}
                  </div>
                  {a.kind === "trend" && (
                    <small>
                      {a.details.region} · {a.details.window} ·{" "}
                      {a.details.intent}
                    </small>
                  )}
                </div>
                <div className="row-side">
                  <small>{a.evidenceIds.length} 条证据</small>
                  <button onClick={() => ws.setSelected(a)}>
                    查看研究 <ArrowUpRight size={15} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {pager(data.pagination.artifacts, setPage)}
      </>}
      {view === "discover" && discoveryMode === "coverage" && <div className="toolbar"><Select aria-label="采集预览策略" value={previewPlan} onChange={e => setPreviewPlan(e.target.value)}>{data.plans.filter(p => p.kind !== "activities" && p.sourceIds.some(id => data.sources.some(s => s.id === id && s.enabled && s.type !== "web"))).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select><button disabled={busy} onClick={() => void act(async () => { const result = await api<{ evidenceCount: number; warnings: string[] }>("source-preview", { planId: previewPlan }); setNotice(result.evidenceCount ? `已采集 ${result.evidenceCount} 条证据，${result.warnings.length} 个来源提示；未调用 AI。` : `来源读取完成，但没有命中当前焦点词和关键词；请检查策略筛选。未调用 AI。`); })}>只采集预览 · 不调用 AI</button></div>}
      {view === "discover" && discoveryMode !== "results" && <DiscoveryLens record={data.discovery} mode={discoveryMode} />}
    </>
  );
}
