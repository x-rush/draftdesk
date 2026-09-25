"use client";
import type {HotspotFeed} from "../core/hotspots";
import type {Source} from "../core/schema";
import {Pagination} from "./Pagination";
import {Select} from "./Select";
import {date} from "./ui";

export function Hotspots({feed,sources,query,status,source,plan,busy,onQuery,onStatus,onSource,onPlan,onPage,onRefresh}:{
  feed:HotspotFeed|null;sources:Source[];query:string;status:string;source:string;plan:string;busy:boolean;
  onQuery:(value:string)=>void;onStatus:(value:string)=>void;onSource:(value:string)=>void;onPlan:(value:string)=>void;
  onPage:(page:number)=>void;onRefresh:()=>void;
}){
  const available=sources.filter(s=>s.enabled&&["hotlist","aggregated","trends"].includes(s.type));
  return <section className="hotspot-view" aria-label="热点列表">
    <div className="hotspot-intro"><div><h2>所有搜到的热点，先在这里看</h2><p>合并最近 14 天内置研究、采集预览和独立快照的原始标题。被关键词筛掉、未入模的条目也保留；榜单热度只表示该平台当时的信号。</p></div><span>{feed?.total??0} 条匹配</span></div>
    <div className="hotspot-controls">
      <input aria-label="搜索热点" placeholder="搜索标题、来源或筛选原因" value={query} onChange={e=>onQuery(e.target.value)}/>
      <Select aria-label="热点来源" value={source} onChange={e=>onSource(e.target.value)}><option value="all">全部来源</option>{feed?.sourceOptions.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}{available.filter(s=>!feed?.sourceOptions.some(option=>option.id===s.id)).map(s=><option value={s.id} key={s.id}>{s.name} · 尚未采集</option>)}</Select>
      <Select aria-label="热点状态" value={status} onChange={e=>onStatus(e.target.value)}><option value="all">全部线索</option><option value="watch">待观察</option><option value="selected">进入过分析</option><option value="filtered">被策略筛除</option></Select>
      <Select aria-label="采集策略" value={plan} onChange={e=>onPlan(e.target.value)}><option value="all">全部采集批次</option>{feed?.planOptions.map(name=><option value={name} key={name}>{name}</option>)}</Select>
    </div>
    <div className="hotspot-actions"><button disabled={busy||source==="all"||!available.some(s=>s.id===source)} onClick={onRefresh}>刷新所选来源 · 不调用 AI</button><span>{source==="all"?"选择一个来源即可读取它的最新公开榜单。":"刷新不会更改研究策略，也不会产生 AI 推荐。"}</span></div>
    {feed?.lastCollectedAt&&<p className="hotspot-note">最近一次采集：{date(feed.lastCollectedAt)}。这些是线索，不是已验证事实、连续增长率或发布建议。</p>}
    {feed?.sourceHealth.filter(s=>s.status==="failed"&&(source==="all"||source===s.id)).map(s=><p className="hotspot-note" role="status" key={s.id}>{s.name} 最近一次读取失败（{date(s.at)}）：{s.error||"请检查来源状态后重试"}。该来源的旧线索仍保留。</p>)}
    {!feed?.items.length?<div className="lens-empty"><h2>当前筛选下没有热点</h2><p>选择已启用来源刷新榜单，或清除搜索与状态筛选。来源读取失败可在「运行记录」和采集覆盖中核对。</p></div>:<div className="hotspot-list">{feed.items.map(row=><article className="hotspot-card" key={row.url}>
      <div className="hotspot-card-top"><span>{row.sourceNames.join(" · ")}</span><small>{date(row.lastSeen)} · {row.observations>1?`观察 ${row.observations} 次`:`榜单位置 ${row.rank??"未知"}`}</small></div>
      <h3><a href={row.url} target="_blank" rel="noopener noreferrer">{row.title} ↗</a></h3>
      <div className="hotspot-card-meta"><span>{row.status==="selected"?"曾进入分析":row.status==="filtered"?"被策略筛除":"待观察"}</span><span>{row.region||"地域未知"}</span>{row.metric&&<span>{row.metric.name}：{row.metric.value} {row.metric.unit}</span>}</div>
      <p>{row.reason}</p><small>关联采集：{row.planNames.join("、")}</small>
    </article>)}</div>}
    {feed&&<Pagination info={{page:feed.page,pages:feed.pages,pageSize:feed.pageSize,total:feed.total}} onChange={onPage} disabled={busy}/>}
  </section>;
}
