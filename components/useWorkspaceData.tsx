"use client";
// 工作台数据与交互中枢（PHASE 5 自 Workbench.tsx 纯移动拆出）：
// 全部状态、URL 同步、轮询刷新与操作包装。视图组件经 ws 对象取用，
// 解构后沿用原变量名——视图内 JSX 与拆分前逐字一致。
import { newlyFinished, readWorkspaceLocation, type JobActivity } from "../core/workspace-ui";
import { formatApiError, api } from "./ui";
import { useEffect, useRef, useState } from "react";
import type { Artifact, Plan, Source, Job } from "../core/schema";
import type { DiscoveryRecord } from "../core/discovery";
import type { HotspotFeed } from "../core/hotspots";
import { type PageInfo, Pagination } from "./Pagination";

export type Snapshot = {
  jobActivity: JobActivity[];
  pagination: { artifacts: PageInfo; jobs: PageInfo; submissions: PageInfo };
  stats: { artifacts: number; review: number; counts: Record<string, number>; qualityCounts: { ready: number; review: number; rejected: number }; hotspotTotal: number; hotspotRemaining: number; hotspotConsumed: number; sourceFailures: number; failedRuns: number; running: number; activePlanIds: string[] };
  config: any;
  plans: Plan[];
  sources: Source[];
  artifacts: Artifact[];
  jobs: Job[];
  connections: any[];
  conversations: any[];
  submissions: any[];
  worker?: { heartbeat: string };
  budget: { reserved: number; limit: number };
  evidence: any[];
  discovery: DiscoveryRecord | null;
  hotspots: HotspotFeed | null;
};

