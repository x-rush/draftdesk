import test from "node:test";
import assert from "node:assert/strict";
import {activityBatchDecision,activityBatchSchema} from "../core/activity-batch";

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
});
