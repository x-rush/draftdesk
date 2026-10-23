import { PLATFORM_KEYS, platformLabel } from "../core/platforms";
import { useState } from "react";
import type {HotspotFeed} from "../core/hotspots";
import type {Source} from "../core/schema";
import {Pagination} from "./Pagination";
import {Select} from "./Select";
import {ArchiveButton} from "./ActionButtons";
import {date,Skeleton} from "./ui";

type HotspotsProps = {
  feed:HotspotFeed|null;sources:Source[];query:string;status:string;source:string;plan:string;busy:boolean;loading?:boolean;consumed?:boolean;onConsumed?:(value:boolean)=>void;
  onQuery:(value:string)=>void;onStatus:(value:string)=>void;onSource:(value:string)=>void;onPlan:(value:string)=>void;
  onPage:(page:number)=>void;onRefresh:()=>void;hotspotSort?:string;onSort:(value:string)=>void;
  onDiscuss:(row:any)=>void;onArchive:(row:any)=>void;
  onPromote:(row:any,payload:{clusterId:string;platform:string;angle:string})=>void;
  clusters:any[];clusterId?:string;plans?:any[];batch?:any;
};
export function Hotspots({feed,sources,query,status,source,plan,busy,loading,consumed,onConsumed,onQuery,onStatus,onSource,onPlan,onPage,onRefresh,onDiscuss,onArchive,onPromote,clusters,clusterId,hotspotSort,onSort,plans,batch}:HotspotsProps){
  const [promoting,setPromoting]=useState<string|null>(null);
  const [promotePlatform,setPromotePlatform]=useState("gzh");
  const [promoteCluster,setPromoteCluster]=useState(clusterId||"clu-inbox");
  const [promoteAngle,setPromoteAngle]=useState("");
  const available=sources.filter(s=>s.enabled&&["hotlist","aggregated","trends"].includes(s.type));
  // 来源三态标注（未采集笼统标注拆解，小拾 UI 建议落地）：
  // 上次采集失败（排了但失败，sourceHealth）/ 已排期待首采（绑定启用计划但当前批次无产出）/ 未排进计划（孤儿源，去研究策略勾选生效）
  // R10.8 P1-7：调度已废弃——改判「今日全量采集批覆盖」：在批里=已采，不在=未进今日批
  const collectedIds = new Set((batch?.sources || []).map((s: any) => s.sourceId));
  const healthById=new Map((feed?.sourceHealth||[]).map(s=>[s.id,s]));
  const uncollectedLabel=(id:string)=>{
    if(healthById.get(id)?.status==="failed")return" · 上次采集失败";
    // R10.14 P1-1：全部 available 源都标三态——今日已采/上次采集失败/未进今日批
    const cov=batch?.sources?.find((s:any)=>s.sourceId===id);
    if(cov?.status==="failed")return" · 上次采集失败";
    if(collectedIds.has(id))return" · 今日已采";
    if(!batch?.sources)return""; // 无批次信息不标
    return" · 未进今日批";
  };
  return <section className="hotspot-view" aria-label="热点列表">
    <div className="hotspot-controls hotspot-controls-wide">
      <input aria-label="搜索热点" placeholder="搜索标题、来源或筛选原因" value={query} onChange={e=>onQuery(e.target.value)}/>
      <Select aria-label="热点来源" value={source} onChange={e=>onSource(e.target.value)}><option value="all">全部来源</option>{available.map(s=><option value={s.id} key={s.id}>{s.name}{uncollectedLabel(s.id)}</option>)}</Select>
      <Select aria-label="热点状态" value={status} onChange={e=>onStatus(e.target.value)}><option value="all">全部线索</option><option value="watch">待观察</option><option value="selected">进入过分析</option><option value="filtered">被策略筛除</option></Select>
      <Select aria-label="排序方式" value={hotspotSort||"interested"} onChange={e=>onSort(e.target.value)}><option value="interested">感兴趣分类置顶</option><option value="time">纯时间序</option></Select>
      <Select aria-label="采集策略" value={plan} onChange={e=>onPlan(e.target.value)}><option value="all">全部采集批次</option>{feed?.planOptions.map(name=><option value={name} key={name}>{name}</option>)}</Select>
      <label className="check" style={{ margin: "0 0 0 auto", whiteSpace: "nowrap" }}><input type="checkbox" checked={!!consumed} onChange={e=>onConsumed?.(e.target.checked)} />查看已消费</label>
    </div>
    <details className="hotspot-health fold-card">
      <summary>采集状态{feed?.lastCollectedAt?` · 最近采集 ${date(feed.lastCollectedAt)}`:""}{feed?.sourceHealth.some(s=>s.status==="failed")?` · ${feed.sourceHealth.filter(s=>s.status==="failed").length} 个来源读取失败`:""}</summary>
      <div className="hotspot-actions" style={{ margin: "8px 0" }}><button className="button-secondary" disabled={busy||source==="all"||!available.some(s=>s.id===source)} onClick={onRefresh}>刷新所选来源（不调用 AI）</button><span className="helper-text">{source==="all"?"选择一个来源即可读取它的最新公开榜单。":"刷新不会更改研究策略，也不会产生 AI 推荐。"}</span></div>
      <p className="helper-text">这些是线索，不是已验证事实、连续增长率或发布建议；榜单热度只表示该平台当时的信号。</p>
      {feed?.sourceHealth.filter(s=>s.status==="failed"&&(source==="all"||source===s.id)).map(s=><p className="helper-text" role="status" key={s.id} style={{ color: "#9a6948" }}>{s.name} 最近一次读取失败（{date(s.at)}）：{s.error||"请检查来源状态后重试"}。该来源的旧线索仍保留。</p>)}
    </details>
    {loading&&!feed?.items.length?<Skeleton rows={3} label="热点加载中"/>:!feed?.items.length?<div className="lens-empty"><h2>当前筛选下没有热点</h2><p className="muted">去「研究策略」运行一次采集，或在上方刷新所选来源。</p><p>选择已启用来源刷新榜单，或清除搜索与状态筛选。来源读取失败可在「运行记录」和采集覆盖中核对。</p></div>:<div className="discovery-list">{feed.items.map(row=><article className="discovery-row" key={row.url}>
      <div className="row-content">
        <div className="row-meta">
          <span className="pill">{row.status==="selected"?"已归组":row.status==="filtered"?"被策略筛除":"待观察"}</span>
          <span>{row.sourceNames.join(" · ")}</span>
          <span>{date(row.lastSeen)}</span>
          {row.observations>1&&<span>观察 {row.observations} 次</span>}
          {row.region&&<span>{row.region}</span>}
        </div>
        <a className="article-title" href={row.url} target="_blank" rel="noopener noreferrer">{row.title} ↗</a>
        <p>{row.reason||"待观察线索"}</p>
        <div className="tags">
          {row.category&&<span>{row.category}</span>}
          {row.metric&&<span>{row.metric.name}：{row.metric.value} {row.metric.unit}</span>}
          {row.mediaType==="video"&&<span>🎬 视频</span>}
          <span>关联采集：{row.planNames.join("、")}</span>
        </div>
      </div>
      <div className="row-side">
        <button aria-label={`讨论：${row.title}`} onClick={()=>onDiscuss(row)}>讨论</button>
        <button aria-label={`推进：${row.title}`} onClick={()=>setPromoting(promoting===row.url?null:row.url)}>推进</button>
        <ArchiveButton onConfirm={()=>onArchive(row)} disabled={busy}/>
        {promoting===row.url&&<div style={{display:"grid",gap:6,padding:10,border:"1px solid var(--line)",borderRadius:9,minWidth:260}}>
          <Select aria-label="适配平台" value={promotePlatform} onChange={e=>setPromotePlatform(e.target.value)}>{PLATFORM_KEYS.map(p=><option key={p} value={p}>{platformLabel(p)}</option>)}</Select>
          <Select aria-label="目标簇" value={promoteCluster} onChange={e=>setPromoteCluster(e.target.value)}><option value="clu-inbox">选题收集箱</option>{clusters.filter(c=>c.id!=="clu-inbox").map(c=><option key={c.id} value={c.id}>{c.topic}</option>)}</Select>
          <input aria-label="一句话写作角度" placeholder="一句话写作角度（可选）" value={promoteAngle} onChange={e=>setPromoteAngle(e.target.value)}/>
          <button className="primary" disabled={busy} onClick={()=>{onPromote(row,{clusterId:promoteCluster,platform:promotePlatform,angle:promoteAngle});setPromoting(null);}}>生成为选题（进每日发现）</button>
        </div>}
      </div>
    </article>)}</div>}
    {feed&&<Pagination info={{page:feed.page,pages:feed.pages,pageSize:feed.pageSize,total:feed.total}} onChange={onPage} disabled={busy}/>}
  </section>;
}