export function useWorkspaceData() {
  const [data, setData] = useState<Snapshot | null>(null),
    [view, setView] = useState("discover"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [mobile, setMobile] = useState(false),
    [selected, setSelected] = useState<Artifact | null>(null),
    [plan, setPlan] = useState<Plan | null>(null),
    [source, setSource] = useState<Source | null>(null),
    [discussionArtifact, setDiscussionArtifact] = useState<
      Artifact | undefined
    >(),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState("all"),
    [quality, setQuality] = useState("active"),
    [skills, setSkills] = useState<any[]>([]),
    [skill, setSkill] = useState<any>(),
    [today, setToday] = useState("");
  const [page, setPage] = useState(1), [jobsPage, setJobsPage] = useState(1), [receiptsPage, setReceiptsPage] = useState(1);
  const [hotspotPage, setHotspotPage] = useState(1), [hotspotConsumed, setHotspotConsumed] = useState("hide"), [hotspotQ, setHotspotQ] = useState(""), [hotspotStatus, setHotspotStatus] = useState("all"), [hotspotSource, setHotspotSource] = useState("all"), [hotspotPlan, setHotspotPlan] = useState("all");
  const [loading, setLoading] = useState(false);
  const [hotspotSort, setHotspotSort] = useState("interested");
  const [activityPlatform, setActivityPlatform] = useState("all"), [activityTime, setActivityTime] = useState("all");
  const [locationReady, setLocationReady] = useState(false), [creation, setCreation] = useState("all"), [jobId, setJobId] = useState(""), [runId, setRunId] = useState("");
  const [finished, setFinished] = useState<Snapshot["jobActivity"]>([]);
  const [discoveryMode, setDiscoveryMode] = useState<"queue" | "results" | "watch" | "coverage">("queue");
  const [sourceChecks, setSourceChecks] = useState<Record<string, string>>({});
  const [outlines, setOutlines] = useState<any[]>([]);
  const [clusters, setClusters] = useState<any[]>([]);
  const [discussionContext, setDiscussionContext] = useState<import("./ActionButtons").DiscussContext | null>(null);
  const [seoTerms, setSeoTerms] = useState<any[]>([]);
  const [previewPlan, setPreviewPlan] = useState("daily-editorial");
  const knownJobs = useRef(new Map<string, string>()), activityReady = useRef(false), activitySince = useRef(Date.now()), restoreScroll = useRef(true);
  const requestKey = new URLSearchParams({ activityPlatform, activityTime, creation, jobId, runId, page: String(page), jobsPage: String(jobsPage), receiptsPage: String(receiptsPage), hotspotPage: String(hotspotPage), hotspotConsumed, hotspotQ, hotspotStatus, hotspotSource, hotspotPlan, hotspotSort, view, kind, quality, q: query, pageSize: "20" }).toString();
  const currentKey = useRef(requestKey), requestVersion = useRef(0);
  currentKey.current = requestKey;
  async function refresh() {
    const key = currentKey.current, version = ++requestVersion.current;
    const [next, outlineList, clusterList, seoTermList] = await Promise.all([
      api<Snapshot>("workspace?" + key),
      api<{ items: any[] }>("outlines"),
      api<{ items: any[] }>("clusters"),
      api<{ items: any[] }>("seo-terms"),
    ]);
    if (currentKey.current === key && requestVersion.current === version) {
      setData(next);
      // UI GET /outlines、/clusters 返回 {items:[...]} 包裹形状
      setOutlines(outlineList?.items ?? []);
      setClusters(clusterList?.items ?? []);
      setSeoTerms(seoTermList?.items ?? []);
      const completed = activityReady.current ? newlyFinished(next.jobActivity, knownJobs.current, activitySince.current) : [];
      if (completed.length) setFinished(old => [...completed, ...old.filter(j => !completed.some(n => n.id === j.id))].slice(0, 8));
      next.jobActivity.forEach(j => knownJobs.current.set(j.id, j.state)); activityReady.current = true;
      if (restoreScroll.current) { restoreScroll.current = false; let y = 0; try { y = Number(sessionStorage.getItem("draftdesk.scroll." + key)) || 0; } catch { } requestAnimationFrame(() => window.scrollTo(0, y)); }
    }
  }
  useEffect(() => {
    const restore = () => { const v = readWorkspaceLocation(window.location.search); setActivityPlatform(v.activityPlatform); setActivityTime(v.activityTime); setView(v.view); setQuery(v.q); setKind(v.kind); setQuality(v.quality); setPage(v.page); setJobsPage(v.jobsPage); setReceiptsPage(v.receiptsPage); setHotspotPage(v.hotspotPage); setHotspotConsumed(v.hotspotConsumed || "hide"); setHotspotQ(v.hotspotQ); setHotspotStatus(v.hotspotStatus); setHotspotSource(v.hotspotSource); setHotspotPlan(v.hotspotPlan); setCreation(v.creation); setJobId(v.jobId); setRunId(v.runId); setSelected(null); restoreScroll.current = true; setLocationReady(true); };
    restore(); window.addEventListener("popstate", restore); return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (!locationReady) return;
    window.history.replaceState(null, "", "?" + requestKey);
    const save = () => { try { sessionStorage.setItem("draftdesk.scroll." + requestKey, String(window.scrollY)); } catch { } };
    window.addEventListener("scroll", save, { passive: true }); return () => window.removeEventListener("scroll", save);
  }, [requestKey, locationReady]);
  useEffect(() => {
    if (!locationReady) return;
    let alive = true;
    setLoading(true);
    void refresh().catch(e => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoading(false) });
    const timer = setInterval(() => { void refresh().catch(() => { }); }, 4000);
    return () => { alive = false; clearInterval(timer); requestVersion.current++; };
  }, [requestKey, locationReady]);
  useEffect(() => {
    setToday(new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long", timeZone: "Asia/Shanghai" }));
    void api<any[]>("skills")
      .then(setSkills)
      .catch(() => { });
    void (async () => {
      try {
        const raw = localStorage.getItem("draftdesk.workspace.v1");
        if (raw && !localStorage.getItem("draftdesk.migrated.v2")) {
          await api("migrate-local", JSON.parse(raw));
          localStorage.setItem("draftdesk.migrated.v2", "yes");
        }
      } catch {
        setError("旧选题自动迁移未完成，原浏览器数据仍保留；可导出后重试。");
      }
    })();
  }, []);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }
  function navigate(v: string) {
    window.history.pushState(null, "", "?view=" + v);
    setCreation("all"); setJobId(""); setRunId("");
    setQuality("active");
    // Keep the full activity result set visible when entering the section. Users can
    // narrow it with the explicit time filter, but navigation should never hide old
    // or unverified records silently.
    setActivityTime("all");
    setView(v);
    setPage(1); setJobsPage(1); setReceiptsPage(1);
    setHotspotPage(1);
    setMobile(false);
    setQuery("");
    setNotice("");
    setError("");
  }
  function showResults(id: string) { navigate("discover"); setJobId(id); setQuality("all"); setKind("all"); }
  async function moveSelected(direction: number) {
    if (!data || !selected) return;
    const index = data.artifacts.findIndex(a => a.id === selected.id);
    const next = data.artifacts[index + direction];
    if (next) { setSelected(next); return; }
    const nextPage = data.pagination.artifacts.page + direction;
    if (nextPage < 1 || nextPage > data.pagination.artifacts.pages) return;
    setBusy(true);
    try { const q = new URLSearchParams(currentKey.current); q.set("page", String(nextPage)); const result = await api<Snapshot>("workspace?" + q); const target = direction > 0 ? result.artifacts[0] : result.artifacts.at(-1); if (target) { setPage(nextPage); setSelected(target); } } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const pager = (info: PageInfo, change: (page: number) => void) => <Pagination info={info} onChange={change} disabled={loading || busy} />;
  return {
    data, view, error, setNotice, notice, busy, mobile, setMobile,
    outlines, clusters, seoTerms, discussionContext, setDiscussionContext,
    selected, setSelected, plan, setPlan, source, setSource,
    discussionArtifact, setDiscussionArtifact,
    query, setQuery, kind, setKind, quality, setQuality,
    skills, setSkills, skill, setSkill, today,
    page, setPage, jobsPage, setJobsPage, receiptsPage, setReceiptsPage,
    hotspotPage, setHotspotPage, hotspotConsumed, setHotspotConsumed,
    hotspotQ, setHotspotQ, hotspotStatus, setHotspotStatus, hotspotSource, setHotspotSource, hotspotPlan, setHotspotPlan, hotspotSort, setHotspotSort,
    loading, activityPlatform, setActivityPlatform, activityTime, setActivityTime,
    locationReady, creation, setCreation, jobId, setJobId, runId, setRunId,
    finished, setFinished, discoveryMode, setDiscoveryMode,
    sourceChecks, setSourceChecks, previewPlan, setPreviewPlan,
    refresh, act, navigate, showResults, moveSelected, pager,
  };
}

export type Workspace = ReturnType<typeof useWorkspaceData>;
