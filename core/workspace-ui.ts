export const creationLabels = {inbox:"待挑选",planned:"准备写",writing:"写作中",published:"已发布"};
export const workspaceViews=["discover","hotspots","library","trends","ideas","people","activities","chat","plans","sources","runs","skills","connections","settings"];
export function readWorkspaceLocation(search:string){
 const p=new URLSearchParams(search);
 const page=(key:string)=>Math.max(1,Math.min(1000000,Math.floor(Number(p.get(key)))||1));
 const view=workspaceViews.includes(p.get("view")||"")?p.get("view")!:"discover";
 return {activityPlatform:["哔哩哔哩","抖音","快手","小红书"].includes(p.get("activityPlatform")||"")?p.get("activityPlatform")!:"all",activityTime:["all","actionable","ongoing","upcoming","ended","unknown"].includes(p.get("activityTime")||"")?p.get("activityTime")!:(view==="activities"?"actionable":"all"),view,q:(p.get("q")||"").slice(0,500),kind:["all","news","topic","trend","idea","person","activity"].includes(p.get("kind")||"")?p.get("kind")!:"all",quality:["active","all","ready","review","rejected"].includes(p.get("quality")||"")?p.get("quality")!:"active",page:page("page"),jobsPage:page("jobsPage"),receiptsPage:page("receiptsPage"),hotspotPage:page("hotspotPage"),hotspotQ:(p.get("hotspotQ")||"").slice(0,200),hotspotStatus:["all","watch","selected","filtered"].includes(p.get("hotspotStatus")||"")?p.get("hotspotStatus")!:"all",hotspotSource:(p.get("hotspotSource")||"all").slice(0,100),hotspotPlan:(p.get("hotspotPlan")||"all").slice(0,100),creation:Object.keys(creationLabels).includes(p.get("creation")||"")?p.get("creation")!:"all",jobId:p.get("jobId")||"",runId:p.get("runId")||""};
}
export function draftChanges(before:Record<string,unknown>,after:Record<string,unknown>){
 return Object.keys(after).filter(k=>!["id","jobId","createdAt","updatedAt","revision","quality","issues","reviewNote","skillVersion","visibility","saved","archived","creationStatus"].includes(k)&&JSON.stringify(before[k])!==JSON.stringify(after[k]));
}

export type JobActivity={id:string;state:string;name:string;total:number;review:number;createdAt?:string};
export function newlyFinished(jobs:JobActivity[],previous:Map<string,string>,since:number){return jobs.filter(j=>["completed","failed","cancelled"].includes(j.state)&&(["queued","running"].includes(previous.get(j.id)||"")||!previous.has(j.id)&&Date.parse(j.createdAt||"")>=since));}
