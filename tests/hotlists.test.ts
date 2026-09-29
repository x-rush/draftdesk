import test from "node:test";
import assert from "node:assert/strict";
import {parseBaiduHotlist,parseWeiboHotlist,parseGithubTrending,parseHackerNewsStory,parseAggregateHotlist,parseBilibiliPopular,parseWeiboHotSearch} from "../core/hotlists";
import {metricComparison,type MetricSnapshot} from "../core/history";
import {defaultPlans,defaultSources} from "../core/defaults";

test("百度官方热榜提取词条、来源和即时指数，不把列表 HTML 当空结果",()=>{
 const html='<div class="category-wrap_iQLoo horizontal"><div class="hot-index_1Bl1a"> 123456 </div><div class="content_1YWBm"><a href="https://www.baidu.com/s?wd=AI%E8%A7%86%E9%A2%91&amp;sa=fyb" class="title_dIF3B " target="_blank"><div class="c-single-text-ellipsis"> AI视频工具 </div></a><div class="hot-desc_1m_jR small_Uvkd3">创作者讨论AI视频</div></div></div>';
 const [item]=parseBaiduHotlist(html,"2026-09-24T02:00:00.000Z");
 assert.equal(item.title,"AI视频工具");assert.equal(item.sourceType,"trend");assert.equal(item.region,"CN");assert.equal(item.metric?.value,"123456");assert.match(item.url,/www\.baidu\.com\/s\?/);
 assert.throws(()=>parseBaiduHotlist("<html>维护中</html>","2026-09-24T02:00:00.000Z"));
});

test("微博访客验证明确失败；即时热榜快照不计算增长率",()=>{
 assert.throws(()=>parseWeiboHotlist("<title>Sina Visitor System</title>","2026-09-24T02:00:00.000Z"),/访客验证/);
 const first:MetricSnapshot={id:"1",seriesId:"x",evidenceId:"a",title:"AI",url:"https://top.baidu.com/board?tab=realtime",region:"CN",at:"2026-09-24T01:00:00Z",name:"百度热搜指数",unit:"指数",period:"2026-09-24T01:00:00Z",cadence:"instant",value:"100",numeric:100};
 const second={...first,id:"2",period:"2026-09-24T02:00:00Z",value:"200",numeric:200};
 assert.equal(metricComparison([first,second],second).percent,null);
});

test("热词策略采集层不设话题门禁：热度全收，联想来源用需求形状种子",()=>{
 const plan=defaultPlans.find(p=>p.id==="trend-radar")!;
 assert.ok(plan.sourceIds.includes("baidu-hot"));
 assert.ok(plan.sourceIds.includes("suggest-cn"));
 assert.ok(plan.sourceIds.includes("suggest-global"));
 // 采集层完全开放：空 keywords/focusTerms 让 relevanceReason 跳过话题筛选，
 // AI 话题之外的社会热度也能进入分析层。
 assert.equal(plan.keywords.length,0);
 assert.equal(plan.focusTerms?.length,0);
 // 转化判断（AI 内容/web-app 工具/SEO 站群）写在分析目标里。
 assert.match(plan.goal,/AI 内容/);
 assert.match(plan.goal,/web\/app 工具机会/);
 assert.match(plan.goal,/SEO\/站群价值/);
 const suggest=defaultSources.find(s=>s.id==="suggest-cn")!;
 const seeds=suggest.query??"";
 assert.match(seeds,/替代/);
 assert.match(seeds,/怎么查/);
 assert.doesNotMatch(seeds,/Codex/);
});

test("GitHub Trending 只取仓库链接及当日 Stars，不把登录链接当来源",()=>{
 const html='<article class="Box-row"><a href="/login?return_to=x">登录</a><h2 class="h3 lh-condensed"><a data-test="x" href="/owner/ai-tool">owner / ai-tool</a></h2><p class="col-9 color-fg-muted my-1 pr-4">AI video workflow</p><span>123 stars today</span></article>';
 const [item]=parseGithubTrending(html,"2026-09-24T02:00:00.000Z");
 assert.equal(item.url,"https://github.com/owner/ai-tool");
 assert.equal(item.metric?.value,"123");
 assert.equal(item.metric?.cadence,"instant");
 assert.throws(()=>parseGithubTrending("<html>rate limited</html>","2026-09-24T02:00:00.000Z"));
});

