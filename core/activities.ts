import type {ArtifactDraft,Evidence} from "./schema";
export type Activity=Extract<ArtifactDraft,{kind:"activity"}>;
export function activityStatus(a:Activity,at=Date.now()){
 const d=a.details;
 if(!d.dateQuote||![d.startsAt,d.endsAt].filter(Boolean).every(value=>d.dateQuote.includes(value!.slice(0,4))))return "unknown";
 const start=a.details.startsAt?Date.parse(a.details.startsAt):null,end=a.details.endsAt?Date.parse(a.details.endsAt):null;
 if(start!==null&&end!==null&&start>end)return "unknown";
 if(end!==null&&end<at)return "ended";
 if(start!==null&&start>at)return "upcoming";
 if(start!==null&&end!==null&&start<=at&&end>=at)return "ongoing";
 return "unknown";
}
export const activityStatusLabels={ended:"已结束",upcoming:"未开始",ongoing:"进行中",unknown:"时间待核实"};
export const activityFitLabels={suitable:"方向适合 · 门槛仍需自行核对",verify:"参与资格待核实",ineligible:"不符合参与条件"};
export function activityIssues(a:Activity,all:Evidence[]){
 const d=a.details,refs=all.filter(e=>a.evidenceIds.includes(e.id)),issues:string[]=[];
 const canonical=(u:string)=>{try{const x=new URL(u);return x.origin+x.pathname.replace(/\/$/,"")+x.search;}catch{return u;}};
 if(!refs.some(e=>canonical(e.url)===canonical(d.activityUrl)))issues.push("活动地址没有对应的已采集证据，不能使用猜测的活动链接。");
 if(!refs.some(e=>e.sourceType==="official"&&e.contentLevel!=="headline"))issues.push("缺少官方活动规则原文，当前仅是活动线索。");
 if(d.access!=="public")issues.push("活动规则需登录核对或只有搜索线索。");
 if(!d.startsAt||!d.endsAt)issues.push("活动起止时间不完整，不能确认仍可参与。");
 if((d.startsAt||d.endsAt)&&(!d.dateQuote||!refs.some(e=>e.excerpt.includes(d.dateQuote))||!/(?:20\d{2})/.test(d.dateQuote)))issues.push("活动时间缺少包含年份的原文锚点，请勿用采集日期推断活动年份。");
 if(d.startsAt&&d.endsAt&&Date.parse(d.startsAt)>Date.parse(d.endsAt))issues.push("活动开始时间晚于结束时间。");
 if(d.fit!=="suitable")issues.push("活动参与条件尚未匹配或明确不符。");
 if(new Set(d.directions.map(x=>x.angle+JSON.stringify(x.outline))).size<d.directions.length)issues.push("内容方向重复，需要不同的创作切口与提纲。");
 if(d.directions.some(x=>/(?:百万|千万|爆款|涨粉|赚了|获奖)/.test(x.title)&&/(?:我|亲测|实测)/.test(x.title)))issues.push("内容标题可能暗示未经证实的个人成绩；创作前改为实验目标，不可直接宣称播放量、收入或获奖。");
 return issues;
}
