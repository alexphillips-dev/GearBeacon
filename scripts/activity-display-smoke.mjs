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
    for (const theme of ['dark','light']) {
      await evaluate(`applyTheme('${theme}')`); await delay(250);
      for (const width of [1280,390,640]) {
        await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,screenWidth:width===640?1280:width,screenHeight:900,deviceScaleFactor:width===640?2:1,mobile:false});
        const layout=await evaluate("({overflow:document.documentElement.scrollWidth>innerWidth+1,rows:[...document.querySelectorAll('#activityList .event')].map(row=>({height:row.getBoundingClientRect().height,contentHeight:row.querySelector('.event-main').getBoundingClientRect().height,label:getComputedStyle(row.querySelector('.event-alert-label')).display,context:getComputedStyle(row.querySelector('.event-context')).display}))})");
        assert(!layout.overflow && layout.rows.every(row=>row.height===64 && row.contentHeight<=48 && row.label!=='none' && row.context!=='none'),`Activity context broke compact or mobile display: ${JSON.stringify(layout)}`);
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
  } finally {
    await evaluate("closeActivityDialog(); window.fetch=window.activityDisplayFetch; applyTheme('dark'); refreshActivity(1,{reset:true})");
    await waitForBrowser("!app.activityController && !app.activity.events.some(event=>event.id.startsWith('display-'))",'Activity did not recover after display fixtures');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await delay(250); // Let the restored theme finish its color transition before the next accessibility scan.
  }
}
