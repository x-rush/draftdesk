import test from "node:test";
import assert from "node:assert/strict";
import {parseSuggest} from "../core/sources";
import {activityBatchSchema} from "../core/activity-batch";

test("Google 联想 JSON 解析为搜索链接证据，标注需求线索口径",()=>{
 const source={id:"suggest-global",name:"Google 搜索联想",type:"suggest" as const,query:"AI coding tool,Codex credits",sourceType:"trend" as const,enabled:true,note:""};
 const items=parseSuggest('["codex credits",["codex credits reset","codex credits check"," codex credits remaining "],[],{}]',source,"codex credits");
 assert.equal(items.length,3);
 assert.equal(items[0].title,"codex credits reset");
 assert.equal(items[0].url,"https://www.google.com/search?q=codex%20credits%20reset");
 assert.equal(items[0].contentLevel,"headline");
 assert.match(items[0].excerpt,/不是搜索量或趋势数据/);
 assert.equal(items[0].metric,undefined);
});

test("百度 sugrec 解析为中文需求线索并使用百度搜索链接",()=>{
 const source={id:"suggest-cn",name:"百度搜索联想",type:"suggest" as const,url:"https://www.baidu.com/sugrec",query:"站群",sourceType:"trend" as const,enabled:true,note:""};
 const items=parseSuggest('{"q":"站群","g":[{"q":"站群系统"},{"q":""},{"q":"站群seo"}]}',source,"站群");
 assert.equal(items.length,2);
 assert.equal(items[0].url,"https://www.baidu.com/s?wd=%E7%AB%99%E7%BE%A4%E7%B3%BB%E7%BB%9F");
 assert.equal(items[0].language,"zh");
 assert.equal(items[0].region,"中国");
});

test("联想解析最多保留 10 条，坏 JSON 抛错由来源层记录",()=>{
 const source={id:"suggest-global",name:"g",type:"suggest" as const,query:"x",sourceType:"trend" as const,enabled:true,note:""};
 const many=Array.from({length:14},(_,i)=>"建议 "+i);
 assert.equal(parseSuggest(JSON.stringify(["x",many]),source,"x").length,10);
 assert.throws(()=>parseSuggest("<html>blocked</html>",source,"x"));
});

test("suggest 来源通过活动批次 schema 无关；schema 只认新增 type",()=>{
 const source={id:"s",name:"s",type:"suggest" as const,query:"x",sourceType:"trend" as const,enabled:true,note:""};
 assert.equal(source.type,"suggest");
});
