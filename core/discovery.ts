import type {EvidenceInput, Plan} from "./schema";

export type CandidateStatus="selected"|"watch"|"filtered";
export type DiscoveryCandidate={url:string;title:string;sourceId:string;sourceName:string;status:CandidateStatus;reason:string;observedAt:string};
export type SourceCoverage={sourceId:string;sourceName:string;status:"ok"|"failed";raw:number;matched:number;selected:number;error?:string};
export type DiscoveryRecord={jobId:string;at:string;planName:string;candidates:DiscoveryCandidate[];sources:SourceCoverage[];limit:number};

const aliases:Record<string,string[]>={
  "vibe coding":["vibe coding","vibecoding","氛围编程","ai编程","ai 编程"],
  "vibecoding":["vibe coding","vibecoding","氛围编程","ai编程","ai 编程"],
  "ai视频":["ai视频","ai 视频","ai短片","ai 短片","文生视频","视频生成"],
};
export function matchesResearchTerm(corpus:string,term:string){
  const haystack=corpus.toLocaleLowerCase().replace(/\s+/g," ");
  const needle=term.trim().toLocaleLowerCase();
  if(!needle)return false;
  return (aliases[needle]||[needle]).some(value=>{
    let from=0;
    while(from<haystack.length){
      const index=haystack.indexOf(value,from);
      if(index<0)return false;
      if(!/^[a-z0-9 ]+$/i.test(value)||(!/[a-z0-9]/i.test(haystack[index-1]||"")&&!/[a-z0-9]/i.test(haystack[index+value.length]||"")))return true;
      from=index+1;
    }
    return false;
  });
}
export function relevanceReason(e:EvidenceInput,p:Plan):string|null{
  const corpus=e.title+" "+e.excerpt;
  if(p.focusTerms?.length&&!p.focusTerms.some(term=>matchesResearchTerm(corpus,term)))return "未命中内容方向词";
  if(p.excludeKeywords.some(term=>matchesResearchTerm(corpus,term)))return "命中排除词";
  if(e.publishedAt&&(Date.parse(e.publishedAt)<Date.now()-p.lookbackDays*86400000||Date.parse(e.publishedAt)>Date.now()+86400000))return "不在时间窗口";
  const host=new URL(e.url).hostname;
  if(p.includeDomains.length&&!p.includeDomains.some(d=>host===d||host.endsWith("."+d)))return "不在限定域名";
  if(e.sourceType==="trend"&&p.keywords.length&&!p.keywords.some(term=>matchesResearchTerm(corpus,term)))return "未命中热词关键词";
  return null;
}
