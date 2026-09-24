import {z} from "zod";
export const activityPlatforms=[
 {name:"哔哩哔哩",url:"https://www.bilibili.com/blackboard/activity-list.html",entry:"官方活动列表；按页查看活动"},
 {name:"抖音",url:"https://creator.douyin.com/creator-micro/creative-guidance/calendar",entry:"创作者中心 → 灵感中心 → 活动日历"},
 {name:"快手",url:"https://cp.kuaishou.com/creative/activity-calendar",entry:"创作者服务平台 → 创作服务 → 活动中心"},
 {name:"小红书",url:"https://creator.xiaohongshu.com/new/events",entry:"创作服务平台 → 活动中心 → 全部活动"},
];
export function officialActivityUrl(value:string){try{const u=new URL(value);return u.protocol==="https:"&&!u.username&&!u.password&&["bilibili.com","douyin.com","douyinstatic.com","kuaishou.com","xiaohongshu.com"].some(d=>u.hostname===d||u.hostname.endsWith("."+d));}catch{return false;}}
export const activityPageSchema=z.object({schemaVersion:z.literal("draftdesk.activity-page.v1"),title:z.string().trim().min(3).max(300),url:z.string().url().max(2048).refine(officialActivityUrl,"请使用四个平台的官方 HTTPS 来源地址"),text:z.string().trim().min(50).max(12000),capturedAt:z.string().datetime().optional()});
