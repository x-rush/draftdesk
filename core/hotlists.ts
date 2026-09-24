import type {EvidenceInput} from "./schema";
import {AppError} from "./store";

export const aggregatePlatforms={
  bilibili:{name:"B站",hosts:["bilibili.com","b23.tv"]},
  weibo:{name:"微博",hosts:["weibo.com","weibo.cn"]},
  zhihu:{name:"知乎",hosts:["zhihu.com"]},
  douyin:{name:"抖音",hosts:["douyin.com","iesdouyin.com"]},
  kuaishou:{name:"快手",hosts:["kuaishou.com","gifshow.com"]},
  toutiao:{name:"今日头条",hosts:["toutiao.com"]},
  tieba:{name:"百度贴吧",hosts:["baidu.com"]},
  juejin:{name:"稀土掘金",hosts:["juejin.cn"]},
} as const;
export type AggregatePlatform=keyof typeof aggregatePlatforms;
export function isAggregatePlatform(value:string):value is AggregatePlatform{return Object.hasOwn(aggregatePlatforms,value);}
export function parseAggregateHotlist(raw:unknown,platform:AggregatePlatform,collectedAt:string):EvidenceInput[]{
  const payload=raw as Record<string,unknown>;
  if(!payload||typeof payload!=="object"||payload.code!==200||!Array.isArray(payload.data))throw new AppError(`${aggregatePlatforms[platform].name}聚合榜单返回格式异常。`);
  if(typeof payload.updateTime!=="string"||!Number.isFinite(Date.parse(payload.updateTime))||Date.parse(collectedAt)-Date.parse(payload.updateTime)>2*60*60*1000||Date.parse(payload.updateTime)-Date.parse(collectedAt)>5*60*1000)
    throw new AppError(`${aggregatePlatforms[platform].name}聚合榜单缺少新鲜更新时间，或已超过 2 小时。`);
  const config=aggregatePlatforms[platform];
  const results:EvidenceInput[]=[];
  for(const value of payload.data.slice(0,50)){
    if(!value||typeof value!=="object")continue;
    const row=value as Record<string,unknown>,title=typeof row.title==="string"?text(row.title).slice(0,300):"";
    if(!title||typeof row.url!=="string")continue;
    let url:URL;
    try{url=new URL(decode(row.url));}catch{continue;}
    if(url.protocol!=="https:"||url.username||url.password||url.port||!config.hosts.some(host=>url.hostname===host||url.hostname.endsWith("."+host)))continue;
    const hot=typeof row.hot==="number"||typeof row.hot==="string"?String(row.hot).trim():"";
    results.push({title,url:url.href,excerpt:title,collectedAt,sourceType:"trend",region:"CN",language:"zh",contentLevel:"headline",
      acquisition:{method:"aggregator",provider:"DailyHotApi",platform:config.name,observedAt:new Date(payload.updateTime).toISOString()},
      ...(/^\d+(?:\.\d+)?$/.test(hot)?{metric:{name:`${config.name}榜单热度`,value:hot,unit:"平台热度",period:new Date(payload.updateTime).toISOString(),cadence:"instant" as const}}:{})});
  }
  if(!results.length)throw new AppError(`${config.name}聚合榜单没有有效原平台链接；不将聚合页冒充原始来源。`);
  return results;
}

const strip=(s:string)=>s.replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
const decode=(s:string)=>s.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,(_,raw:string)=>{
  const key=raw.toLowerCase();
  if(key.startsWith("#")){const n=key[1]==="x"?parseInt(key.slice(2),16):parseInt(key.slice(1),10);return Number.isFinite(n)&&n>=0&&n<=0x10ffff?String.fromCodePoint(n):"";}
  return ({amp:"&",quot:'"',apos:"'",lt:"<",gt:">",nbsp:" "} as Record<string,string>)[key]||"";
});
const text=(s:string)=>decode(strip(s));
const safeLink=(raw:string,host:string)=>{try{const u=new URL(decode(raw),`https://${host}`);return u.protocol==="https:"&&u.hostname===host?u.href:null;}catch{return null;}};

export function parseBaiduHotlist(html:string,collectedAt:string):EvidenceInput[]{
 const chunks=html.split(/<div class="category-wrap_[^"]*"/).slice(1);
 const items:EvidenceInput[]=[];
 for(const chunk of chunks){
  const anchor=chunk.match(/<a\b[^>]*href="([^"]+)"[^>]*class="title_[^"]*"[^>]*>/);
  const title=chunk.match(/<div class="c-single-text-ellipsis"[^>]*>([\s\S]*?)<\/div>/);
  if(!anchor||!title)continue;
  const url=safeLink(anchor[1],"www.baidu.com"),name=text(title[1]);
  if(!url||!name)continue;
  const desc=chunk.match(/<div class="hot-desc_[^"]*small_[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  const heat=chunk.match(/<div class="hot-index_[^"]*"[^>]*>\s*([\d,]+)\s*<\/div>/);
  const value=heat?.[1].replace(/,/g,"");
  items.push({title:name.slice(0,300),url,excerpt:(desc?text(desc[1]):name).slice(0,8000),collectedAt,sourceType:"trend",region:"CN",language:"zh",contentLevel:desc?"excerpt":"headline",
   acquisition:{method:"platform",provider:"百度官方页面",platform:"百度"},
   ...(value?{metric:{name:"百度热搜指数",value,unit:"指数",period:collectedAt,cadence:"instant" as const}}:{})});
 }
 if(!items.length)throw new AppError("百度热搜页面未出现可解析词条；可能是页面结构变化或访问限制。");
 return items;
}

