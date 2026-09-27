// Runs only after the user presses Collect on an official activity page.
if (!globalThis.__draftdeskActivityCollector) {
 globalThis.__draftdeskActivityCollector = true;
 const clean = s => (s || '').replace(/\s+/g, ' ').trim();
 const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
 const platform = location.hostname === 'www.bilibili.com' ? '哔哩哔哩' : location.hostname === 'creator.douyin.com' ? '抖音' : location.hostname === 'cp.kuaishou.com' ? '快手' : location.hostname === 'creator.xiaohongshu.com' ? '小红书' : '';
 async function saveRun(value){
  const {draftdeskActivityRuns={}}=await chrome.storage.local.get('draftdeskActivityRuns');
  await chrome.storage.local.set({draftdeskActivityRuns:{...draftdeskActivityRuns,[platform]:{...value,platform,sourceUrl:location.href}}});
 }
 function deadline(value, yearHint) {
  const s = clean(value);
  const all = [...s.matchAll(/(?:(20\d{2})[年/.\-])?\s*(\d{1,2})[月/.\-](\d{1,2})\s*日?/g)];
  if (!all.length) return null;
  if (all.length===1 && !/截止|结束|报名至|投稿至/.test(s)) return null;
  const last = all.at(-1), first = all[0];
  // A month/day alone is not proof that an activity is still open. The year
  // must be printed in the date range or in the visible calendar heading.
  const statedYear = last[1] || first[1] || yearHint;
  if (!statedYear) return null;
  let year = Number(statedYear);
  if (!last[1] && all.length > 1 && Number(last[2]) < Number(first[2])) year++;
  const month = Number(last[2]), day = Number(last[3]);
  const end = new Date(Date.UTC(year, month - 1, day, 15, 59, 59));
  if (end.getUTCFullYear() !== year || end.getUTCMonth() !== month - 1 || end.getUTCDate() !== day) return null;
  return {endsAt: end.toISOString()};
 }
 function make(title,url,text,dateText,completeness,yearHint,sourceLocator) {
  const d = deadline(dateText,yearHint);
  return {platform,title:clean(title).slice(0,300),url,text:clean(text).slice(0,12000),dateText:clean(dateText).slice(0,200),...(d ? {endsAt:d.endsAt} : {}),completeness,...(sourceLocator ? {sourceLocator:clean(sourceLocator).slice(0,200)} : {}),capturedAt:new Date().toISOString()};
 }
 async function run(config) {
  if (!platform) throw Error('请在四个平台的官方创作活动页运行');
  const keywords = config.keywords.map(clean).filter(Boolean).slice(0,20);
  const maxPages = Math.max(1,Math.min(Number(config.maxPages)||2,5));
  const maxItems = Math.max(1,Math.min(Number(config.maxItems)||100,100));
  const items = [], warnings = [], seen = new Set();
  let scannedPages=0,hasMore=null,visibleTotal=null;
  const matched = text => !keywords.length || keywords.some(k=>text.toLocaleLowerCase().includes(k.toLocaleLowerCase()));
  const progress = async message => saveRun({state:'running',progress:message,startedAt:config.startedAt});
  const add = item => {
   if (!item?.title || !item.url || seen.has(`${item.url}|${item.title}`)) return;
   seen.add(`${item.url}|${item.title}`);
   // Keep the evidence in the export so the workbench can explain exclusions.
   // Only the workbench's eligibility check may submit items to paid analysis.
   items.push(item);
  };
  if (platform === '哔哩哔哩') {
    // 站内「下一页」是依赖内部状态的 span，程序化点击不可靠（曾把页面翻到 ?page=111）。
    // 改用同源隐藏 iframe 逐页加载 ?page=N：脚本上下文不中断，当前标签页地址不变。
    const readFrameCards = async (pageNumber) => {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:absolute;width:1200px;height:900px;left:-9999px;top:0';
      frame.src = new URL('/blackboard/activity-list.html?page=' + pageNumber, location.origin).href;
      document.body.appendChild(frame);
      try {
        for (let i = 0; i < 50; i++) {
          await pause(400);
          try {
            const doc = frame.contentDocument;
            const anchors = doc ? [...doc.querySelectorAll('h2 a[href*="/blackboard/era/"]')] : [];
            if (anchors.length) {
              return anchors.map(a => {
                const card = a.closest('li') || a.parentElement?.parentElement;
                return {title: clean(a.textContent), url: new URL(a.getAttribute('href'), location.origin).href, dateText: clean(card?.querySelector('.event_status')?.textContent)};
              });
            }
          } catch (e) { /* iframe 文档尚未就绪，继续等待 */ }
        }
        throw Error('20 秒内未渲染出活动卡片');
      } finally { frame.remove(); }
    };
    let allExpiredPages=0;
    for (let page=1;page<=maxPages && items.length<maxItems;page++) {
      await progress(`B站列表 ${page}/${maxPages}`);
      let cards;
      try { cards = await readFrameCards(page); }
      catch(e){ warnings.push(`B站第 ${page} 页：${e.message}`); break; }
      if(!cards.length){warnings.push(`B站第 ${page} 页没有活动卡片`);break;}
      scannedPages++;
      let wholePageExpired=true;
      for(const entry of cards){
        if(items.length>=maxItems)break;
        const title=entry.title,url=entry.url,dateText=entry.dateText;
        if(!title||seen.has(`${url}|${title}`))continue;
        const end=deadline(dateText);
        if(!end||Date.parse(end.endsAt)>=Date.now())wholePageExpired=false;
        if(!end||Date.parse(end.endsAt)<Date.now()||!matched(title)){
          add(make(title,url,dateText,dateText,'summary'));
          continue;
        }
        let detail=null;
        try {const res=await chrome.runtime.sendMessage({type:'draftdesk:read-url',url});if (res.ok) detail=res.result;else warnings.push(`${title}：${res.error}`);}catch(e){warnings.push(`${title}：详情读取失败 ${e.message}`);}
        add(make(title,url,detail?.text||dateText,dateText,detail?.text?.length>=50?'detail':'summary'));
        await pause(350);
      }
      if(wholePageExpired)allExpiredPages++;
    }
    if(allExpiredPages>=2)warnings.push(`B站连续 ${allExpiredPages} 页活动截止日都已过期；已按配置页数完成扫描，更早页面的活动只会更旧。`);
  } else if (platform === '小红书') {
   for (let page=1;page<=maxPages && items.length<maxItems;page++) {
    await progress(`小红书列表 ${page}/${maxPages}`);
    const cards=[...document.querySelectorAll('.card-box')];
    if (!cards.length){warnings.push('小红书没有读到活动卡片，请确认已登录并打开活动中心');break;}
    scannedPages++;
    for (const card of cards) {
     if (items.length>=maxItems) break;
     const title=clean(card.querySelector('.title')?.textContent), brief=clean(card.querySelector('.desc')?.textContent);
     const dateText=clean(card.querySelector('.time')?.textContent);
     if (!title) continue;
     if (!matched(title+' '+brief)) {
      add(make(title,location.href,brief,dateText,'summary'));
      continue;
     }
     card.click();
     for(let attempt=0;attempt<10;attempt++){
      await pause(250);
      if(document.querySelector('.detail iframe[src]')||clean(document.querySelector('.detail .info')?.innerText).length>=150)break;
     }
     const detail=document.querySelector('.detail .info');
     const frame=document.querySelector('.detail iframe[src]');
     const rawUrl=frame?.src?.startsWith('https://fe.xiaohongshu.com/ditto/vincent/')?frame.src:location.href;
     const url=new URL(rawUrl).href;
     const rawBody=detail?.innerText||'';
     const body=clean(rawBody);
     let frameText='';
     if(url!==location.href){try{const response=await chrome.runtime.sendMessage({type:'draftdesk:read-xhs-frame',url});if(response?.ok)frameText=response.result.text;else warnings.push(`${title}：${response?.error||'规则嵌入页不可读'}`);}catch(e){warnings.push(`${title}：规则嵌入页读取失败 ${e.message}`);}}
     const timeLines=rawBody.split('\n').map(clean).filter(Boolean);
     const timeIndex=timeLines.findIndex(x=>/^(活动时间|截止时间|投稿时间)/.test(x));
     const detailTime=timeIndex>=0?timeLines.slice(timeIndex,timeIndex+2).join(' '):'';
     const frameLines=frameText.split('\n').map(clean).filter(Boolean);
     const frameTimeIndex=frameLines.findIndex(x=>/(活动时间|截止时间|投稿时间|征稿时间)/.test(x));
     const frameTime=frameTimeIndex>=0?frameLines.slice(frameTimeIndex,frameTimeIndex+2).join(' '):'';
     const verifiedDate=/20\d{2}/.test(detailTime)?detailTime:/20\d{2}/.test(frameTime)?frameTime:dateText;
     const ruleText=frameText||rawBody;
     const complete=ruleText.length>=150&&/活动规则|参与方式|投稿要求|参与条件|创作要求/.test(ruleText);
     add(make(title,url,`${brief}\n${body}\n${frameText}`,verifiedDate,complete?'detail':'summary',undefined,url===location.href?title:undefined));
     document.querySelector('.d-drawer .d-drawer-close')?.click();
    }
    const next=[...document.querySelectorAll('.pagination .d-pagination-page')].find(x=>clean(x.querySelector('.d-pagination-page-content')?.textContent)===String(page+1));
    if (!next){hasMore=false;break;}
    if(page>=maxPages||items.length>=maxItems){hasMore=true;break;}
    const before=clean(cards[0]?.querySelector('.title')?.textContent);next.click();
    let changed=false;
    for(let i=0;i<12;i++){await pause(250);if(clean(document.querySelector('.card-box .title')?.textContent)!==before){changed=true;break;}}
    if(!changed){warnings.push(`小红书第 ${page+1} 页未加载，已停止扫描`);break;}
   }
  } else if (platform === '抖音') {
   await progress('抖音活动日历');
   scannedPages=1;hasMore=true;
   const calendar=document.querySelector('.douyin-creator-common-calendar')||document.body;
   const year=clean(calendar.innerText).match(/(20\d{2})年/)?.[1];
   const cards=[...document.querySelectorAll('.douyin-creator-common-calendar-event-item')];
   if(!cards.length) warnings.push('抖音活动日历没有可读取条目');
   const titles=new Set();
   for(const card of cards){
    if(items.length>=maxItems)break;
    const title=clean(card.textContent);if(!title||titles.has(title))continue;titles.add(title);
    card.click();await pause(450);
    const dialog=document.querySelector('[role="dialog"]');
    const rawBody=dialog?.innerText||'';
    const body=clean(rawBody);
    const lines=rawBody.split('\n').map(clean).filter(Boolean);
    const timeIndex=lines.findIndex(x=>/(活动时间|投稿时间|征稿时间|截止时间)/.test(x)&&/\d{1,2}[月/.\-]\d{1,2}/.test(x));
    const dateText=timeIndex>=0?lines.slice(timeIndex,timeIndex+2).join(' '):body.match(/(?:20\d{2}[年/.\-])?\d{1,2}[月/.\-]\d{1,2}[^。\n]{0,40}(?:20\d{2}[年/.\-])?\d{1,2}[月/.\-]\d{1,2}/)?.[0]||body;
    const link=dialog?.querySelector('a[href^="https://creator.douyin.com/"],a[href^="https://activity.douyin.com/"]');
    const url=link?.href||location.href;
    const complete=body.length>=100&&/(活动规则|参与方式|投稿要求|赛道|创作要求)/.test(body);
    add(make(title,url,body,dateText,complete?'detail':'summary',year,link?.href?undefined:title));
    dialog?.querySelector('[aria-label="关闭"],.close,[class*="close"]')?.click();
    await pause(100);
   }
   warnings.push('抖音仅扫描当前显示月份；跨月活动请在官方日历切换月份后再采集。没有单条链接时，会保留官方日历地址和活动标题供复核，分析结果不能直接通过审稿。');
  } else if (platform === '快手') {
   await progress('快手活动中心');
   visibleTotal=Number(clean(document.body.innerText).match(/共\s*(\d+)\s*个活动/)?.[1])||null;
   warnings.push('快手活动列表的日期通常只有月日；若详情页未给出明确年份或单条官方链接，工作台会保留待核线索，不能据列表位置推断活动仍有效。');
   const processed=new Set();
   for(let scroll=0;scroll<maxPages && items.length<maxItems;scroll++) {
    const cards=[...document.querySelectorAll('.list_item')];
    if(!cards.length){warnings.push('快手活动中心没有读到活动卡片，请检查登录或当前页面');break;}
    scannedPages++;
    for(const card of cards){
     if(items.length>=maxItems)break;
     const title=clean(card.querySelector('.list_item_main_title')?.textContent);
     const brief=clean(card.querySelector('.list_item_main_breif')?.textContent);
     const dateText=clean(card.querySelector('.list_item_main_time')?.textContent);
     if(!title)continue;
     // 下滑加载后旧卡片仍在列表里：按卡片去重，避免重复打开同一详情页。
     const cardKey=`${title}|${dateText}`;
     if(processed.has(cardKey))continue;
     processed.add(cardKey);
     if(!matched(title+' '+brief)){
      add(make(title,location.href,brief,dateText,'summary'));
      continue;
     }
     const end=deadline(dateText);
     if(end&&Date.parse(end.endsAt)<Date.now()){
      add(make(title,location.href,brief,dateText,'summary'));
      continue;
     }
     const opener=card.querySelector('.list_item_main_title');
     const link=opener?.closest('a[href]')||opener?.querySelector('a[href]');
     let url=location.href,body=brief;
     // Never click the enrollment button (“去领取”). Only the title/link may reveal rules.
     if(link?.href){try{const result=await chrome.runtime.sendMessage({type:'draftdesk:read-url',url:link.href});if(result.ok){url=result.result.url;body=result.result.text;}else warnings.push(`${title}：${result.error}`);}catch(e){warnings.push(`${title}：详情未打开 ${e.message}`);}}
     else if(opener){try{const watch=await chrome.runtime.sendMessage({type:'draftdesk:watch-tab'});opener.click();await pause(550);const result=await chrome.runtime.sendMessage({type:'draftdesk:finish-watch',id:watch.id});if(result.ok){url=result.result.url;body=result.result.text;}else warnings.push(`${title}：${result.error}`);}catch(e){warnings.push(`${title}：详情未打开 ${e.message}`);}}
     add(make(title,url,`${brief}\n${body}`,dateText,url!==location.href&&body.length>=50?'detail':'summary'));
    }
    if (items.length>=maxItems) break;
    // 下滑加载更多：等列表真正增长（最多 6 秒），没有增长就如实停止而不是空转。
    window.scrollBy(0,Math.max(700,innerHeight));
    let grew=false;
    for(let i=0;i<12;i++){await pause(500);if(document.querySelectorAll('.list_item').length>cards.length){grew=true;break;}}
    if(!grew){warnings.push(`快手下滑后没有继续加载新活动（本次读到 ${items.length} 条）；已停止。可在页面加载更多后重新采集。`);break;}
   }
  }
  const expired=items.filter(x=>x.endsAt&&Date.parse(x.endsAt)<Date.now()).length;
  const unknown=items.filter(x=>!x.endsAt).length;
  warnings.unshift(`扫描 ${items.length} 条：${expired} 条已过期、${unknown} 条截止年份或日期不明确；工作台会逐条展示并阻止这些材料进入 AI 分析。`);
  const scope=platform==='抖音'?'current_month':platform==='快手'?'screens':'pages';
  if(platform==='快手')hasMore=visibleTotal!==null?items.length<visibleTotal:null;
  const note=platform==='抖音'?'只覆盖当前显示月份，其他月份未扫描':platform==='快手'?(hasMore===false?'已到当前列表末尾；平台后续仍可能新增活动':'有限屏数采集；更多活动可能未覆盖'):hasMore===false?'已到当前列表末页；平台后续仍可能新增活动':'只覆盖本次扫描的近期列表，后续页面可能仍有历史或长期活动';
  return {schemaVersion:'draftdesk.activity-batch.v1',keywords,platform,items,warnings:warnings.slice(0,50),coverage:{scope,requestedPages:maxPages,scannedPages,hasMore:hasMore??null,visibleTotal:visibleTotal??null,note}};
 }
 chrome.runtime.onMessage.addListener((message,_sender,respond)=>{
  if(message?.type!=='draftdesk:auto')return;
  const config={...message.config,startedAt:new Date().toISOString()};
  saveRun({state:'running',progress:'正在读取官方活动页',startedAt:config.startedAt}).then(()=>run(config)).then(async bundle=>{await saveRun({state:'completed',bundle,progress:`完成：${bundle.items.length} 条活动线索，请到工作台核对是否可分析`,startedAt:config.startedAt});await chrome.runtime.sendMessage({type:'draftdesk:auto-send',platform}).catch(()=>{});}).catch(e=>saveRun({state:'failed',progress:e.message,startedAt:config.startedAt}));
  respond({ok:true});
 });
}
