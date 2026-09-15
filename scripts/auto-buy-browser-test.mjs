import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../checkout/node_modules/playwright/index.mjs';
import { StoreBrowser } from '../checkout/store.mjs';
import { runAttempt } from '../checkout/runner.mjs';
import { openVault } from '../checkout/vault.mjs';
import { validateDashboardUrl } from '../checkout/client.mjs';

const testDir = await mkdtemp(join(tmpdir(),'gearbeacon-checkout-browser-'));
const address={ type:'Residential',firstName:'Test',lastName:'Owner',address1:'123 Example Street',city:'Example',country:'US',province:'PA',postalCode:'00000' };
const shipping={ name:'Standard',storeShippingRateId:'fixture-standard',storeCarrierServiceId:null };
const item={sku:'MOCK-SKU',variant:{id:'mock-variant'},quantity:1};
let cart=[], orders=0, authorizationCount=0, submittedJournal=false, mode='success';
const total={amount:32900,currency:'USD'};
function checkout() { return {id:'fixture-checkout',store:{id:'us'},email:'owner@example.invalid',hasCustomer:true,taxCalculated:true,items:cart,externalItems:[],shippingAddress:address,billingAddress:address,shippingOption:shipping,totals:{summary:{total}},orderId:null}; }
const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type',req.url==='/graphql'?'application/json':'text/html; charset=utf-8');
  if(req.url==='/graphql') {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());let data;
    if(body.operationName==='AddItem'){cart=[{...item,quantity:body.variables.quantity}];data={storefrontCreateCheckout:{checkout:checkout()}};}
    else if(body.operationName==='GetCheckout')data={storefrontCheckout:{checkout:checkout()}};
    else if(body.operationName==='CreateOrder'){
      assert.equal(submittedJournal,true,'The order reached the Store before durable local journaling');
      orders++;data={createOrder:{id:'fixture-order',orderNumber:'TEST-123',total:mode==='changed-total'?{...total,amount:99999}:total}};
    } else if(body.operationName==='GetStorefrontOrder')data={storefrontOrder:{id:'fixture-order',orderNumber:'TEST-123',checkoutId:'fixture-checkout',payment:{status:mode==='pending'?'Pending':'Paid'},items:cart.map(i=>({sku:i.sku,storeProductVariantId:i.variant.id,quantity:i.quantity})),totals:{summary:{total}}}};
    else {res.statusCode=400;data={};}
    res.end(JSON.stringify({data}));return;
  }
  const script=`const gql=async(operationName,variables={})=>(await fetch('/graphql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationName,variables,query:operationName==='CreateOrder'?'mutation CreateOrder { createOrder }':'query '+operationName+' { fixture }'})})).json();`;
  if(req.url.includes('/products/'))res.end(`<!doctype html><html lang="en"><title>Fixture product</title><label>Quantity<input type="number" value="1" id="quantity"></label><button id="add">Add to Cart</button><script>${script}add.onclick=async()=>{await gql('AddItem',{quantity:Number(quantity.value)});add.textContent='Added to Cart';};</script></html>`);
  else res.end(`<!doctype html><html lang="en"><title>Fixture checkout</title>${cart.length ? '<h1>Order review</h1><label><input type="radio" name="payment" checked>Visa •••• 4242</label><button id="place">Place Order</button>' : '<h1>Your cart is empty</h1>'}<script>${script}gql('GetCheckout');const place=document.getElementById('place');if(place)place.onclick=async()=>{try{await gql('CreateOrder',{input:{checkoutId:'fixture-checkout',paymentMethod:'Card'}});await gql('GetStorefrontOrder');}catch{}};</script></html>`);
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${server.address().port}`;
const executable=[process.env.CHROME_PATH,process.platform==='win32'?join(process.env.PROGRAMFILES||'','Google','Chrome','Application','chrome.exe'):null,
  '/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file=>file&&existsSync(file));
let browser;
const attempt={id:'fixture-attempt',authorization:'fixture-authorization',region:'us',sku:'MOCK-SKU',variantId:'mock-variant',quantity:1,currency:'USD',maxTotalMinor:35000,url:'https://store.ui.com/us/en/category/mock/products/test?variant=exact'};
try {
  assert.throws(()=>validateDashboardUrl('http://example.com'),/HTTPS/);
  assert.throws(()=>validateDashboardUrl('https://user:secret@example.com'),/HTTPS/);
  assert.equal(validateDashboardUrl('https://dashboard.example.com'),'https://dashboard.example.com');
  browser=await chromium.launch({headless:true,chromiumSandbox:true,...(executable?{executablePath:executable}:{})});
  cart=[item];let store=await new StoreBrowser(browser,{region:'us',fixtureOrigin:origin}).start();await store.visitCheckout();
  const profile=await store.captureProfile('Test home');attempt.profileId=profile.id;
  await store.page.getByRole('button',{name:'Place Order'}).click();await store.page.waitForTimeout(200);assert.equal(orders,0,'Setup allowed an order');await store.close();
  const vault=openVault(testDir),state={profiles:{us:profile},journal:{}};
  const unlock=vault.lock();assert.throws(()=>vault.lock(),/already/);unlock();
  vault.write({...state,token:'private-fixture-token'});
  assert.ok(!(await readFile(join(testDir,'vault.checkout-state'),'utf8')).includes('private-fixture-token'));
  assert.equal(vault.read().token,'private-fixture-token');
  const client=async(action,body)=>{
    if(action.endsWith('/authorize')){authorizationCount++;assert.ok(body.taxCalculated&&body.addressVerified&&body.paymentVerified);assert.equal(body.totalMinor,32900);return{authorized:true,expiresAt:new Date(Date.now()+2000).toISOString()};}
    if(action.endsWith('/complete')){assert.equal(body.orderNumber,'TEST-123');assert.equal(body.paid,true);return{ok:true};}
    return{ok:true};
  };
  const makeStore=async()=>{
    const s=await new StoreBrowser(browser,{region:'us',storageState:profile.storageState,fixtureOrigin:origin}).start();
    const wait=s.waitFor.bind(s);s.waitFor=(check,timeout)=>wait(check,Math.min(timeout||20000,2500));return s;
  };
  const journalVault={write:value=>{vault.write(value);submittedJournal=Object.values(vault.read().journal).some(r=>r.state==='submitting');}};
  cart=[];await runAttempt({client,vault:journalVault,state,attempt,makeStore});
  assert.equal(orders,1);assert.equal(authorizationCount,1);assert.equal(state.journal[attempt.authorization].state,'reported');
  await runAttempt({client,vault:journalVault,state,attempt,makeStore});assert.equal(orders,1,'A repeated attempt placed a second order');
  // A foreign cart cannot reach authorization or order submission.
  cart=[{sku:'OTHER',variant:{id:'other'},quantity:1}];profile.state='ready';
  await runAttempt({client,vault:journalVault,state,attempt:{...attempt,id:'foreign-cart',authorization:'foreign-cart'},makeStore});
  assert.equal(orders,1);assert.equal(profile.state,'attention');
  // A lost authorization response is never retried and never releases the request.
  profile.state='ready';cart=[];
  await runAttempt({client:async(action,body)=>{if(action.endsWith('/authorize'))throw Error('Lost response');return client(action,body);},vault:journalVault,state,attempt:{...attempt,id:'lost-auth',authorization:'lost-auth'},makeStore});
  assert.equal(orders,1);assert.equal(state.journal['lost-auth'].state,'unknown');
  // An order with unconfirmed payment is retained as unknown, with its reference journaled.
  profile.state='ready';cart=[];mode='pending';
  await runAttempt({client,vault:journalVault,state,attempt:{...attempt,id:'pending-payment',authorization:'pending-payment'},makeStore});
  assert.equal(orders,2);assert.equal(state.journal['pending-payment'].state,'unknown');assert.equal(state.journal['pending-payment'].order.id,'fixture-order');
  profile.state='ready';cart=[];mode='changed-total';
  await runAttempt({client,vault:journalVault,state,attempt:{...attempt,id:'changed-total',authorization:'changed-total'},makeStore});
  assert.equal(orders,3);assert.equal(state.journal['changed-total'].state,'unknown');
  assert.equal(state.journal['changed-total'].receipt,undefined,'A changed order total reached the paid-order flow');
  console.log('AUTO-BUY BROWSER TEST PASSED: saved profile capture, setup submission blocking, full mock checkout, durable encrypted journaling, duplicate protection, foreign carts, lost authorization and uncertain payment.');
}finally{await browser?.close();await new Promise(done=>server.close(done));await rm(testDir,{recursive:true,force:true});}
