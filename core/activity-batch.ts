import {z} from "zod";
import {officialActivityUrl} from "./activity-import";

export const activityBatchItemSchema=z.object({
 platform:z.enum(["哔哩哔哩","抖音","快手","小红书"]),
 title:z.string().trim().min(3).max(300),
 url:z.string().url().max(2048).refine(officialActivityUrl),
 text:z.string().max(12000),
 dateText:z.string().max(200),
 endsAt:z.string().datetime().optional(),
 completeness:z.enum(["detail","summary"]),
 capturedAt:z.string().datetime(),
}).strict();
export const activityBatchSchema=z.object({schemaVersion:z.literal("draftdesk.activity-batch.v1"),keywords:z.array(z.string().trim().min(1).max(80)).max(20),platform:z.string().max(30),items:z.array(activityBatchItemSchema).max(100),warnings:z.array(z.string().max(500)).max(50).default([])}).strict();
export type ActivityBatchItem=z.infer<typeof activityBatchItemSchema>;

function isPlatformListUrl(value:string){
 const u=new URL(value);
 return u.hostname==="www.bilibili.com"&&u.pathname==="/blackboard/activity-list.html"
  ||u.hostname==="creator.xiaohongshu.com"&&u.pathname==="/new/events"
  ||u.hostname==="creator.douyin.com"&&u.pathname==="/creator-micro/creative-guidance/calendar"
  ||u.hostname==="cp.kuaishou.com"&&u.pathname==="/creative/activity-calendar";
}

export function activityBatchDecision(item:ActivityBatchItem,keywords:string[],at=Date.now()){
 if(!item.endsAt)return {eligible:false,reason:"截止日期缺少年份或未取得，不能判定仍可参与"};
 const deadline=Date.parse(item.endsAt);
 if(!Number.isFinite(deadline))return {eligible:false,reason:"截止日期无效"};
 if(deadline<at)return {eligible:false,reason:"活动已过期"};
 if(item.completeness!=="detail"||item.text.trim().length<50)return {eligible:false,reason:"只有列表摘要，缺少可分析的规则详情"};
 if(keywords.length&&!keywords.some(word=>(item.title+" "+item.text).toLocaleLowerCase().includes(word.toLocaleLowerCase())))return {eligible:false,reason:"未命中目标关键词"};
 if(isPlatformListUrl(item.url))return {eligible:false,reason:"只有活动中心列表地址，缺少可核对的单条官方活动链接"};
 return {eligible:true,reason:"可提交分析；资格和奖励仍需核验"};
}
