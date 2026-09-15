import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { graphqlOperation } from './graphql.mjs';

export const STORES = {
  us:{ origin:'https://store.ui.com', path:'/us/en', currency:'USD' },
  eu:{ origin:'https://eu.store.ui.com', path:'/eu/en', currency:'EUR' },
  uk:{ origin:'https://uk.store.ui.com', path:'/uk/en', currency:'GBP' },
  ca:{ origin:'https://ca.store.ui.com', path:'/ca/en', currency:'CAD' },
};
export class CheckoutAttention extends Error {
  constructor(code = 'unavailable') { super('The Store checkout needs owner attention.'); this.name = 'CheckoutAttention'; this.code = code; }
}
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const addressKeys = ['type','firstName','lastName','businessName','address1','address2','city','country','province','postalCode','phoneNumber','taxId'];
const addressHash = address => address?.address1 && address?.country && address?.postalCode
  ? fingerprint(addressKeys.map(key=>String(address[key] || '').trim())) : null;
const shippingHash = shipping => shipping?.name && (shipping.storeShippingRateId || shipping.storeCarrierServiceId)
  ? fingerprint([shipping.name,shipping.storeShippingRateId || null,shipping.storeCarrierServiceId || null,Boolean(shipping.isSignatureRequired)]) : null;

export function checkoutItems(checkout) {
  if (!Array.isArray(checkout?.items)) throw new CheckoutAttention('cart');
  return checkout.items.map(item=>({ sku:item.sku, variantId:item.variant?.id, quantity:item.quantity }));
}
export function assertItems(checkout, attempt) {
  const items = checkoutItems(checkout);
  if (items.length !== 1 || items[0].sku !== attempt.sku || items[0].variantId !== attempt.variantId || items[0].quantity !== attempt.quantity
    || !Array.isArray(checkout.externalItems) || checkout.externalItems.length || checkout.orderId) throw new CheckoutAttention('cart');
  return items;
}