test("Hacker News 官方故事保留讨论链接与原文地址，分数只作平台热度",()=>{
 const item=parseHackerNewsStory({id:42,type:"story",title:"AI video tool",url:"https://example.org/demo",score:99,time:1790200000},1,"2026-09-24T02:00:00.000Z");
 assert.equal(item?.url,"https://news.ycombinator.com/item?id=42");
 assert.match(item?.excerpt||"",/example\.org\/demo/);
 assert.equal(item?.metric?.cadence,"instant");
 assert.equal(parseHackerNewsStory({id:43,type:"comment",text:"hello"},2,"2026-09-24T02:00:00.000Z"),null);
});

test("聚合热榜只接收原平台 HTTPS 链接，明确标记获取方式和即时口径",()=>{
 const items=parseAggregateHotlist({code:200,updateTime:"2026-09-24T01:45:00.000Z",data:[
  {title:"AI 视频创作",url:"https://www.bilibili.com/video/BV123",hot:12345},
  {title:"伪造链接",url:"https://example.com/other",hot:999},
  {title:"明文链接",url:"http://www.bilibili.com/video/BV456"},
 ]},"bilibili","2026-09-24T02:00:00.000Z");
 assert.equal(items.length,1);
 assert.equal(items[0].url,"https://www.bilibili.com/video/BV123");
 assert.deepEqual(items[0].acquisition,{method:"aggregator",provider:"DailyHotApi",platform:"B站",observedAt:"2026-09-24T01:45:00.000Z"});
 assert.equal(items[0].metric?.cadence,"instant");
 assert.equal(items[0].contentLevel,"headline");
 assert.throws(()=>parseAggregateHotlist({code:500,data:[]},"bilibili","2026-09-24T02:00:00.000Z"),/格式异常/);
 assert.throws(()=>parseAggregateHotlist({code:200,updateTime:"2026-09-24T01:45:00.000Z",data:[{title:"标题",url:"https://example.com"}]},"bilibili","2026-09-24T02:00:00.000Z"),/没有有效原平台链接/);
 assert.throws(()=>parseAggregateHotlist({code:200,updateTime:"2026-09-23T00:00:00.000Z",data:[{title:"AI",url:"https://www.bilibili.com/video/BV123"}]},"bilibili","2026-09-24T02:00:00.000Z"),/超过 2 小时/);
});

test("B站官方热门接口：解析视频条目与播放量，短链优先，坏载荷报格式异常",()=>{
 const items=parseBilibiliPopular({code:0,data:{list:[
  {title:"AI 工作流实测",bvid:"BV1xx411c7mD",short_link_v2:"https://b23.tv/abc123",owner:{name:"测试UP主"},stat:{view:123456}},
  {title:"无编号条目",owner:{name:"x"},stat:{view:99}},
 ]}},"2026-09-29T10:00:00.000Z");
 assert.equal(items.length,1);
 assert.equal(items[0].url,"https://b23.tv/abc123");
 assert.equal(items[0].metric?.value,"123456");
 assert.equal(items[0].metric?.name,"B站热门播放量");
 assert.deepEqual(items[0].acquisition,{method:"platform",provider:"B站官方接口",platform:"哔哩哔哩"});
 assert.throws(()=>parseBilibiliPopular({code:-404,data:{}},"2026-09-29T10:00:00.000Z"),/格式异常/);
 assert.throws(()=>parseBilibiliPopular({code:0,data:{list:[]}},"2026-09-29T10:00:00.000Z"),/未解析到视频/);
});

test("微博官方热搜接口：word 缺失回退 note，广告位跳过，热度即时口径",()=>{
 const items=parseWeiboHotSearch({ok:1,data:{realtime:[
  {word:"AI 视频工具",num:1807290},
  {note:"宫廷糕点 泼天流量",num:500000},
  {word:"广告位",num:1,is_ad:1},
 ]}},"2026-09-29T10:00:00.000Z");
 assert.equal(items.length,2);
 assert.equal(items[0].title,"AI 视频工具");
 assert.equal(items[0].metric?.value,"1807290");
 assert.equal(items[1].title,"宫廷糕点 泼天流量");
 assert.match(items[1].url,/s\.weibo\.com\/weibo\?q=%23/);
 assert.deepEqual(items[0].acquisition,{method:"platform",provider:"微博官方接口",platform:"微博"});
 assert.throws(()=>parseWeiboHotSearch({ok:0},"2026-09-29T10:00:00.000Z"),/格式异常/);
});
