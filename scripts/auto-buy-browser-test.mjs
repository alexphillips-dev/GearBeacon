import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../checkout/node_modules/playwright/index.mjs';
import { CheckoutAttention, StoreBrowser } from '../checkout/store.mjs';
import { testProfileSetup } from './auto-buy-profile-test.mjs';
import { graphqlOperation } from '../checkout/graphql.mjs';
import { runAttempt } from '../checkout/runner.mjs';
import { openVault } from '../checkout/vault.mjs';
import { validateDashboardUrl } from '../checkout/client.mjs';

const testDir = await mkdtemp(join(tmpdir(),'gearbeacon-checkout-browser-'));
const address={ type:'Residential',firstName:'Test',lastName:'Owner',address1:'123 Example Street',city:'Example',country:'US',province:'PA',postalCode:'00000' };
const shipping={ name:'Standard',storeShippingRateId:'fixture-standard',storeCarrierServiceId:null };
const item={sku:'MOCK-SKU',variant:{id:'mock-variant'},quantity:1};
let cart=[], orders=0, cartUpdates=0, authorizationCount=0, submittedJournal=false, mode='success';
const total={amount:32900,currency:'USD'};
// Match the Store's mutation/fragment shape without copying customer data or its full document.
const checkoutFragment='fragment CheckoutFragment on StorefrontCheckout { id availablePaymentProviders { id } supplementalPurchaseProducts @skip(if:$skipSupplementalPurchaseProducts) { id } }';
const createCheckoutQuery=`mutation CreateCheckout($input:StorefrontCreateCheckoutInput!,$skipSupplementalPurchaseProducts:Boolean=false){storefrontCreateCheckout(input:$input){checkout{...CheckoutFragment}}} ${checkoutFragment}`;
const updateCheckoutQuery=`mutation UpdateCheckout($input:StorefrontUpdateCheckoutInput!,$skipSupplementalPurchaseProducts:Boolean=false){storefrontUpdateCheckout(input:$input){checkout{...CheckoutFragment}}} ${checkoutFragment}`;
const createOrderQuery='mutation CreateOrder($input:CreateOrderInput!){createOrder(input:$input){id orderNumber total { amount currency }}}';
function checkout() { return {id:'fixture-checkout',store:{id:'us'},email:'owner@example.invalid',hasCustomer:true,taxCalculated:true,items:cart,externalItems:[],shippingAddress:address,billingAddress:address,shippingOption:shipping,totals:{summary:{total}},orderId:null}; }
const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type',req.url==='/graphql'?'application/json':'text/html; charset=utf-8');
  if(req.url==='/unexpected-order') { orders++;res.setHeader('Content-Type','application/json');res.end('{}');return; }
  if(req.url==='/graphql') {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());let data;
    if(body.operationName==='CreateCheckout'){cart=[{...item,quantity:body.variables.quantity}];data={storefrontCreateCheckout:{checkout:checkout()}};}
    else if(body.operationName==='UpdateCheckout'){cartUpdates++;data={storefrontUpdateCheckout:{checkout:checkout()}};}
    else if(body.operationName==='GetCheckout')data={storefrontCheckout:{checkout:checkout()}};
    else if(body.operationName==='CreateOrder'){
      assert.equal(submittedJournal,true,'The order reached the Store before durable local journaling');
      orders++;data={createOrder:{id:'fixture-order',orderNumber:'TEST-123',total:mode==='changed-total'?{...total,amount:99999}:total}};
    } else if(body.operationName==='GetStorefrontOrder')data={storefrontOrder:{id:'fixture-order',orderNumber:'TEST-123',checkoutId:'fixture-checkout',payment:{status:mode==='pending'?'Pending':'Paid'},items:cart.map(i=>({sku:i.sku,storeProductVariantId:i.variant.id,quantity:i.quantity})),totals:{summary:{total}}}};
    else {res.statusCode=400;data={};}
    res.end(JSON.stringify({data}));return;
  }
  const script=`const queries=${JSON.stringify({CreateCheckout:createCheckoutQuery,UpdateCheckout:updateCheckoutQuery,CreateOrder:createOrderQuery})};const gql=async(operationName,variables={})=>(await fetch(${JSON.stringify(mode==='changed-endpoint')}&&operationName==='CreateOrder'?'/unexpected-order':'/graphql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationName,variables,query:queries[operationName]||'query '+operationName+' { fixture }'})})).json();`;
  if(req.url.includes('/products/'))res.end(`<!doctype html><html lang="en"><title>Fixture product</title><label>Quantity<input type="number" value="1" id="quantity"></label><button id="add">Add to Cart</button><script>${script}add.onclick=async()=>{try{await gql('CreateCheckout',{quantity:Number(quantity.value)});add.textContent='Added to Cart';}catch{add.textContent='Unable to create checkout';}};</script></html>`);
  else res.end(`<!doctype html><html lang="en"><title>Fixture checkout</title>${cart.length ? '<h1>Order review</h1><label><input type="radio" name="payment" checked>Visa •••• 4242</label><button id="update">Update delivery</button><button id="place">Place Order</button>' : '<h1>Your cart is empty</h1>'}<script>${script}gql('GetCheckout');const update=document.getElementById('update');if(update)update.onclick=async()=>{try{await gql('UpdateCheckout',{input:{}});update.textContent='Delivery updated';}catch{update.textContent='Unable to update checkout';}};const place=document.getElementById('place');if(place)place.onclick=async()=>{try{await gql('CreateOrder',{input:{checkoutId:'fixture-checkout',paymentMethod:'Card'}});await gql('GetStorefrontOrder');}catch{}};</script></html>`);
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${server.address().port}`;
const executable=[process.env.CHROME_PATH,process.platform==='win32'?join(process.env.PROGRAMFILES||'','Google','Chrome','Application','chrome.exe'):null,
  '/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file=>file&&existsSync(file));
let browser;
const attempt={id:'fixture-attempt',authorization:'fixture-authorization',region:'us',sku:'MOCK-SKU',variantId:'mock-variant',quantity:1,currency:'USD',maxTotalMinor:35000,url:'https://store.ui.com/us/en/category/mock/products/test?variant=exact'};
try {
  await testProfileSetup();
  assert.equal(new CheckoutAttention('session').name,'CheckoutAttention','Validation errors must not fall through to an installation error');
  for(const [operationName,query,field] of [['CreateCheckout',createCheckoutQuery,'storefrontCreateCheckout'],['UpdateCheckout',updateCheckoutQuery,'storefrontUpdateCheckout'],['CreateOrder',createOrderQuery,'createOrder']]) {
    const parsed=graphqlOperation({operationName,query});
    assert.equal(parsed.type,'mutation');assert.equal(parsed.name,operationName);assert.deepEqual(parsed.fields.map(f=>f.name),[field]);
  }
  const literalQuery='mutation CreateCheckout($input:Input={note:"mutation CreateOrder { createOrder }",other:"""Payment \\""" Charge"""}) @example(value:{names:["Purchase"]}) { saved:storefrontCreateCheckout(input:$input) { checkout { ...CheckoutFragment } } } fragment CheckoutFragment on StorefrontCheckout { constructor toString ... on StorefrontCheckout { orderId } }';
  assert.deepEqual(graphqlOperation({query:literalQuery}).fields.map(f=>[f.name,f.responseName]),[['storefrontCreateCheckout','saved']]);
  assert.equal(graphqlOperation({query:'# mutation CreateOrder { createOrder }\n{ storefrontCheckout { orderId availablePaymentProviders { id } } }'}).type,'query');
  const deniedDocuments=[
    {operationName:'Different',query:createCheckoutQuery},
    {query:'mutation CreateCheckout { storefrontCreateCheckout { id } } mutation CreateOrder { createOrder { id } }'},
    {query:'mutation CreateCheckout { ...Submit } fragment Submit on Mutation { createOrder { id } }'},
    {query:'mutation CreateCheckout { ... on Mutation { createOrder { id } } }'},
    {query:'mutation CreateCheckout { storefrontCreateCheckout(input:{note:"unterminated}) { id } }'},
    {query:'mutation CreateCheckout($input:Input]) { storefrontCreateCheckout { id } }'},
    {operationName:'CreateOrder',extensions:{persistedQuery:{sha256Hash:'fixture'}}},
  ];
  for(const body of deniedDocuments)assert.equal(graphqlOperation(body),null,'Unsupported mutation was accepted');
  assert.throws(()=>validateDashboardUrl('http://example.com'),/HTTPS/);
  assert.throws(()=>validateDashboardUrl('https://user:secret@example.com'),/HTTPS/);
  assert.equal(validateDashboardUrl('https://dashboard.example.com'),'https://dashboard.example.com');
  browser=await chromium.launch({headless:true,chromiumSandbox:true,...(executable?{executablePath:executable}:{})});
  cart=[];let store=await new StoreBrowser(browser,{region:'us',fixtureOrigin:origin}).start();
  await store.page.goto(`${origin}/us/en/products/test`);
  await store.page.getByRole('button',{name:'Add to Cart'}).click();
  await store.page.waitForFunction(()=>document.getElementById('add').textContent!=='Add to Cart');
  assert.equal(await store.page.locator('#add').textContent(),'Added to Cart','Setup blocked the Store cart-creation mutation');
  await store.visitCheckout();
  await store.page.getByRole('button',{name:'Update delivery'}).click();
  await store.page.waitForFunction(()=>document.getElementById('update').textContent!=='Update delivery');
  assert.equal(await store.page.locator('#update').textContent(),'Delivery updated','Setup blocked the Store cart-update mutation');
  assert.equal(cartUpdates,1);
  const profile=await store.captureProfile('Test home');attempt.profileId=profile.id;
  // Stripe's passive helper can occupy a 1px frame that Playwright calls visible.
  // Serve all provider frames locally; these tests never contact Stripe or use real payment data.
  await store.context.route('https://js.stripe.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><title>Provider fixture</title><body>Fixture</body></html>'}));
  await store.page.evaluate(()=>{
    const frame=document.createElement('iframe');frame.id='passive-provider';
    frame.src='https://js.stripe.com/v3/hcaptcha-invisible-fixture.html';
    frame.style.cssText='position:fixed;width:1px;height:1px;border:0;opacity:0;left:0;top:0';document.body.append(frame);
  });
  await store.page.waitForFunction(()=>document.getElementById('passive-provider').contentWindow!==null);
  await store.waitFor(()=>store.page.frames().some(frame=>frame.url().includes('hcaptcha-invisible-fixture')));
  assert.equal(await store.page.locator('#passive-provider').isVisible(),true,'Fixture did not reproduce the passive-frame visibility trap');
  assert.equal((await store.inspectProfile('Test home')).checks.find(check=>check.name==='Signed-in Store account').ok,true,'A passive payment helper was reported as a signed-out Store account');
  await assert.doesNotReject(()=>store.challenges(),'Passive verification was treated as a visible challenge');
  await store.page.locator('#passive-provider').evaluate(node=>{node.style.cssText='width:300px;height:200px;border:0';});
  await assert.rejects(()=>store.challenges(),err=>err.code==='session','An expanded helper must still stop for owner attention');
  await store.page.locator('#passive-provider').evaluate(node=>node.remove());
  await store.page.evaluate(()=>{
    const frame=document.createElement('iframe');frame.id='active-provider';frame.src='https://js.stripe.com/v3/three-ds-2-challenge-fixture.html';
    frame.style.cssText='width:300px;height:200px;border:0';document.body.append(frame);
  });
  await store.waitFor(()=>store.page.frames().some(frame=>frame.url().includes('three-ds-2-challenge-fixture')));
  await assert.rejects(()=>store.challenges(),err=>err.code==='session');
  const challengeReport=await store.inspectProfile('Test home');
  assert.equal(challengeReport.checks.find(check=>check.name==='Signed-in Store account').ok,true,'A payment challenge was confused with account sign-in');
  assert.equal(challengeReport.checks.find(check=>check.name==='Checkout security challenge').ok,false);
  assert.equal(challengeReport.profile,null,'An active payment challenge allowed profile capture');
  await assert.rejects(()=>store.proof(attempt,profile),err=>err.code==='session','The order authorization proof ignored a visible challenge');
  await store.page.locator('#active-provider').evaluate(node=>node.remove());
  await store.context.route('https://provider.example.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Unknown provider fixture</title>'}));
  await store.page.evaluate(()=>{
    const frame=document.createElement('iframe');frame.id='unknown-provider';frame.src='https://provider.example.invalid/v3/hcaptcha-invisible-fixture.html';
    frame.style.cssText='width:1px;height:1px;border:0';document.body.append(frame);
  });
  await store.waitFor(()=>store.page.frames().some(frame=>frame.url().includes('provider.example.invalid')));
  await assert.rejects(()=>store.challenges(),err=>err.code==='session','A different origin inherited the Stripe helper exception');
  await store.page.locator('#unknown-provider').evaluate(node=>node.remove());
  const completeCheckout=structuredClone(store.checkout);
  for(const [field,name] of [['shippingAddress','Shipping address'],['billingAddress','Billing address'],['shippingOption','Shipping service'],['email','Signed-in Store account'],['hasCustomer','Signed-in Store account'],['taxCalculated','Final total and tax']]) {
    store.checkout={...completeCheckout,[field]:null};
    const report=await store.inspectProfile('Test home');
    assert.equal(report.profile,null);assert.equal(report.checks.find(check=>check.name===name).ok,false);
    assert.ok(!JSON.stringify(report.checks).includes(address.address1),'Validation output leaked a private address');
  }
  store.checkout=completeCheckout;
  await store.page.locator('input[name=payment]').evaluate(node=>node.checked=false);
  const noCard=await store.inspectProfile('Test home');assert.equal(noCard.profile,null);assert.equal(noCard.checks.find(check=>check.name==='Selected saved card').ok,false);
  await store.page.evaluate(()=>{
    const frame=document.createElement('iframe');frame.id='card-entry';frame.src='https://js.stripe.com/v3/elements-inner-payment-fixture.html';document.body.append(frame);
  });
  await store.waitFor(()=>store.page.frames().some(frame=>frame.url().includes('elements-inner-payment-fixture')));
  const cardFrame=store.page.frames().find(frame=>frame.url().includes('elements-inner-payment-fixture'));
  await cardFrame.setContent('<!doctype html><label>Card number<input autocomplete="cc-number" name="cardnumber"></label><label>Security code<input autocomplete="cc-csc"></label>');
  await cardFrame.evaluate(()=>{
    window.fixturePaymentReads=0;
    for(const input of document.querySelectorAll('input'))Object.defineProperty(input,'value',{get(){window.fixturePaymentReads++;throw Error('Do not read payment field values');}});
  });
  const entryReport=await store.inspectProfile('Test home');
  assert.equal(entryReport.paymentStatus,'card-entry');assert.equal(entryReport.profile,null);
  assert.match(entryReport.checks.find(check=>check.name==='Selected saved card').help,/cannot be saved for unattended auto-buy/);
  assert.equal(await cardFrame.evaluate(()=>window.fixturePaymentReads),0,'Diagnostics read raw payment fields');
  await cardFrame.locator('input[autocomplete="cc-number"]').evaluate(node=>{node.removeAttribute('autocomplete');node.removeAttribute('name');});
  assert.equal((await store.inspectProfile('Test home')).paymentStatus,'card-entry','A labelled card-entry field was not identified');
  assert.equal(await cardFrame.evaluate(()=>window.fixturePaymentReads),0,'Label-based diagnostics read raw payment fields');
  await store.page.locator('#card-entry').evaluate(node=>node.remove());
  await store.page.locator('input[name=payment]').check();
  assert.equal(await store.confirmEmptyCart(),false,'A setup item was mistaken for an empty cart');
  const blocked=await store.page.evaluate(async bodies=>{
    const results=[];
    for(const body of bodies)results.push(await fetch('/graphql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(()=>false,()=>true));
    return results;
  },[...deniedDocuments,
    {operationName:'CreateCheckout',query:'mutation CreateCheckout($input:Input!) { innocuous:createOrder(input:$input) { id } }'},
    {operationName:'GetSomething',query:'mutation GetSomething { saved:confirmPayment { id } }'},
    [{operationName:'CreateCheckout',query:createCheckoutQuery},{operationName:'CreateOrder',query:createOrderQuery}],
  ]);
  assert.ok(blocked.every(Boolean),'An unapproved order/payment or unsupported mutation escaped setup');
  await store.page.getByRole('button',{name:'Place Order'}).click();await store.page.waitForTimeout(200);assert.equal(orders,0,'Setup allowed an order');await store.close();
  const vault=openVault(testDir),state={profiles:{us:profile},journal:{}};
  const unlock=vault.lock();assert.throws(()=>vault.lock(),err=>err.code==='locked');unlock();
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
  profile.state='ready';cart=[];mode='changed-endpoint';
  const previousAuthorizations=authorizationCount;
  await runAttempt({client,vault:journalVault,state,attempt:{...attempt,id:'changed-endpoint',authorization:'changed-endpoint'},makeStore});
  assert.equal(orders,3,'An unrecognized checkout endpoint bypassed the order gate');
  assert.equal(authorizationCount,previousAuthorizations);assert.equal(state.journal['changed-endpoint'].state,'attention');
  console.log('AUTO-BUY BROWSER TEST PASSED: passive Stripe helper vs active challenges, separate account proof, private card-entry diagnostics, Store-shaped cart creation/update, GraphQL mutation classification, saved profile capture, setup submission blocking, full mock checkout, durable encrypted journaling, duplicate protection, foreign carts, lost authorization and uncertain payment.');
}finally{await browser?.close();await new Promise(done=>server.close(done));await rm(testDir,{recursive:true,force:true});}
