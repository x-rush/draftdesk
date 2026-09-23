"use client";
import {useState} from "react";
import type {Job,Plan,Source} from "../core/schema";
import {api} from "./ui";
import {queryPlan,searchIntents} from "../core/research-policy";
export function PlanPreview({plan,sources}:{plan:Plan;sources:Source[]}) {
  const initial=Math.max(0,plan.maxQueries-Math.min(2,Math.floor(plan.maxQueries/2)));
  return <details><summary>搜罗计划预览</summary><p>{plan.goal}</p><p>受众：{plan.audience} · 近 {plan.lookbackDays} 天</p>
    <p>最多 {plan.maxQueries} 次搜索（含最多 2 次补证）、{plan.maxEvidence} 条证据、{plan.maxItems} 条产物；{plan.maxModelCalls} 次模型调用 / {plan.maxTokens.toLocaleString()} token 预留。</p>
    <ul>{sources.filter(s=>plan.sourceIds.includes(s.id)).map(s=><li key={s.id}>{s.name} · {s.enabled?"启用":"关闭，不会读取"} · {s.note}</li>)}</ul>
    <p>检索方向：{searchIntents[plan.kind].join("；")}</p><ol>{queryPlan(plan,initial).map((q,i)=><li key={i}>{q.query}</li>)}</ol>
    <p>内容筛选：{plan.focusTerms?.join("、") || "不限"}；标题或正文命中任一词才保留。</p>
    {plan.kind === "trends" && plan.requireMetrics && <p>热词证据门槛：必须有原始指标，无指标时不调用模型。</p>}
    <p>域名：{plan.includeDomains.join("、")||"不限"}；排除：{plan.excludeKeywords.join("、")||"无"}。仅启用网页来源时执行以上查询。具体补证问题由材料缺口决定，没有合适材料可以零推荐。</p></details>;
}
export function ResearchBrief({job}:{job:Job}) {
  const [value,setValue]=useState<any>(null),[error,setError]=useState("");
  return <details onToggle={e=>{if(e.currentTarget.open)void api("job-context/"+job.id).then(setValue).catch(()=>setError("读取失败，请关闭后重试。"))}}>
    <summary>研究结果说明</summary><p>{job.outcome==="no-findings"?"本轮无新增推荐，不代表系统错误。":job.state==="failed"?"研究失败，已保存的材料仍保留。":`当前阶段：${job.stage}`}</p>
    {!!job.warnings.length&&<><h4>来源问题</h4><ul>{job.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></>}
    {error&&<p role="alert">{error}</p>}{!value&&!error&&<p>读取中…</p>}
    {value&&<><h4>补证与未知项</h4>{value.verification?.length?<ul>{value.verification.map((v:any,i:number)=><li key={i}>{v.question}：{v.status} · {v.evidenceIds.length} 条候选</li>)}</ul>:<p>本次没有定向补证记录；不能据此认定已全部核实。</p>}
      <h4>筛除与不推荐原因</h4><ul>{[...(value.analysis?.excluded||[]),...(value.draft?.rejected||[])].map((r:any,i:number)=><li key={i}>{r.reason}</li>)}</ul>
      {job.outcome==="no-findings"&&<p>{job.steps.at(-1)?.detail}</p>}
      <p>草稿 {value.draft?.items?.length??0} 条；审核结论见关联产物。收到外部资料不等于通过审核。</p></>}
  </details>;
}
