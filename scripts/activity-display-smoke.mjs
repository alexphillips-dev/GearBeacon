import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function testActivityDisplay({ evaluate, waitForBrowser, assertAccessible, assert, cdp, screenshotRoot }) {
  await evaluate(`(() => {
    const today=activityDateKey(new Date(),'America/New_York');
    const at=(days)=>{const value=new Date(today+'T16:00:00Z');value.setUTCDate(value.getUTCDate()-days);return value.toISOString();};
    const now=new Date().toISOString();
    const context={current:{status:'Sold out',inStock:false,price:'$259.00',freshness:{state:'confirmed',checkedAt:now,expiresAt:new Date(Date.now()+3600000).toISOString()}},watch:{watched:true,parentWatched:false,collections:[{id:'display-project',name:'Network upgrade <display>',archived:false,viaParent:false}]},identity:{parentSlug:'display-parent',variantId:'display-white',variantTitle:'White · 2-pack',sku:'DISPLAY-W'},price:{currency:'USD',exactPriceScope:true,eventPrice:250,targetPrice:260,targetDifference:-10,low30:{fullWindow:true,isLowest:true,lowest:250}}};
    const base={id:'display-restock',slug:'u7-pro-xgs',name:'Access point · White 2-pack',type:'restock',region:'us',detectedAt:at(0),previousStatus:'SoldOut',status:'Available',inStock:true,price:'$250.00',priceValue:250,watchedAtDetection:false,previousStateDurationSeconds:7200,serverAlert:{state:'muted',label:'Not watched',detail:'This product was not watched at detection.'},context};
    const events=[base,
      {...base,id:'display-parent',slug:'display-parent',name:'Access point',context:{...context,identity:{parentSlug:null,variantId:null,sku:'DISPLAY'},watch:{watched:false,parentWatched:false,collections:[]},price:{currency:'USD',exactPriceScope:false,eventPrice:250,targetPrice:null,targetDifference:null,low30:null}}},
      {...base,id:'display-drop',name:'25G Direct Attach Cable',type:'price_change',price:'$59.00',previousPrice:'$65.00',priceValue:59,previousPriceValue:65,priceDifference:-6,priceDifferencePercent:-9.2,context:{...context,current:{...context.current,status:'In stock',inStock:true},price:{...context.price,eventPrice:59,targetPrice:50,targetDifference:9,low30:{fullWindow:false,isLowest:false}}},serverAlert:{state:'sent',label:'Sent · Discord',channels:['discord']}},
      {...base,id:'display-pending',name:'Pending change fixture',detectedAt:at(1),context:{...context,current:{...context.current,freshness:{state:'pending',checkedAt:now}}},serverAlert:{state:'quiet',label:'Quiet hours',detail:'Held until quiet hours end.',deliverAt:new Date(Date.now()+3600000).toISOString()}},
      {...base,id:'display-stale',name:'Delayed checks fixture',type:'sold_out',status:'SoldOut',inStock:false,detectedAt:at(1),context:{...context,current:{...context.current,freshness:{state:'stale',checkedAt:at(1)}}},serverAlert:{state:'muted',label:'Alerts paused'}},
      {...base,id:'display-unknown',name:'Missing product fixture',detectedAt:at(3),context:{...context,current:{status:null,inStock:null,freshness:{state:'unknown',checkedAt:null}}}}
    ];
    window.activityDisplayFixture={events,arrivals:[],count:42,page:1,pages:3,limit:20,snapshot:'0:',newCount:0,snapshotReset:false,summary:{total:42,restocks:30,soldOut:5,priceChanges:7,priceDrops:6,priceIncreases:1,statusChanges:0,newProducts:0,collectionReady:0,timeZone:'America/New_York'}};
    window.activityDisplayFetch=window.fetch;
    window.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      if(url.pathname==='/api/activity') return new Response(JSON.stringify(window.activityDisplayFixture),{status:200,headers:{'Content-Type':'application/json'}});
      if(url.pathname.startsWith('/api/activity/display-')) return new Response(JSON.stringify({event:window.activityDisplayFixture.events.find(event=>event.id===url.pathname.split('/').at(-1))}),{status:200,headers:{'Content-Type':'application/json'}});
      return window.activityDisplayFetch(input,init);
    };
  })()`);
  try {
    await evaluate('refreshActivity(1,{reset:true})');
    await waitForBrowser("document.querySelectorAll('#activityList .event').length===6",'Activity display fixture did not render');
    const text = await evaluate("({headings:[...document.querySelectorAll('#activityList .activity-date-heading')].map(node=>node.textContent),summary:document.getElementById('activitySummary').textContent,first:document.querySelector('[data-activity-event=display-restock]').textContent,labels:[...document.querySelectorAll('[data-activity-context=current]')].map(node=>node.textContent),separate:[...document.querySelectorAll('#activityList .event')].every(node=>node.parentElement.id==='activityList' && node.tagName==='BUTTON')})");
    assert(text.headings.length===3 && text.headings[0]==='Today' && text.headings[1]==='Yesterday',`Calendar headings are incorrect: ${JSON.stringify(text)}`);
    assert(text.summary.includes('30 restocks') && text.summary.includes('6 price drops') && text.summary.includes('America/New_York'),'Summary omitted filtered totals or its date timezone');
    assert(text.first.includes('Watching') && text.first.includes('Sold out since') && text.first.includes('$10.00 below target') && text.first.includes('Lowest observed in 30 days') && text.first.includes('Collection: Network upgrade <display>') && text.first.includes('Variant: White · 2-pack'),'Activity omitted watch, variant, collection, price, or current-status context');
    assert(text.separate && text.labels.join('|')==='Sold out since|Sold out since|Still in stock|Confirming change|Checks delayed|Status unconfirmed','Events were grouped or current status was misrepresented');
    await evaluate(`(() => {
      const base=window.activityDisplayFixture.events[0];
      const context={...base.context,watch:{watched:false,parentWatched:false,collections:[]},identity:{variantId:null,sku:'DISCOVERY'},price:null,current:{...base.context.current,status:'In stock',inStock:true}};
      window.activityDisplayFixture.events.splice(3,0,
        {...base,id:'display-new-soon',type:'new_product',name:'New upcoming camera',previousStatus:null,status:'ComingSoon',inStock:false,previousStateDurationSeconds:null,context:{...context,current:{...context.current,status:'Coming soon',inStock:false}}},
        {...base,id:'display-new-stock',type:'new_product',name:'New available camera',previousStatus:null,previousStateDurationSeconds:null,context},
        {...base,id:'display-now-available',name:'Camera launch · Exact variant with a long product name',previousStatus:'ComingSoon',previousStateDurationSeconds:779580,context:{...context,watch:{watched:false,parentWatched:true,collections:[]},identity:{variantId:'discovery-variant',variantTitle:'Launch variant',sku:'DISCOVERY-V'}}},
        {...base,id:'display-now-parent',name:'Camera launch',previousStatus:'Coming soon',previousStateDurationSeconds:779580,context},
        {...base,id:'display-legacy-restock',name:'Older restock without a previous status',previousStatus:null,context},
        {...base,id:'display-soon-status',name:'Existing listing changes to coming soon',type:'status_change',status:'ComingSoon',inStock:false,context:{...context,current:{...context.current,status:'Coming soon',inStock:false}}}
      );
    })()`);
    await evaluate('refreshActivity(1,{reset:true})');
    const discovery=await evaluate(`(() => {
      const rows=[...document.querySelectorAll('#activityList .event')];
      return rows.map(row=>({id:row.dataset.activityEvent,badge:row.querySelector('.event-discovery')?.textContent || '',meta:row.querySelector('.event-meta').textContent,current:row.querySelector('[data-activity-context=current]').textContent,label:row.getAttribute('aria-label'),title:row.querySelector('.event-discovery')?.title}));
    })()`);
    assert(discovery.length===12 && discovery.filter(row=>row.badge).length===4,'Discovery badges marked unrelated events or grouped parent and variant cards');
    for (const id of ['display-new-soon','display-new-stock']) {
      const row=discovery.find(row=>row.id===id),status=id.endsWith('soon')?'Coming soon':'In stock';
      assert(row.badge==='NEW TO STORE' && row.meta.includes(`New listing · ${status}`) && row.current===`Still ${status.toLowerCase()}` && row.label.includes(row.badge) && row.label.includes(row.title),`New listing lacks its original availability, current status, or accessible discovery description: ${JSON.stringify(row)}`);
    }
    for (const id of ['display-now-available','display-now-parent']) {
      const row=discovery.find(row=>row.id===id);
      assert(row.badge==='NOW AVAILABLE' && row.meta.includes('Coming soon → In stock') && row.meta.includes('Coming soon for 9d 33m') && !row.meta.includes('Back after') && row.label.includes(row.badge),`Coming-soon availability is still described as a normal restock: ${JSON.stringify(row)}`);
    }
    assert(discovery.find(row=>row.id==='display-legacy-restock').meta.includes('Sold out → In stock') && discovery.find(row=>row.id==='display-legacy-restock').meta.includes('Back after 2h'),'Older restocks lost their fallback wording');
    for (const theme of ['dark','light']) {
      await evaluate(`applyTheme('${theme}')`); await delay(250);
      for (const width of [1280,390,640]) {
        await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,screenWidth:width===640?1280:width,screenHeight:900,deviceScaleFactor:width===640?2:1,mobile:false});
        const layout=await evaluate("({overflow:document.documentElement.scrollWidth>innerWidth+1,rows:[...document.querySelectorAll('#activityList .event')].map(row=>({height:row.getBoundingClientRect().height,contentHeight:row.querySelector('.event-main').getBoundingClientRect().height,label:getComputedStyle(row.querySelector('.event-alert-label')).display,context:getComputedStyle(row.querySelector('.event-context')).display}))})");
        assert(!layout.overflow && layout.rows.every(row=>row.height===64 && row.contentHeight<=48 && row.label!=='none' && row.context!=='none'),`Activity context broke compact or mobile display: ${JSON.stringify(layout)}`);
        const badges=await evaluate(`(() => [...document.querySelectorAll('#activityList .event-discovery')].map(badge=>{
          const row=badge.closest('.event'),name=row.querySelector('strong'),title=row.querySelector('.event-title'),r=badge.getBoundingClientRect(),t=title.getBoundingClientRect();
          return {color:getComputedStyle(badge).color,width:r.width,visible:r.left>=t.left && r.right<=t.right+1,nameWidth:name.getBoundingClientRect().width,stockColor:row.querySelector('.event-meta-in-stock')?getComputedStyle(row.querySelector('.event-meta-in-stock')).color:null};
        }))()`);
        assert(badges.every(badge=>badge.visible && badge.width>65 && badge.nameWidth>=20 && (!badge.stockColor || badge.stockColor!==badge.color)),`Discovery badge was clipped, hid the product name, or changed the green stock text at ${width}px: ${JSON.stringify(badges)}`);
        const watchLayout=await evaluate(`(() => {
          const row=document.querySelector('[data-activity-event=display-now-available]'),mobile=row.querySelector('.event-discovery-watch'),desktop=row.querySelector('.event-watch');
          return {mobile:getComputedStyle(mobile).display,desktop:getComputedStyle(desktop).display,watch:mobile.textContent,label:row.getAttribute('aria-label')};
        })()`);
        assert(watchLayout.watch==='Parent watched' && watchLayout.label.includes('parent product is currently watched') && (width<=590 ? watchLayout.mobile!=='none' && watchLayout.desktop==='none' : watchLayout.mobile==='none' && watchLayout.desktop!=='none'),`Watch context was lost or squeezed beside discovery badges: ${JSON.stringify(watchLayout)}`);
        await assertAccessible(`Activity context ${theme} ${width}px`);
        if(screenshotRoot && width!==640) {
          await evaluate("document.getElementById('activitySummary').scrollIntoView({block:'start'}); window.scrollBy(0,-12)");
          await delay(200);
          const capture=await cdp.send('Page.captureScreenshot',{format:'png'});
          await writeFile(join(screenshotRoot,`activity-context-${theme}-${width}.png`),Buffer.from(capture.data,'base64'));
        }
      }
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await evaluate("document.querySelector('[data-activity-event=display-now-available]').focus(); document.activeElement.click()");
    await waitForBrowser("document.querySelector('.activity-detail-hero .event-discovery')?.textContent==='NOW AVAILABLE'",'Activity details omitted the availability badge');
    assert(await evaluate("document.querySelector('.activity-detail-hero').textContent.includes('Coming soon for 9d 33m') && document.querySelector('.activity-detail-hero').textContent.includes('This item changed from Coming soon to In stock')"),'Activity details disagreed with the discovery card');
    await assertAccessible('New availability details');
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert(await evaluate("document.getElementById('activityDialog').classList.contains('hidden') && document.activeElement.dataset.activityEvent==='display-now-available'"),'New availability details did not restore focus on Escape');
    await evaluate("document.querySelector('[data-activity-event=display-restock]').focus()");
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    assert(await evaluate("document.activeElement.dataset.activityEvent==='display-parent'"),'Date separators interrupted keyboard navigation between individual cards');
    await evaluate("document.querySelector('[data-activity-event=display-restock]').click()");
    await waitForBrowser("document.querySelector('.activity-context-details')?.textContent.includes('Network upgrade <display>')",'Activity details omitted full current context');
    assert(await evaluate("document.getElementById('activityDialogBody').textContent.includes('DISPLAY-W') && document.getElementById('activityDialogBody').textContent.includes('Watched at detectionNo') && !document.querySelector('.activity-context-details display')"),'Activity details lost identity, rewrote watch history, or interpreted collection text as HTML');
    await assertAccessible('Activity context detail view');
    await evaluate("window.activityDisplayAction=document.querySelector('#activityDialogBody [data-activity-product]'); window.activityDisplayAction.focus(); window.activityDisplayFixture.events[0].context.current={...window.activityDisplayFixture.events[0].context.current,status:'In stock',inStock:true}; refreshActivity()");
    await waitForBrowser("document.querySelector('.activity-context-details h3').textContent==='Still in stock'",'Open Activity detail context did not refresh');
    assert(await evaluate("document.activeElement===window.activityDisplayAction && window.activityDisplayAction.isConnected"),'Updating current detail context detached the focused action');
    await evaluate("closeActivityDialog(); window.activityDisplayRow=document.querySelector('[data-activity-event=display-restock]'); window.activityDisplayRow.focus(); window.activityDisplayRow.scrollIntoView({block:'start'}); window.activityDisplayTop=window.activityDisplayRow.getBoundingClientRect().top; window.activityDisplayMetadata=window.activityDisplayRow.querySelector('.event-meta').textContent; window.activityDisplayFixture.events[0].context.current.freshness={state:'pending',checkedAt:new Date().toISOString()}; refreshActivity()");
    await waitForBrowser("window.activityDisplayRow.querySelector('[data-activity-context=current]').textContent==='Confirming change'",'Current context did not update automatically in place');
    assert(await evaluate("window.activityDisplayRow===document.querySelector('[data-activity-event=display-restock]') && document.activeElement===window.activityDisplayRow && Math.abs(window.activityDisplayRow.getBoundingClientRect().top-window.activityDisplayTop)<2 && window.activityDisplayRow.querySelector('.event-meta').textContent===window.activityDisplayMetadata"),'Context updates changed the event snapshot, row identity, focus, or reading position');
    assert(await evaluate("activityDateKey('2026-11-01T03:59:59Z','America/New_York')==='2026-10-31' && activityDateKey('2026-11-02T04:59:59Z','America/New_York')==='2026-11-01'"),'Date headings do not respect the selected timezone across DST');
    const liveDiscovery=await evaluate(`(() => {
      const event={...window.activityDisplayFixture.events.find(event=>event.id==='display-now-available'),id:'display-live-discovery'};
      window.activityDisplayFixture.arrivals=[event]; app.activity.arrivals=[event]; renderEvents();
      const row=document.querySelector('#activityLiveList [data-activity-event=display-live-discovery]');row.focus({preventScroll:true});
      event.context={...event.context,current:{...event.context.current,status:'Sold out',inStock:false}};renderEvents();
      return {retained:row===document.querySelector('#activityLiveList [data-activity-event=display-live-discovery]') && document.activeElement===row,badge:row.querySelector('.event-discovery').textContent,meta:row.querySelector('.event-meta').textContent,current:row.querySelector('[data-activity-context=current]').textContent};
    })()`);
    assert(liveDiscovery.retained && liveDiscovery.badge==='NOW AVAILABLE' && liveDiscovery.meta.includes('Coming soon for 9d 33m') && liveDiscovery.current==='Sold out since','Live discovery context rewrote the historical badge or lost row identity/focus');
  } finally {
    await evaluate("closeActivityDialog(); window.fetch=window.activityDisplayFetch; applyTheme('dark'); refreshActivity(1,{reset:true})");
    await waitForBrowser("!app.activityController && !app.activity.events.some(event=>event.id.startsWith('display-'))",'Activity did not recover after display fixtures');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await delay(250); // Let the restored theme finish its color transition before the next accessibility scan.
  }
}
