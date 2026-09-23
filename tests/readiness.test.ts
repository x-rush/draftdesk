import test from "node:test";
import assert from "node:assert/strict";
import { evidence, topic, plan } from "./fixtures";
import type { ArtifactDraft } from "../core/schema";
import { collectionGaps, evidenceReadiness } from "../core/readiness";
import { qualityIssues } from "../core/quality";
import { metricComparison, type MetricSnapshot } from "../core/history";
import { webSourceType, relevant, parseFeed } from "../core/sources";

const idea: Extract<ArtifactDraft,{kind:"idea"}> = {...topic,kind:"idea",details:{job:"整理访谈负责人",trigger:"访谈结束",frequency:"未知",alternatives:["手工表格"],differentiation:"核对遗漏",mvp:["导入","核对"],nonGoals:[],willingnessToPay:"未知",experiment:"先人工代办一次",successCriteria:"用户复用",stopCriteria:"现有办法足够"}};
test("社区宣传、未引用的问题和伪造引文不能成为需求候选",()=>{
  assert.equal(evidenceReadiness(idea,evidence).find(c=>c.key==="problem")?.status,"missing");
  const draft={...idea,claims:[{statement:"问题样本",type:"fact" as const,evidenceIds:["ev-two"],quote:evidence[1].excerpt}]};
  assert.equal(evidenceReadiness(draft,evidence).find(c=>c.key==="problem")?.status,"candidate");
  assert.equal(evidenceReadiness({...draft,claims:[{...draft.claims[0],quote:"虚构的求助原话"}]},evidence).find(c=>c.key==="problem")?.status,"missing");
  const promotional=evidence.map(e=>({...e,excerpt:"这款工具非常好，推荐大家使用。"}));
  assert.ok(collectionGaps({...plan,kind:"opportunity"},promotional).length);
  assert.ok(qualityIssues(draft,evidence).some(i=>i.includes("实际付费行为")));
});
test("人物渠道要求具体页面，不以同域名或相同姓名自动合并账号",()=>{
  const person: ArtifactDraft={...topic,kind:"person",details:{name:"测试作者",identity:"待核对",publicChannels:["https://example.com/profile?id=b"],recentWork:[],angles:[],identityCaveat:"同名待核对"}};
  const sources=[{...evidence[0],url:"https://example.com/profile?id=a",excerpt:"测试作者的公开主页，提供作品与组织署名。"},evidence[1]];
  const checks=evidenceReadiness(person,sources);
  assert.equal(checks.find(c=>c.key==="identity")?.status,"candidate");
  assert.equal(checks.find(c=>c.key==="channels")?.status,"missing");
  person.details.publicChannels=[sources[0].url];
  assert.equal(evidenceReadiness(person,sources).find(c=>c.key==="channels")?.status,"candidate");
});
test("关键价格事实需要对应官方原文而不是只挂一个来源ID",()=>{
  const draft={...topic,claims:[{statement:"工具免费开放",type:"fact" as const,evidenceIds:["ev-one"]}]};
  assert.ok(qualityIssues(draft,evidence).some(i=>i.includes("原文锚点")));
  assert.equal(evidenceReadiness(topic,evidence).find(c=>c.key==="primary")?.status,"candidate");
});
test("地域未知与排名变化不能产生增长率，但明确地域的连续计数可比较",()=>{
  const a:MetricSnapshot={id:"one",seriesId:"series",evidenceId:"ev",title:"词",url:"https://example.org",region:"US",at:"2026-09-20T00:00:00Z",name:"搜索量",unit:"次",period:"2026-09-20T00:00:00Z",cadence:"day",value:"100",numeric:100};
  const b={...a,id:"two",period:"2026-09-21T00:00:00Z",numeric:200,value:"200"};
  assert.equal(metricComparison([a],b).percent,100);
  assert.equal(metricComparison([a],{...b,region:"未知"}).percent,null);
  assert.equal(metricComparison([a],{...b,name:"榜单排名"}).percent,null);
});
test("网页搜索来源的官方偏好不能给任意结果授予官方标签",()=>{
  assert.equal(webSourceType("https://unverified.example/news","official"),"other");
  assert.equal(webSourceType("https://vendor.example/update","other",["vendor.example"]),"official");
  assert.equal(webSourceType("https://vendor.example.attacker.test/update","other",["vendor.example"]),"other");
  assert.equal(webSourceType("https://github.com/org/repo/issues/1","official"),"community");
});
test("内容筛选同时约束RSS和网页，英文短词不误匹配其他单词",()=>{
  const p={...plan,focusTerms:["AI","字幕"],lookbackDays:90};
  const input={...evidence[0],publishedAt:undefined,title:"Chair updates",excerpt:"Chair company news"};
  assert.equal(relevant(input,p),false);
  assert.equal(relevant({...input,title:"AI captions"},p),true);
  assert.equal(relevant({...input,title:"剪映字幕纠错"},p),true);
  assert.equal(relevant(input,{...p,focusTerms:[]}),true);
});
test("RSS保留可用正文而不是只给模型一行摘要",()=>{
  const rows=parseFeed('<rss><channel><item><title>Test</title><link>https://example.org/item</link><description>摘要</description><content:encoded><![CDATA[<p>正文包含付费范围和限制</p>]]></content:encoded></item></channel></rss>',{id:"test",name:"test",type:"rss",url:"https://example.org/rss",enabled:true,sourceType:"official",note:""});
  assert.equal(rows[0].excerpt,"正文包含付费范围和限制");
});
