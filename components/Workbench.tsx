"use client";
// 工作台外壳（PHASE 5 拆分后）：侧边导航 / 顶栏 / 视图路由 / 抽屉挂载。
// 状态与交互在 useWorkspaceData；六个视图各自成文件——本文件不再含视图内联 JSX。
import { newlyFinished, type JobActivity } from "../core/workspace-ui";
import { Hotspots } from "./Hotspots";
import { formatApiError, api, download, Drawer, Empty } from "./ui";
import { Review } from "./Review";
import type { Artifact, Plan, Source } from "../core/schema";
import { ArtifactPanel } from "./ArtifactPanel";
import { PlanEditor, SourceEditor } from "./ResearchSetup";
import { Discussion } from "./Discussion";
import { Connections } from "./Connections";
import { useWorkspaceData, type Snapshot } from "./useWorkspaceData";
import { DiscoverView } from "./views/DiscoverView";
import { PlansView } from "./views/PlansView";
import { SourcesView } from "./views/SourcesView";
import { RunsView } from "./views/RunsView";
import { SkillsView } from "./views/SkillsView";
import { Settings } from "./Settings";
import {
  BookOpen,
  Compass,
  FlaskConical,
  TrendingUp,
  MessageSquare,
  Settings2,
  Plug,
  Layers,
  Play,
  PanelLeft,
  ArrowUpRight,
  RefreshCw,
  Leaf,
  Flame,
  ClipboardCheck,
} from "lucide-react";
const nav = [
  ["discover", "每日发现", Compass],
  ["hotspots", "热点列表", Flame],
  ["chat", "研究讨论", MessageSquare],
  ["trends", "热词趋势", TrendingUp],
  ["ideas", "应用机会", FlaskConical],
  ["activities", "创作活动", Compass],
  ["decisions", "审查台", ClipboardCheck],
  ["plans", "研究策略", Layers],
  ["sources", "数据源", BookOpen],
  ["runs", "运行记录", Play],
  ["connections", "外部接入", Plug],
  ["skills", "研究 Skills", Leaf],
  ["settings", "模型与设置", Settings2],
] as const;
const navGroups = [
  { label: "发现与创作", ids: ["discover", "hotspots", "chat"] },
  { label: "机会观察", ids: ["trends", "ideas", "activities", "decisions"] },
  { label: "研究与设置", ids: ["plans", "sources", "runs", "connections", "skills", "settings"] },
] as const;
const headings: Record<string, [string, string]> = {
  discover: [
    "找到值得写，也值得做的事",
    "先看变化与个人影响，再决定投入哪一个想法。",
  ],
  hotspots: ["别让热点在筛选时消失", "先看原始榜单线索，再决定哪些值得补查和分析。"],
  library: [
    "把值得继续的想法留下",
    "收藏不是发布。每条选题都可以继续补证据、推敲和创作。",
  ],
  trends: [
    "热词之外，读懂真实信号",
    "保留地域、时间与指标口径；热度和需求分开判断。",
  ],
  ideas: [
    "先验证一个具体问题",
    "产品动态提供可能性，真实用户任务决定是否值得做。",
  ],
  decisions: ["把待写队列拍成板", "建议可以多源，拍板只能一个：通过、否决、暂缓，一次一批。"],
  activities: ["找到值得参与的创作活动", "AI、Vibe Coding 与可参与的创作激励；先核对规则，再选择内容方向。"],
  chat: ["让观点多走一步", "带着证据讨论，整理成可继续编辑的内容或应用方案。"],
  plans: [
    "设计你的研究节奏",
    "目标、来源、关键词和预算，共同决定每天的研究质量。",
  ],
  sources: [
    "从可靠的线索开始",
    "清楚知道每个来源能提供什么，以及不能证明什么。",
  ],
  runs: ["看得见每一步研究", "采集、整理、分析与审稿，各自留下可追溯的记录。"],
  skills: [
    "把好方法变成可重复的流程",
    "按需加载的研究规程，配合数据合同与质量门槛执行。",
  ],
  connections: [
    "你的智能体，统一的工作台",
    "内置研究与外部工具使用同一套证据和产物标准。",
  ],
  settings: [
    "连接模型，设好边界",
    "百炼统一用于分析与讨论；预算和密钥留在服务端。",
  ],
};
export function Workbench() {
  const ws = useWorkspaceData();
  const { data, view, error, notice, busy, mobile, setMobile, selected, setSelected,
    plan, setPlan, source, setSource, discussionArtifact, setDiscussionArtifact,
    skill, setSkill, today, finished, setFinished, refresh, act, navigate, showResults, moveSelected, setRunId, setNotice } = ws;
  const titles = headings[view], running = data?.stats.running || 0;
  return (
    <div className="app-shell">
      <aside className={"sidebar " + (mobile ? "open" : "")}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("discover");
          }}
        >
          <span>
            <Leaf size={24} />
          </span>
          <strong>
            拾题<small>DraftDesk</small>
          </strong>
          <b>02</b>
        </a>
        <div className="workspace-label">
          <span className="avatar">我</span>
          <div>
            <strong>个人研究工作台</strong>
            <small>证据 → 观点 → 行动</small>
          </div>
        </div>
        <nav aria-label="工作台导航">
          {navGroups.map(group => <div className="nav-group" key={group.label}>
            <small className="nav-divider">{group.label}</small>
            {group.ids.map(id => { const item = nav.find(n => n[0] === id)!; const [, label, Icon] = item; return <button key={id} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => navigate(id)}><Icon size={18} />{label}{id === "runs" && running > 0 && <em>{running}</em>}</button> })}
          </div>)}
        </nav>
        <footer>
          <span className="dot" />
          本机 Docker · 个人版
          <button
            title="导出不含密钥的工作数据"
            disabled={busy}
            onClick={() =>
              void act(async () =>
                download("draftdesk-workspace.json", await api("export")),
              )
            }
          >
            导出工作数据
          </button>
        </footer>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <button
              className="icon menu"
              aria-label="打开导航"
              onClick={() => setMobile(!mobile)}
            >
              <PanelLeft size={20} />
            </button>
            <span>我的工作台</span>
            <span className="slash">/</span>
            <strong>{nav.find((n) => n[0] === view)?.[1]}</strong>
          </div>
          <div>
            <span
              className={
                "worker-status " +
                (data?.worker &&
                  Date.now() - Date.parse(data.worker.heartbeat) < 60000
                  ? "online"
                  : "")
              }
            >
              {data?.worker &&
                Date.now() - Date.parse(data.worker.heartbeat) < 60000
                ? "研究引擎在线"
                : data
                  ? "研究引擎未就绪"
                  : "正在检查研究引擎"}
            </span>
            <button
              className="icon"
              aria-label="刷新工作台"
              onClick={() => void act(refresh)}
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <p className="date-stamp">
                {today}
              </p>
              <h1>{titles[0]}</h1>
              <p>{titles[1]}</p>
            </div>
            {data &&
              ["discover", "trends", "ideas", "activities"].includes(view) && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => navigate("plans")}
                >
                  开始一次研究 <ArrowUpRight size={16} />
                </button>
              )}
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => void act(refresh)}>重新连接</button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          {!data && !error && (
            <Empty title="正在打开工作台">读取持久化研究数据…</Empty>
          )}
          {finished.map(j => <section className="task-notice" role="status" key={j.id}><div><strong>{j.name} · {j.state === "completed" ? "已完成" : j.state === "failed" ? "失败" : "已取消"}</strong><p>{j.state === "completed" ? `新增 ${j.total} 条结果，其中 ${j.review} 条待验证。` : "查看运行说明，处理来源或配置后可手动重试。"}</p></div><button onClick={() => { if (j.state === "completed") showResults(j.id); else { navigate("runs"); setRunId(j.id); } }}>{j.state === "completed" ? "查看本次结果" : "查看运行说明"}</button><button aria-label="关闭任务提示" onClick={() => setFinished(old => old.filter(x => x.id !== j.id))}>关闭</button></section>)}
          {data && (
            <>
              {view === "decisions" && <Review />}
              {view === "hotspots" && <div className="toolbar"><label className="check"><input type="checkbox" checked={ws.hotspotConsumed !== "hide"} onChange={e => { ws.setHotspotConsumed(e.target.checked ? "include" : "hide"); ws.setHotspotPage(1); }} />查看已消费</label></div>}
              {view === "hotspots" && <Hotspots feed={data.hotspots} sources={data.sources} query={ws.hotspotQ} status={ws.hotspotStatus} source={ws.hotspotSource} plan={ws.hotspotPlan} busy={busy}
                onQuery={value => { ws.setHotspotQ(value); ws.setHotspotPage(1); }} onStatus={value => { ws.setHotspotStatus(value); ws.setHotspotPage(1); }} onSource={value => { ws.setHotspotSource(value); ws.setHotspotPage(1); }} onPlan={value => { ws.setHotspotPlan(value); ws.setHotspotPage(1); }} onPage={ws.setHotspotPage}
                onRefresh={() => void act(async () => { const result = await api<{ count: number; source: string }>("hotspot-refresh", { sourceId: ws.hotspotSource }); setNotice(`${result.source} 已刷新 ${result.count} 条热点线索，未调用 AI。`); })}
                onDiscuss={(row) => { ws.setDiscussionContext({ title: row.title, url: row.url, source: row.sourceNames[0] || "" }); navigate("chat"); }}
                onArchive={(row) => void act(async () => { await api("consume", { target: "hotspots", ids: [row.url], reason: "off-domain" }); setNotice("已归档：该热点不再出现在默认列表（可切换「查看已消费」找回）。"); })}
                onPromote={(row, payload) => void act(async () => { await api("outlines", { clusterId: payload.clusterId, platform: payload.platform, contentType: "资讯解读", title: row.title, keyPoints: [payload.angle].filter(Boolean), evidenceRefs: [row.url] }); setNotice("已生成为选题（进入每日发现待拍队列）。"); })}
                clusters={ws.clusters} />}
              {["discover", "library", "trends", "ideas", "activities"].includes(
                view,
              ) && <DiscoverView ws={ws} data={data} />}
              {view === "plans" && <PlansView ws={ws} data={data} />}
              {view === "sources" && <SourcesView ws={ws} data={data} />}
              {view === "runs" && <RunsView ws={ws} data={data} />}
              {view === "skills" && <SkillsView ws={ws} />}
              {view === "connections" && (
                <Connections
                  connections={data.connections}
                  receipts={data.submissions}
                  pagination={ws.pager(data.pagination.submissions, ws.setReceiptsPage)}
                  plans={data.plans}
                  onChange={refresh}
                  sources={data.sources} jobs={data.jobs} artifacts={data.artifacts} onOpen={setSelected}
                />
              )}
              {view === "chat" && (
                <Discussion
                  key={discussionArtifact?.id || ws.discussionContext?.url || "free"}
                  artifact={discussionArtifact}
                  history={data.conversations}
                  onChange={refresh}
                  hotspotContext={ws.discussionContext ?? undefined}
                  onOutlineCreated={refresh}
                />
              )}
              {view === "settings" && (
                <Settings config={data.config} onChange={refresh} />
              )}
            </>
          )}
        </main>
        <footer className="page-footer">
          让每个好想法，都有依据和下一步。
          <span>DraftDesk 2 · 私人研究工作台</span>
        </footer>
      </div>
      {selected && (
        <ArtifactPanel
          key={selected.id}
          artifact={selected}
          navigation={data && data.artifacts.some(a => a.id === selected.id) ? <div className="detail-navigation"><button disabled={busy || data.pagination.artifacts.page === 1 && data.artifacts[0]?.id === selected.id} onClick={() => void moveSelected(-1)}>上一条</button><span>按当前列表顺序浏览 · Esc 关闭</span><button disabled={busy || data.pagination.artifacts.page === data.pagination.artifacts.pages && data.artifacts.at(-1)?.id === selected.id} onClick={() => void moveSelected(1)}>下一条</button></div> : undefined}
          onClose={() => setSelected(null)}
          onChange={refresh}
          onDiscuss={(a) => {
            setDiscussionArtifact(a);
            setSelected(null);
            navigate("chat");
          }}
        />
      )}
      {plan && data && (
        <PlanEditor
          initial={plan}
          sources={data.sources}
          onClose={() => setPlan(null)}
          onSaved={refresh}
        />
      )}
      {source && (
        <SourceEditor
          initial={source}
          onClose={() => setSource(null)}
          onSaved={refresh}
        />
      )}{" "}
      {skill && (
        <Drawer
          title={skill.name}
          subtitle={"版本 " + skill.version + " · " + skill.digest}
          onClose={() => setSkill(undefined)}
          wide
        >
          <pre className="skill-content">{skill.content}</pre>
        </Drawer>
      )}
    </div>
  );
}
