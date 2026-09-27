import test from "node:test";
import assert from "node:assert/strict";
import {activityBatchDecision,activityBatchLead,activityBatchSchema,activityMaterialStatus,manualActivityDeadline} from "../core/activity-batch";

test("采集范围字段缺少可见总量时统一归一为 null",()=>{
 const data=activityBatchSchema.parse({schemaVersion:"draftdesk.activity-batch.v1",keywords:["AI"],platform:"抖音",warnings:[],items:[],coverage:{scope:"current_month",requestedPages:1,scannedPages:1,note:"只覆盖当前月份"}});
 assert.equal(data.coverage?.visibleTotal,null);
 assert.equal(data.coverage?.hasMore,null);
});

test("批量活动只允许未过期、命中用户关键词且有详情的材料进入模型",()=>{
 const now=Date.parse("2026-09-24T03:00:00Z");
 const data=activityBatchSchema.parse({schemaVersion:"draftdesk.activity-batch.v1",keywords:["Vibe Coding"],platform:"小红书",warnings:[],items:[{platform:"小红书",title:"Vibe Coding 小工具创作活动",url:"https://fe.xiaohongshu.com/ditto/vincent/activity-id",text:"官方活动详情：面向创作者征集 AI 小工具开发过程，要求展示作品与方法，并使用指定活动话题提交笔记。",dateText:"2026-09-01 至 2026-09-30",endsAt:"2026-09-30T15:59:59Z",completeness:"detail",capturedAt:"2026-09-24T03:00:00Z"}]});
 const item=data.items[0];
 assert.equal(activityBatchDecision(item,["Vibe Coding"],now).eligible,true);
 assert.equal(activityBatchDecision({...item,endsAt:"2026-09-23T15:59:59Z"},["Vibe Coding"],now).reason,"活动已过期");
 assert.equal(activityBatchDecision({...item,endsAt:undefined},["Vibe Coding"],now).eligible,false);
 assert.equal(activityBatchDecision({...item,completeness:"summary"},["Vibe Coding"],now).eligible,false);
 assert.equal(activityBatchDecision(item,["非目标关键词"],now).eligible,false);
 assert.equal(activityBatchDecision({...item,url:"https://creator.xiaohongshu.com/new/events"},["Vibe Coding"],now).eligible,false);
 const calendar={...item,platform:"抖音" as const,url:"https://creator.douyin.com/creator-micro/creative-guidance/calendar",sourceLocator:item.title};
 assert.equal(activityBatchDecision(calendar,["Vibe Coding"],now).eligible,true);
 assert.match(activityBatchDecision(calendar,["Vibe Coding"],now).reason,/按标题复核/);
 assert.equal(activityBatchDecision({...calendar,sourceLocator:"其他活动"},["Vibe Coding"],now).eligible,false);
});

test("手动活动导入在模型调用前拒绝过期、无年份和不在原文的截止日",()=>{
 const at=Date.parse("2026-09-25T00:00:00Z");
 assert.equal(manualActivityDeadline("2026-09-30","活动时间：2026年09月01日至2026年09月30日",at).eligible,true);
 assert.match(manualActivityDeadline("2026-09-24","活动时间：2026年09月01日至2026年09月24日",at).reason,/已过期/);
 assert.match(manualActivityDeadline("2026-09-30","活动时间：09月01日至09月30日",at).reason,/原文/);
 assert.equal(manualActivityDeadline("2026-09-31","活动时间：2026年09月31日",at).eligible,false);
});

test("相关但缺规则的活动保留为待核线索，不误送付费分析",()=>{
 const at=Date.parse("2026-09-26T00:00:00Z");
 const item=activityBatchSchema.parse({schemaVersion:"draftdesk.activity-batch.v1",keywords:["vibecoding"],platform:"小红书",warnings:[],items:[{platform:"小红书",title:"国风小工具，点开直接玩！",url:"https://fe.xiaohongshu.com/ditto/vincent/example",text:"国风vibecoding 活动时间 09-14 至 09-30",dateText:"09-14 至 09-30",completeness:"summary",capturedAt:"2026-09-26T00:00:00Z"}]}).items[0];
 assert.equal(activityBatchLead(item,["vibecoding"],at),true);
 assert.equal(activityBatchDecision(item,["vibecoding"],at).eligible,false);
 assert.equal(activityBatchLead(item,["非目标"],at),false);
 assert.equal(activityBatchLead({...item,endsAt:"2026-09-25T15:59:59Z"},["vibecoding"],at),false);
});

test("材料时间状态三分：进行中、已过期、日期不明",()=>{
 const base={platform:"哔哩哔哩" as const,title:"示例活动",url:"https://www.bilibili.com/blackboard/era/x.html",text:"",dateText:"",completeness:"summary" as const,capturedAt:"2026-09-26T00:00:00.000Z"};
 const at=Date.parse("2026-09-27T00:00:00.000Z");
 assert.equal(activityMaterialStatus({...base,endsAt:"2026-10-30T15:59:59.000Z"},at),"live");
 assert.equal(activityMaterialStatus({...base,endsAt:"2026-09-01T15:59:59.000Z"},at),"expired");
 assert.equal(activityMaterialStatus(base,at),"unknown");
});
