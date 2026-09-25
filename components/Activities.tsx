"use client";
import {ActivityImport} from "./ActivityImport";

import {useState} from "react";
import type {ArtifactDraft,Plan} from "../core/schema";
import {activityStatus,activityStatusLabels,activityFitLabels} from "../core/activities";
import {isActivityIndexUrl} from "../core/activity-import";
import {api,Field} from "./ui";
export function ActivityCard({activity}:{activity:Extract<ArtifactDraft,{kind:"activity"}>}){
 const d=activity.details,status=activityStatus(activity);
 return <section className="activity-card"><div className="tags"><span>{d.platform}</span><span>{activityStatusLabels[status]}</span><span>{activityFitLabels[d.fit]}</span><span>{d.access==="public"?"公开规则":d.access==="login_required"?"登录可见官方规则":"待核实线索"}</span></div>
 <p><strong>活动介绍：</strong>{activity.summary}</p><p><strong>投稿时间：</strong>{status==="unknown"?`时间待核实。来源时间摘录：${d.dateQuote||"未提供"}；请打开规则确认年份与期限。`:d.dateText}</p>
 {status!=="unknown"&&d.startsAt&&<p>开始：{new Date(d.startsAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}（北京时间）</p>}{status!=="unknown"&&d.endsAt&&<p>截止：{new Date(d.endsAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}（北京时间）</p>}
 <p><strong>激励说明：</strong>{d.rewards}</p><p><strong>参与门槛：</strong>{d.eligibility}</p><p><strong>适合程度：</strong>{d.fitReason}</p>
 <a href={d.activityUrl} target="_blank" rel="noopener noreferrer">{isActivityIndexUrl(d.activityUrl)?"打开活动中心，按标题查找 ↗":"打开活动来源与规则 ↗"}</a>
 <details><summary>投稿要求</summary><ul>{d.requirements.map((r,i)=><li key={i}>{r}</li>)}</ul></details>
 <details open={status!=="ended"&&d.fit!=="ineligible"}><summary>{d.directions.length} 个 AI 内容方向{status==="ended"||d.fit==="ineligible"?"（仅供参考）":"（创作建议）"}</summary>{d.directions.map((x,i)=><section className="activity-direction" key={i}><h3>{i+1}. {x.title}</h3><p>{x.angle}</p><p>形式：{x.format} · 投入：{x.effort}</p><ol>{x.outline.map((step,j)=><li key={j}>{step}</li>)}</ol><p>对应规则：{x.ruleFit}</p></section>)}</details>
 </section>;
}
export function ActivityTools({onChange,onRun,plans,active}:{onChange:()=>Promise<void>;onRun:()=>void;plans:Plan[];active:boolean}){
 return <ActivityImport onChange={onChange} onRun={onRun} active={active}/>;
}
