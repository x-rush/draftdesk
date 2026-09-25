import type {DiscoveryRecord,CandidateStatus} from "./discovery";

export type HotspotRow={
  url:string;title:string;sourceId:string;sourceName:string;sourceIds:string[];sourceNames:string[];
  planNames:string[];status:CandidateStatus;reason:string;firstSeen:string;lastSeen:string;
  observations:number;rank?:number;region?:string;metric?:{name:string;value:string;unit:string;period:string};
};
export type HotspotFeed={items:HotspotRow[];total:number;page:number;pages:number;pageSize:number;
  sourceOptions:{id:string;name:string}[];planOptions:string[];lastCollectedAt:string|null;
  sourceHealth:{id:string;name:string;status:"ok"|"failed";at:string;error?:string}[]};

function urlKey(value:string){
  try{const u=new URL(value);u.hash="";for(const key of [...u.searchParams.keys()])if(/^(utm_|fbclid$|gclid$)/i.test(key))u.searchParams.delete(key);return u.toString();}
  catch{return value;}
}

export function hotspotFeed(records:DiscoveryRecord[],params:URLSearchParams,pageSize=20):HotspotFeed{
  const rows=new Map<string,HotspotRow>(),sources=new Map<string,string>(),plans=new Set<string>();
  const sourceHealth=new Map<string,HotspotFeed["sourceHealth"][number]>();
  for(const record of records){
    plans.add(record.planName);
    for(const coverage of record.sources){
      sources.set(coverage.sourceId,coverage.sourceName);
      if(!sourceHealth.has(coverage.sourceId))sourceHealth.set(coverage.sourceId,{id:coverage.sourceId,name:coverage.sourceName,status:coverage.status,at:record.at,error:coverage.error});
    }
    for(const candidate of record.candidates){
      sources.set(candidate.sourceId,candidate.sourceName);
      const key=urlKey(candidate.url),old=rows.get(key);
      if(old){
        old.observations++;
        old.firstSeen=old.firstSeen<candidate.observedAt?old.firstSeen:candidate.observedAt;
        if(!old.sourceIds.includes(candidate.sourceId))old.sourceIds.push(candidate.sourceId);
        if(!old.sourceNames.includes(candidate.sourceName))old.sourceNames.push(candidate.sourceName);
        if(!old.planNames.includes(record.planName))old.planNames.push(record.planName);
        if(candidate.observedAt>old.lastSeen){Object.assign(old,{title:candidate.title,sourceId:candidate.sourceId,sourceName:candidate.sourceName,lastSeen:candidate.observedAt,rank:candidate.rank,region:candidate.region,metric:candidate.metric});}
        if(candidate.status==="selected"||old.status!=="selected"&&candidate.status==="filtered"){old.status=candidate.status;old.reason=candidate.reason;}
      }else rows.set(key,{url:candidate.url,title:candidate.title,sourceId:candidate.sourceId,sourceName:candidate.sourceName,sourceIds:[candidate.sourceId],sourceNames:[candidate.sourceName],planNames:[record.planName],status:candidate.status,reason:candidate.reason,firstSeen:candidate.observedAt,lastSeen:candidate.observedAt,observations:1,rank:candidate.rank,region:candidate.region,metric:candidate.metric});
    }
  }
  const q=(params.get("hotspotQ")||"").trim().toLocaleLowerCase(),source=params.get("hotspotSource")||"all",plan=params.get("hotspotPlan")||"all",status=params.get("hotspotStatus")||"all";
  const filtered=[...rows.values()].filter(row=>(source==="all"||row.sourceIds.includes(source))&&
    (plan==="all"||row.planNames.includes(plan))&&(status==="all"||row.status===status)&&
    (!q||[row.title,...row.sourceNames,...row.planNames,row.reason].join(" ").toLocaleLowerCase().includes(q)))
    .sort((a,b)=>b.lastSeen.localeCompare(a.lastSeen)||a.title.localeCompare(b.title));
  const pages=Math.max(1,Math.ceil(filtered.length/pageSize)),page=Math.min(pages,Math.max(1,Math.floor(Number(params.get("hotspotPage")))||1));
  return {items:filtered.slice((page-1)*pageSize,page*pageSize),total:filtered.length,page,pages,pageSize,
    sourceOptions:[...sources].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name)),
    planOptions:[...plans].sort(),lastCollectedAt:records[0]?.at||null,sourceHealth:[...sourceHealth.values()]};
}