// Uses the Store's ordinary browser checkout. No direct ordering API, account-password collection,
// CAPTCHA solver, proxy rotation, or payment-detail storage is provided.
export class StoreBrowser {
  constructor(browser, { region, storageState, fixtureOrigin = null }) {
    this.browser = browser; this.region = region; this.store = STORES[region]; this.storageState = storageState;
    if (!this.store) throw new CheckoutAttention('session');
    // A fixture origin is supplied only by deterministic tests, never by the live companion.
    if (fixtureOrigin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureOrigin)) throw new Error('Fixture origin must be loopback.');
    this.fixtureOrigin = fixtureOrigin;
    this.origin = fixtureOrigin || this.store.origin;
    this.submitted = false; this.allowSubmission = null; this.order = null; this.checkout = null;
    this.createdOrder = null; this.observedAt = 0; this.pendingResponses = new Set();
  }
  async start() {
    this.context = await this.browser.newContext({ storageState:this.storageState, acceptDownloads:false, serviceWorkers:'block', locale:'en-US' });
    this.context.setDefaultTimeout(15000);
    this.page = await this.context.newPage();
    await this.context.route('**/*',async route => {
      const request = route.request(), url = new URL(request.url());
      let body; try { body = request.postDataJSON(); } catch {}
      const knownGraphql = this.fixtureOrigin ? url.origin === this.origin && url.pathname === '/graphql'
        : url.origin === 'https://ecomm.svc.ui.com' && url.pathname === '/graphql';
      const operations = Array.isArray(body) ? body : [body];
      const parsedOperations = knownGraphql && request.method() === 'POST' ? operations.map(graphqlOperation) : [];
      const storeHost = this.fixtureOrigin ? url.origin === this.origin : url.hostname === 'ui.com' || url.hostname.endsWith('.ui.com');
      const changesState = !['GET','HEAD','OPTIONS'].includes(request.method());
      // A renamed REST/RPC endpoint must not escape the recognized CreateOrder gate.
      // Interactive account sign-in remains available; automated checkout accepts only the observed GraphQL protocol.
      if (!this.submitted && changesState && storeHost && !knownGraphql && (this.automating || /order|payment|purchase|charge/i.test(url.pathname))) {
        this.gateRejected = true; return route.abort('blockedbyclient');
      }
      if (knownGraphql && changesState && (request.method() !== 'POST' || !parsedOperations.length || parsedOperations.some(op=>!op))) {
        this.gateRejected = true; return route.abort('blockedbyclient');
      }
      const createsOrder = parsedOperations.some(op=>op?.type === 'mutation' && op.fields.some(field=>field.name === 'createOrder'));
      if (createsOrder) {
        try {
          if (operations.length !== 1 || this.submitted || !this.allowSubmission) throw new CheckoutAttention('cart');
          const operation = parsedOperations[0], field = operation.fields[0];
          if (operation.name !== 'CreateOrder' || operation.fields.length !== 1 || field.responseName !== 'createOrder'
            || field.argumentsText !== '( input : $ input )') throw new CheckoutAttention('cart');
          const input = body.variables?.input;
          if (input?.checkoutId !== this.checkout?.id || String(input?.paymentMethod).toLowerCase() !== 'card') throw new CheckoutAttention('cart');
          await this.allowSubmission(input);
          this.submitted = true;
          // Do not hand an altered order total to the Store's subsequent card-payment handler.
          // An order may already exist at this point, so any failure still remains uncertain.
          const response = await route.fetch({ maxRedirects:0, maxRetries:0, timeout:30000 });
          const data = await response.json();
          const order = data?.data?.createOrder;
          if (order?.id) {
            this.createdOrder = { id:order.id,orderNumber:order.orderNumber };
            await this.onCreated?.(this.createdOrder);
          }
          if (!response.ok() || !order?.id || order.total?.amount !== this.submissionProof.totalMinor || order.total?.currency !== this.submissionProof.currency) throw new CheckoutAttention('cart');
          return route.fulfill({ response });
        } catch { this.gateRejected = true; return route.abort('blockedbyclient'); }
      }
      // Cart requests contain payment/purchase words in variables and response fragments.
      // Classify what the mutation executes, not the data it asks the Store to return.
      const orderMutation = parsedOperations.some(op=>op?.type === 'mutation'
        && /order|payment|purchase|charge/i.test(`${op.name || ''} ${op.fields.map(field=>field.name).join(' ')}`));
      const confirmsPayment = /(?:^|\.)stripe\.com$/.test(url.hostname) && /\/confirm(?:$|\?)/.test(url.pathname);
      if (!this.submitted && (orderMutation || confirmsPayment)) return route.abort('blockedbyclient');
      if (request.isNavigationRequest() && request.frame() === this.page.mainFrame() && url.protocol !== 'https:' && url.origin !== this.fixtureOrigin) return route.abort('blockedbyclient');
      return route.continue();
    });
    this.context.on('response',response => {
      const url = new URL(response.url());
      const allowed = this.fixtureOrigin ? url.origin === this.origin && url.pathname === '/graphql' : url.origin === 'https://ecomm.svc.ui.com' && url.pathname === '/graphql';
      if (!allowed || !response.ok()) return;
      const promise = this.observeResponse(response).catch(()=>{}).finally(()=>this.pendingResponses.delete(promise));
      this.pendingResponses.add(promise);
    });
    return this;
  }
  async observeResponse(response) {
    if (Number(response.headers()['content-length'] || 0) > 5*1024*1024) return;
    const body = await response.body(); if (body.length > 5*1024*1024) return;
    const parsed = JSON.parse(body.toString('utf8'));
    for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
      if (value.errors?.length) continue;
      const data = value.data || {};
      const checkout = data.storefrontCheckout?.checkout || data.storefrontUpdateCheckout?.checkout || data.storefrontCreateCheckout?.checkout;
      const start = response.request().timing().startTime;
      if (checkout && start >= (this.lastCheckoutRequest || 0)) {
        this.checkout = checkout; this.observedAt = Date.now(); this.lastCheckoutRequest = start;
      }
      if (this.submitted && data.createOrder?.id && !this.createdOrder) {
        this.createdOrder = { id:data.createOrder.id, orderNumber:data.createOrder.orderNumber };
        await this.onCreated?.(this.createdOrder);
      }
      if (data.storefrontOrder?.id) this.order = data.storefrontOrder;
    }
  }
  async settle() { await Promise.all([...this.pendingResponses]); }
  async visitCheckout() {
    this.checkout = null; this.observedAt = 0;
    await this.page.goto(`${this.origin}${this.store.path}/checkout`,{ waitUntil:'domcontentloaded' });
    await this.waitFor(()=>this.checkout || this.page.getByText(/your (?:shopping )?cart is empty|your cart is currently empty/i).isVisible().catch(()=>false));
    await this.settle();
  }
  async waitFor(check, timeout = 20000) {
    const until = Date.now()+timeout;
    while (Date.now() < until) { if (await check()) return; await delay(150); }
    throw new CheckoutAttention('unavailable');
  }
  async challenges() {
    const url = this.page.url();
    if (/\/(?:login|signin|sign-in)(?:[/?]|$)/i.test(url)) throw new CheckoutAttention('session');
    for (const frame of this.page.frames()) {
      // Invisible anti-abuse code remains part of the normal Store flow. Visible challenges need the owner.
      const element = await frame.frameElement().catch(()=>null);
      if (element && /recaptcha.*(?:bframe|challenge)|hcaptcha|3d.?secure|challenge/i.test(frame.url()) && await element.isVisible()) throw new CheckoutAttention('session');
    }
  }
  async selectedPayment() {
    const values = [];
    for (const frame of this.page.frames()) {
      let url; try { url = new URL(frame.url()); } catch { continue; }
      if (url.origin !== this.origin && !['https://js.stripe.com','https://hooks.stripe.com','https://checkout.link.com'].includes(url.origin)) continue;
      // Read only visibly selected, masked payment labels; never read payment/password input values.
      const labels = await frame.locator('input[type="radio"]:checked, [role="radio"][aria-checked="true"], [role="option"][aria-selected="true"]').evaluateAll(nodes=>nodes.map(node=>{
        const label = node.labels?.[0] || node.closest('label') || node;
        return label.innerText || label.getAttribute('aria-label') || '';
      })).catch(()=>[]);
      for (const label of labels) {
        const match = label.match(/\b(Visa|Mastercard|American Express|Amex|Discover)\b[\s\S]{0,40}?(?:[•*·]{2,}|ending (?:in|with))\s*(\d{4})\b/i);
        if (match) values.push(`${match[1].toLowerCase()}:${match[2]}`);
      }
    }
    const unique = [...new Set(values)];
    if (unique.length !== 1) throw new CheckoutAttention('session');
    return unique[0];
  }
  async inspectProfile(addressLabel) {
    await this.settle();
    let challengeFree = true;
    try { await this.challenges(); } catch (err) { if (!(err instanceof CheckoutAttention)) throw err; challengeFree = false; }
    const location = new URL(this.page.url());
    const atCheckout = location.origin === this.origin && location.pathname.startsWith(`${this.store.path}/checkout`);
    const checkout = this.checkout, shipping = addressHash(checkout?.shippingAddress), billing = addressHash(checkout?.billingAddress), delivery = shippingHash(checkout?.shippingOption);
    let payment = null;
    try { payment = await this.selectedPayment(); } catch (err) { if (!(err instanceof CheckoutAttention)) throw err; }
    const total = checkout?.totals?.summary?.total;
    const checks = [
      { name:'Store checkout page', ok:atCheckout, help:'Return to the checkout review page for the selected region.' },
      { name:'Checkout response', ok:Boolean(checkout), help:'Wait for checkout to load. If needed, reload the checkout page; a blocked or changed Store response cannot be verified.' },
      { name:'Store region', ok:checkout?.store?.id?.toLowerCase() === this.region, help:'Use the Store region selected in the terminal.' },
      { name:'Signed-in Store account', ok:Boolean(challengeFree && checkout?.hasCustomer && checkout?.email), help:'Sign in directly in this browser and finish any visible account or payment challenge.' },
      { name:'Setup cart', ok:Array.isArray(checkout?.items) && checkout.items.length === 1 && Array.isArray(checkout.externalItems) && !checkout.externalItems.length && !checkout.orderId, help:'Use one setup item without accessories, subscriptions, or an existing order.' },
      { name:'Shipping address', ok:Boolean(shipping), help:'Select and confirm a shipping address, including its country and postal code, in checkout. The nickname entered in the terminal does not create an address.' },
      { name:'Billing address', ok:Boolean(billing), help:'Select and confirm the billing address in checkout, including when it is the same as shipping.' },
      { name:'Shipping service', ok:Boolean(delivery), help:'Select a delivery service and continue to order review.' },
      { name:'Final total and tax', ok:Boolean(checkout?.taxCalculated && Number.isSafeInteger(total?.amount) && total.amount > 0 && total.currency === this.store.currency), help:'Wait for shipping, taxes, and a final total in the selected Store currency.' },
      { name:'Selected saved card', ok:Boolean(payment), help:'Select an existing saved Visa, Mastercard, Amex, or Discover card with a visible masked last-four label. New-card forms and wallets cannot be verified; do not place an order to save a card.' },
    ];
    if (checks.some(check=>!check.ok)) return { checks, profile:null };
    const profile = { id:crypto.randomUUID(), region:this.region, state:'ready', addressLabel, paymentLabel:`${payment.split(':')[0]} ···· ${payment.split(':')[1]}`,
      shipping, billing, delivery, payment, customer:fingerprint(checkout.email), storageState:await this.context.storageState() };
    return { checks, profile };
  }
  async captureProfile(addressLabel) {
    const { profile } = await this.inspectProfile(addressLabel);
    if (!profile) throw new CheckoutAttention('session');
    return profile;
  }
  async confirmEmptyCart() {
    try { await this.visitCheckout(); await this.challenges(); }
    catch (err) { if (!(err instanceof CheckoutAttention)) throw err; return false; }
    const location = new URL(this.page.url());
    if (location.origin !== this.origin || !location.pathname.startsWith(`${this.store.path}/checkout`)) return false;
    if (this.checkout) return Array.isArray(this.checkout.items) && !this.checkout.items.length
      && Array.isArray(this.checkout.externalItems) && !this.checkout.externalItems.length && !this.checkout.orderId;
    return this.page.getByText(/your (?:shopping )?cart is empty|your cart is currently empty/i).isVisible().catch(()=>false);
  }
  async proof(attempt, profile) {
    await this.settle(); await this.challenges();
    const location = new URL(this.page.url());
    if (location.origin !== this.origin || !location.pathname.startsWith(`${this.store.path}/checkout`)) throw new CheckoutAttention('session');
    const checkout = this.checkout;
    const items = assertItems(checkout,attempt), total = checkout.totals?.summary?.total;
    if (checkout.store?.id?.toLowerCase() !== this.region || !Number.isSafeInteger(total?.amount) || total.amount < 1 || total.currency !== attempt.currency
      || !checkout.hasCustomer || fingerprint(checkout.email) !== profile.customer || !checkout.taxCalculated || addressHash(checkout.shippingAddress) !== profile.shipping
      || addressHash(checkout.billingAddress) !== profile.billing || shippingHash(checkout.shippingOption) !== profile.delivery
      || await this.selectedPayment() !== profile.payment || Date.now()-this.observedAt > 10000) throw new CheckoutAttention('cart');
    return { checkoutId:checkout.id, profileId:profile.id, items, totalMinor:total.amount, currency:total.currency,
      taxCalculated:true, shippingSelected:true, addressVerified:true, paymentVerified:true, hasCustomer:true, externalItemCount:0, observedAt:new Date(this.observedAt).toISOString() };
  }
  async prepare(attempt, profile) {
    this.automating = true;
    const url = new URL(attempt.url);
    if (url.origin !== this.store.origin || url.username || url.password || !url.pathname.startsWith(`${this.store.path}/`) || !url.pathname.includes('/products/')) throw new CheckoutAttention('cart');
    await this.visitCheckout(); await this.challenges();
    if (this.checkout && (checkoutItems(this.checkout).length || this.checkout.externalItems?.length || this.checkout.orderId)) throw new CheckoutAttention('cart');
    const productUrl = this.fixtureOrigin ? `${this.origin}${url.pathname}${url.search}` : url.href;
    await this.page.goto(productUrl,{ waitUntil:'domcontentloaded' }); await this.challenges();
    // Selectors use the English Store UI and fail closed on ambiguity or layout changes.
    const add = this.page.getByRole('button',{ name:/^add to cart$/i });
    await add.waitFor({ state:'visible' });
    if (await add.count() !== 1 || !await add.isEnabled()) throw new CheckoutAttention('unavailable');
    if (attempt.quantity !== 1) {
      const qty = this.page.getByRole('spinbutton',{ name:/quantity/i });
      if (await qty.count() !== 1) throw new CheckoutAttention('cart');
      await qty.fill(String(attempt.quantity));
    }
    await add.click();
    await this.page.getByRole('button',{ name:/^added(?: to cart)?$/i }).waitFor({ state:'visible', timeout:5000 }).catch(()=>{});
    await this.visitCheckout();
    for (let step=0; step<4; step++) {
      await this.settle(); await this.challenges(); assertItems(this.checkout,attempt);
      const place = this.page.getByRole('button',{ name:/^place order$/i });
      if (await place.count() === 1 && await place.isVisible() && await place.isEnabled()) {
        await this.proof(attempt,profile); return;
      }
      const next = this.page.getByRole('button',{ name:/^(?:continue|continue to (?:shipping|delivery|payment)|proceed to checkout)$/i });
      if (await next.count() !== 1 || !await next.isEnabled()) throw new CheckoutAttention('session');
      const old = this.observedAt;
      await next.click(); await this.waitFor(()=>this.observedAt > old);
    }
    throw new CheckoutAttention('session');
  }
  async submit(attempt, profile, { authorize, beforeSubmit, onCreated }) {
    this.onCreated = onCreated;
    this.allowSubmission = async () => {
      const proof = await this.proof(attempt,profile);
      this.submissionProof = proof;
      const permit = await authorize(proof);
      if (permit.authorized !== true || Date.parse(permit.expiresAt) <= Date.now()) throw new CheckoutAttention('interrupted');
      // The local journal is fsynced before releasing this single outgoing order request.
      await beforeSubmit(proof);
      if (Date.parse(permit.expiresAt) <= Date.now()) throw new CheckoutAttention('interrupted');
    };
    const place = this.page.getByRole('button',{ name:/^place order$/i });
    await place.click();
    await this.waitFor(async()=>{
      if (this.gateRejected) throw new CheckoutAttention('cart');
      await this.challenges();
      return this.order && this.receipt(attempt);
    },60000);
    return this.receipt(attempt);
  }
  receipt(attempt) {
    const order = this.order;
    if (!order || !this.createdOrder || order.id !== this.createdOrder.id || order.checkoutId !== this.checkout?.id
      || !['paid','succeeded'].includes(String(order.payment?.status).toLowerCase())) return null;
    const items = order.items?.map(item=>({ sku:item.sku, variantId:item.storeProductVariantId, quantity:item.quantity }));
    if (JSON.stringify(items) !== JSON.stringify(checkoutItems(this.checkout))) return null;
    const total = order.totals?.summary?.total;
    if (total?.currency !== attempt.currency || !Number.isSafeInteger(total.amount)) return null;
    return { paid:true, orderId:order.id, orderNumber:order.orderNumber, checkoutId:order.checkoutId, currency:total.currency, totalMinor:total.amount, items };
  }
  async close() { await this.context?.close(); }
}