export function parseWeiboHotlist(html:string,collectedAt:string):EvidenceInput[]{
 if(/Sina Visitor System|passport\.sinaimg\.cn\/js\/fp/i.test(html))throw new AppError("微博返回访客验证页；未尝试绕过验证，请在来源配置中保持停用或使用获授权采集器。");
 const items:EvidenceInput[]=[];
 for(const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)){
  const cell=row[1].match(/<td\b[^>]*class="[^"]*td-02[^"]*"[^>]*>([\s\S]*?)<\/td>/);
  const anchor=cell?.[1].match(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
  if(!anchor)continue;
  const url=safeLink(anchor[1],"s.weibo.com"),name=text(anchor[2]);
  if(!url||!name)continue;
  const heat=cell![1].match(/<span\b[^>]*>([\d,]+)<\/span>/);
  const value=heat?.[1].replace(/,/g,"");
  items.push({title:name.slice(0,300),url,excerpt:name,collectedAt,sourceType:"trend",region:"CN",language:"zh",contentLevel:"headline",
   acquisition:{method:"platform",provider:"微博官方页面",platform:"微博"},
   ...(value?{metric:{name:"微博热搜热度",value,unit:"平台热度",period:collectedAt,cadence:"instant" as const}}:{})});
 }
 if(!items.length)throw new AppError("微博热搜页面未出现可解析词条；可能需要登录或页面结构已变。");
 return items;
}

export function parseGithubTrending(html:string,collectedAt:string):EvidenceInput[]{
 const items:EvidenceInput[]=[];
 for(const chunk of html.split(/<article\s+class="Box-row"[^>]*>/).slice(1)){
  const header=chunk.match(/<h2[^>]*class="[^"]*lh-condensed[^"]*"[^>]*>([\s\S]*?)<\/h2>/);
  const path=header?.[1].match(/href="\/(?!login)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)"/);
  if(!path)continue;
  const repo=path[1],description=chunk.match(/<p[^>]*class="[^"]*color-fg-muted[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  const stars=chunk.match(/([\d,]+)\s+stars?\s+today/i)?.[1].replace(/,/g,"");
  items.push({title:repo,url:`https://github.com/${repo}`,excerpt:(description?text(description[1]):repo).slice(0,8000),collectedAt,sourceType:"repository",region:"全球",language:"en",contentLevel:description?"excerpt":"headline",
   ...(stars?{metric:{name:"GitHub Trending 当日新增 Stars",value:stars,unit:"stars today",period:collectedAt,cadence:"instant" as const}}:{})});
 }
 if(!items.length)throw new AppError("GitHub Trending 页面未解析到项目；可能是页面结构变化或访问限制。");
 return items;
}

export function parseHackerNewsStory(raw:unknown,rank:number,collectedAt:string):EvidenceInput|null{
 if(!raw||typeof raw!=="object")return null;
 const row=raw as Record<string,unknown>;
 if(row.type!=="story"||!Number.isSafeInteger(row.id)||typeof row.title!=="string"||!row.title.trim())return null;
 const id=Number(row.id),score=typeof row.score==="number"?row.score:NaN,published=Number(row.time);
 const external=typeof row.url==="string"&&/^https?:\/\//.test(row.url)?` 原文：${row.url}`:"";
 const summary=typeof row.text==="string"?text(row.text):"";
 return {title:row.title.trim().slice(0,300),url:`https://news.ycombinator.com/item?id=${id}`,excerpt:((summary||row.title.trim())+external).slice(0,8000),collectedAt,
  ...(Number.isFinite(published)&&published>0&&published<4000000000?{publishedAt:new Date(published*1000).toISOString()}:{}),sourceType:"community",region:"全球",language:"en",contentLevel:summary?"excerpt":"headline",
  ...(Number.isFinite(score)&&score>=0?{metric:{name:"Hacker News 榜单分数",value:String(score),unit:"points",period:collectedAt,cadence:"instant" as const}}:{metric:{name:"Hacker News 榜单名次",value:String(rank),unit:"rank",period:collectedAt,cadence:"instant" as const}})};
}
