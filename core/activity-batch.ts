import {z} from "zod";
import {officialActivityUrl,isActivityIndexUrl} from "./activity-import";

export const activityBatchItemSchema=z.object({
 platform:z.enum(["哔哩哔哩","抖音","快手","小红书"]),
 title:z.string().trim().min(3).max(300),
 url:z.string().url().max(2048).refine(officialActivityUrl),
 text:z.string().max(12000),
 dateText:z.string().max(200),
 endsAt:z.string().datetime().optional(),
 completeness:z.enum(["detail","summary"]),
 sourceLocator:z.string().trim().min(3).max(200).optional(),
 capturedAt:z.string().datetime(),
}).strict();
export const activityBatchSchema=z.object({schemaVersion:z.literal("draftdesk.activity-batch.v1"),keywords:z.array(z.string().trim().min(1).max(80)).max(20),platform:z.string().max(30),items:z.array(activityBatchItemSchema).max(100),warnings:z.array(z.string().max(500)).max(50).default([])}).strict();
export type ActivityBatchItem=z.infer<typeof activityBatchItemSchema>;

export function manualActivityDeadline(date:string,sourceText:string,at=Date.now()){
 const match=/^(20\d{2})-(\d{2})-(\d{2})$/.exec(date);
 if(!match)return {eligible:false,reason:"请填写从官方规则核对的投稿截止日期"};
 const [,year,month,day]=match;
 const end=Date.UTC(Number(year),Number(month)-1,Number(day),15,59,59);
 const parsed=new Date(end);
 if(parsed.getUTCFullYear()!==Number(year)||parsed.getUTCMonth()!==Number(month)-1||parsed.getUTCDate()!==Number(day))return {eligible:false,reason:"投稿截止日期无效"};
 if(end<at)return {eligible:false,reason:"活动已过期，不能提交 AI 分析"};
 const marker=new RegExp(`${year}\\s*[年/.\\-]\\s*0?${Number(month)}\\s*[月/.\\-]\\s*0?${Number(day)}\\s*日?`);
 if(!marker.test(sourceText))return {eligible:false,reason:"规则正文没有包含该年份和截止日期的原文；请先核对并粘贴官方规则"};
 return {eligible:true,reason:"日期已核对；资格与奖励仍需分析后复核"};
}

export function activityBatchDecision(item:ActivityBatchItem,keywords:string[],at=Date.now()){
 if(!item.endsAt)return {eligible:false,reason:"截止日期缺少年份或未取得，不能判定仍可参与"};
 const deadline=Date.parse(item.endsAt);
 if(!Number.isFinite(deadline))return {eligible:false,reason:"截止日期无效"};
 if(deadline<at)return {eligible:false,reason:"活动已过期"};
 if(keywords.length&&!keywords.some(word=>(item.title+" "+item.text).toLocaleLowerCase().includes(word.toLocaleLowerCase())))return {eligible:false,reason:"未命中目标关键词"};
 if(item.completeness!=="detail"||item.text.trim().length<50)return {eligible:false,reason:"只有列表摘要，缺少可分析的规则详情"};
 if(isActivityIndexUrl(item.url)){
  if(item.sourceLocator!==item.title)return {eligible:false,reason:"只有活动中心地址，缺少可按标题定位的完整官方规则"};
  return {eligible:true,reason:"可分析官方页面详情；缺单条链接，结果须按标题复核"};
 }
 return {eligible:true,reason:"可提交分析；资格和奖励仍需核验"};
}
