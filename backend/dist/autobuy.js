// @ts-nocheck
// Purchasing has its own durable state machine. Notification retries cannot submit orders.
const crypto = require('node:crypto');
const AUTO_BUY_SCHEMA = `
  CREATE TABLE auto_buy_connection (
    id INTEGER PRIMARY KEY CHECK(id=1), token_hash TEXT NOT NULL, generation TEXT NOT NULL,
    mode TEXT NOT NULL, profiles_json TEXT NOT NULL DEFAULT '{}', last_seen TEXT
  );
  CREATE TABLE auto_buy_rules (
    id TEXT PRIMARY KEY, region TEXT NOT NULL, slug TEXT NOT NULL, revision INTEGER NOT NULL,
    authorization TEXT NOT NULL UNIQUE, config_json TEXT NOT NULL, state TEXT NOT NULL,
    reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(region,slug)
  );
  CREATE TABLE auto_buy_attempts (
    id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, authorization TEXT NOT NULL UNIQUE,
    region TEXT NOT NULL, slug TEXT NOT NULL, config_json TEXT NOT NULL, state TEXT NOT NULL,
    generation TEXT, proof_json TEXT, receipt_json TEXT, reason TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_auto_buy_attempt_state ON auto_buy_attempts(state,created_at);
`;
const stamp = () => new Date().toISOString();
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const text = (value, name, max = 160) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value))
        fail(`Invalid ${name}.`);
    return value.trim();
};
const positive = (value, name, max) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
        fail(`Invalid ${name}.`);
    return value;
};
const reasons = {
    connection: 'Checkout companion disconnected. Reconnect before arming.',
    session: 'Store sign-in or saved payment needs attention. Reconnect the Store.',
    cart: 'The checkout does not match the authorized item, quantity, address, payment, currency, or total.',
    expired: 'The purchase authorization expired.',
    paused: 'Paused by the owner.',
    removed: 'The watch or its purchase plan changed.',
    interrupted: 'Checkout was interrupted before submission. Review the Store cart before rearming.',
    unknown: 'An order may have been submitted. Check your Store orders before allowing another purchase.',
    restored: 'Restored purchase instructions need fresh authorization.',
    purchased: 'One order completed. Auto-buy stopped.',
    unavailable: 'The item is no longer available or the Store requires attention.',
};
function createAutoBuy({ db, regions, mock, getProduct, eligible, purchased, notify }) {
    let pairing = null;
    const tx = fn => { db.exec('BEGIN IMMEDIATE'); try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    }
    catch (err) {
        db.exec('ROLLBACK');
        throw err;
    } };
    const connection = () => db.prepare('SELECT * FROM auto_buy_connection WHERE id=1').get();
    const ruleRow = id => db.prepare('SELECT * FROM auto_buy_rules WHERE id=?').get(id);
    const attemptRow = id => db.prepare('SELECT * FROM auto_buy_attempts WHERE id=?').get(id);
    const active = () => db.prepare("SELECT * FROM auto_buy_attempts WHERE state IN ('preparing','submitting','unknown') LIMIT 1").get();
    const publicRule = row => row ? { id: row.id, region: row.region, slug: row.slug, revision: row.revision, ...JSON.parse(row.config_json), state: row.state, reason: row.reason, updatedAt: row.updated_at } : null;
    const publicAttempt = row => ({ id: row.id, ruleId: row.rule_id, region: row.region, slug: row.slug, ...JSON.parse(row.config_json), state: row.state, reason: row.reason, receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null, createdAt: row.created_at, updatedAt: row.updated_at });
    function changeRule(id, state, code) {
        db.prepare('UPDATE auto_buy_rules SET state=?,reason=?,updated_at=? WHERE id=?').run(state, reasons[code] || null, stamp(), id);
    }
    function attention(row, code, state = 'attention') {
        db.prepare('UPDATE auto_buy_attempts SET state=?,reason=?,updated_at=? WHERE id=?').run(state, reasons[code], stamp(), row.id);
        const current = ruleRow(row.rule_id);
        if (current?.authorization === row.authorization)
            changeRule(current.id, state === 'unknown' ? 'attention' : 'paused', code);
    }
    function maintain() {
        const now = Date.now();
        for (const row of db.prepare("SELECT * FROM auto_buy_rules WHERE state='armed'").all()) {
            const config = JSON.parse(row.config_json);
            if (Date.parse(config.expiresAt) <= now)
                pause(row.id, 'expired');
            else if (!eligible(row.region, row.slug, config.collectionId, config.quantity))
                pause(row.id, 'removed');
        }
        const busy = active();
        if (busy && busy.state !== 'unknown' && now - Date.parse(busy.updated_at) > 120000) {
            tx(() => attention(busy, busy.state === 'submitting' ? 'unknown' : 'interrupted', busy.state === 'submitting' ? 'unknown' : 'attention'));
            notify(busy.region, 'Auto-buy needs attention', reasons[busy.state === 'submitting' ? 'unknown' : 'interrupted']);
        }
    }
    function pause(id, code = 'paused') {
        const row = ruleRow(id);
        if (!row)
            fail('Auto-buy rule not found.', 404);
        tx(() => {
            if (row.state !== 'purchased')
                changeRule(id, code === 'expired' ? 'expired' : 'paused', code);
            db.prepare("UPDATE auto_buy_attempts SET state='cancelled',reason=?,updated_at=? WHERE rule_id=? AND state IN ('queued','preparing')").run(reasons[code], stamp(), id);
        });
        return publicRule(ruleRow(id));
    }
    function pauseAll(code = 'paused') {
        for (const row of db.prepare("SELECT id FROM auto_buy_rules WHERE state IN ('armed','attention')").all())
            pause(row.id, code);
        return { ok: true, submitting: Boolean(active()) };
    }
    function profileFor(region) {
        const c = connection();
        if (!c || Date.now() - Date.parse(c.last_seen || '') > 30000)
            fail(reasons.connection, 409);
        const p = JSON.parse(c.profiles_json)[region];
        if (!p || p.state !== 'ready')
            fail(reasons.session, 409);
        return p;
    }
    function save(region, slug, body) {
        maintain();
        if (body.authorized !== true)
            fail('Explicit purchase authorization is required.');
        const product = getProduct(region, slug);
        if (!product?.variantId || !product.sku || product.unlisted)
            fail('Choose an exact, listed product variant for auto-buy.');
        const url = new URL(product.url);
        if (url.protocol !== 'https:' || url.origin !== regions[region].origin || url.username || url.password || url.hash)
            fail('Invalid Store product URL.');
        const previous = db.prepare('SELECT * FROM auto_buy_rules WHERE region=? AND slug=?').get(region, slug);
        if (!previous && db.prepare('SELECT COUNT(*) AS count FROM auto_buy_rules').get().count >= 1000)
            fail('At most 1000 purchase instructions are supported.');
        if ((previous?.revision || 0) !== body.revision)
            fail('This purchase instruction changed. Reopen it before saving.', 409);
        if (active())
            fail('Finish or resolve the current checkout before arming another instruction.', 409);
        const profile = profileFor(region);
        if (typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt)))
            fail('Choose a valid expiry.');
        const expiresAt = new Date(body.expiresAt).toISOString();
        if (Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) > Date.now() + 90 * 86400000)
            fail('Choose an expiry within the next 90 days.');
        const config = {
            sku: product.sku, variantId: product.variantId, name: product.name, url: product.url,
            quantity: positive(body.quantity, 'quantity', 20), currency: regions[region].currency,
            maxTotalMinor: positive(body.maxTotalMinor, 'maximum final total', 100000000), expiresAt,
            collectionId: body.collectionId ? text(body.collectionId, 'collection') : null,
            profileId: profile.id, addressLabel: profile.addressLabel, paymentLabel: profile.paymentLabel,
            mode: mock ? 'mock' : 'live',
        };
        if (!eligible(region, slug, config.collectionId, config.quantity))
            fail('Watch this exact variant and select a purchase plan with enough remaining quantity.');
        const id = previous?.id || crypto.randomUUID(), now = stamp();
        tx(() => {
            db.prepare("UPDATE auto_buy_attempts SET state='cancelled',reason=?,updated_at=? WHERE rule_id=? AND state='queued'").run(reasons.paused, now, id);
            db.prepare(`INSERT INTO auto_buy_rules VALUES(?,?,?,?,?,?,'armed',NULL,?,?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,authorization=excluded.authorization,config_json=excluded.config_json,state='armed',reason=NULL,updated_at=excluded.updated_at`)
                .run(id, region, slug, (previous?.revision || 0) + 1, crypto.randomUUID(), JSON.stringify(config), previous?.created_at || now, now);
        });
        return publicRule(ruleRow(id));
    }
    function observe(region, products) {
        maintain();
        for (const row of db.prepare("SELECT * FROM auto_buy_rules WHERE region=? AND state='armed'").all(region)) {
            const product = products[row.slug], config = JSON.parse(row.config_json);
            // Only called after a complete catalog. Pending evidence cannot authorize a purchase.
            if (!product?.inStock || product.unlisted || product.variantId !== config.variantId || product.sku !== config.sku)
                continue;
            db.prepare(`INSERT INTO auto_buy_attempts(id,rule_id,authorization,region,slug,config_json,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'queued',?,?) ON CONFLICT(authorization) DO NOTHING`)
                .run(crypto.randomUUID(), row.id, row.authorization, region, row.slug, row.config_json, stamp(), stamp());
        }
    }
    function authenticate(token) {
        const c = connection();
        if (!c || typeof token !== 'string' || token.length > 200 || hash(token) !== c.token_hash)
            fail('Checkout companion authentication failed.', 401);
        return c;
    }
    function heartbeat(c, body) {
        if (body.protocol !== 1 || body.mode !== c.mode)
            fail('Checkout companion protocol or mode does not match.', 409);
        const profiles = {};
        for (const [region, p] of Object.entries(body.profiles || {})) {
            if (!Object.hasOwn(regions, region) || !p || !['ready', 'attention'].includes(p.state))
                fail('Invalid checkout profile.');
            profiles[region] = { id: text(p.id, 'profile identifier', 100), state: p.state, addressLabel: text(p.addressLabel, 'address label', 80), paymentLabel: text(p.paymentLabel, 'payment label', 80) };
        }
        db.prepare('UPDATE auto_buy_connection SET profiles_json=?,last_seen=? WHERE id=1').run(JSON.stringify(profiles), stamp());
        if (body.attemptId)
            db.prepare("UPDATE auto_buy_attempts SET updated_at=? WHERE id=? AND generation=? AND state IN ('preparing','submitting')").run(stamp(), body.attemptId, c.generation);
        maintain();
        return { ok: true };
    }
    function claim(c) {
        maintain();
        return tx(() => {
            if (active())
                return { attempt: null };
            for (const row of db.prepare("SELECT * FROM auto_buy_attempts WHERE state='queued' ORDER BY created_at,id").all()) {
                const r = ruleRow(row.rule_id), config = JSON.parse(row.config_json);
                if (r?.state !== 'armed' || r.authorization !== row.authorization) {
                    attention(row, 'paused', 'cancelled');
                    continue;
                }
                let profile;
                try {
                    profile = profileFor(row.region);
                }
                catch {
                    continue;
                }
                if (profile.id !== config.profileId) {
                    attention(row, 'session');
                    continue;
                }
                // Stock is rechecked from a fresh complete catalog, and again in checkout.
                const product = getProduct(row.region, row.slug);
                if (!product?.inStock || product.unlisted || !product.autoBuyFresh)
                    continue;
                db.prepare("UPDATE auto_buy_attempts SET state='preparing',generation=?,updated_at=? WHERE id=?").run(c.generation, stamp(), row.id);
                return { attempt: { ...publicAttempt(attemptRow(row.id)), authorization: row.authorization } };
            }
            return { attempt: null };
        });
    }
    function owned(c, id) {
        const row = attemptRow(id);
        if (!row || row.generation !== c.generation)
            fail('Checkout attempt not found for this companion.', 404);
        return row;
    }
    function validateProof(row, proof) {
        const config = JSON.parse(row.config_json);
        if (!proof || proof.profileId !== config.profileId || proof.currency !== config.currency || proof.taxCalculated !== true || proof.shippingSelected !== true
            || proof.addressVerified !== true || proof.paymentVerified !== true || proof.hasCustomer !== true || proof.externalItemCount !== 0
            || !Number.isSafeInteger(proof.totalMinor) || proof.totalMinor <= 0 || proof.totalMinor > config.maxTotalMinor
            || !Array.isArray(proof.items) || proof.items.length !== 1 || proof.items[0].sku !== config.sku
            || proof.items[0].variantId !== config.variantId || proof.items[0].quantity !== config.quantity
            || typeof proof.observedAt !== 'string' || Math.abs(Date.now() - Date.parse(proof.observedAt)) > 10000 || !Number.isFinite(Date.parse(proof.observedAt)))
            fail(reasons.cart, 409);
        return { checkoutId: text(proof.checkoutId, 'checkout identifier'), totalMinor: proof.totalMinor, currency: proof.currency, profileId: proof.profileId, items: proof.items.map(i => ({ sku: i.sku, variantId: i.variantId, quantity: i.quantity })) };
    }
    function authorize(c, id, proof) {
        maintain();
        return tx(() => {
            const row = owned(c, id), r = ruleRow(row.rule_id), config = JSON.parse(row.config_json);
            if (row.state !== 'preparing' || r?.state !== 'armed' || r.authorization !== row.authorization || Date.parse(config.expiresAt) <= Date.now()
                || !eligible(row.region, row.slug, config.collectionId, config.quantity) || profileFor(row.region).id !== config.profileId)
                fail('Purchase authorization is no longer active.', 409);
            const product = getProduct(row.region, row.slug);
            if (!product?.autoBuyFresh || !product.inStock || product.sku !== config.sku || product.variantId !== config.variantId)
                fail('Waiting for a fresh confirmation of this exact variant.', 409);
            const validated = validateProof(row, proof);
            // Commit before allowing the browser to send CreateOrder. Repeated calls are rejected.
            db.prepare("UPDATE auto_buy_attempts SET state='submitting',proof_json=?,updated_at=? WHERE id=?").run(JSON.stringify(validated), stamp(), id);
            return { authorized: true, expiresAt: new Date(Date.now() + 2000).toISOString() };
        });
    }
    function complete(c, id, receipt) {
        const row = owned(c, id);
        if (row.state === 'purchased')
            return { ok: true, attempt: publicAttempt(row) };
        if (!['submitting', 'unknown'].includes(row.state))
            fail('This attempt was not authorized to submit.', 409);
        const proof = JSON.parse(row.proof_json || 'null');
        if (!proof || receipt?.paid !== true || receipt.checkoutId !== proof.checkoutId || receipt.currency !== proof.currency || receipt.totalMinor !== proof.totalMinor
            || JSON.stringify(receipt.items) !== JSON.stringify(proof.items))
            fail('The Store has not confirmed the authorized order and payment.', 409);
        const clean = { orderId: text(receipt.orderId, 'order identifier'), orderNumber: text(receipt.orderNumber, 'order number'), totalMinor: receipt.totalMinor, currency: receipt.currency, verified: true };
        tx(() => {
            recordPurchase(row, clean);
            notify(row.region, 'Auto-buy purchased your item', `Order ${clean.orderNumber} confirmed. Auto-buy stopped after one order.`);
        });
        return { ok: true, attempt: publicAttempt(attemptRow(id)) };
    }
    function recordPurchase(row, receipt) {
        db.prepare("UPDATE auto_buy_attempts SET state='purchased',receipt_json=?,reason=?,updated_at=? WHERE id=?").run(JSON.stringify(receipt), reasons.purchased, stamp(), row.id);
        changeRule(row.rule_id, 'purchased', 'purchased');
        purchased(row.region, row.slug, JSON.parse(row.config_json), receipt);
    }
    function report(c, id, body) {
        const row = owned(c, id);
        if (!['preparing', 'submitting'].includes(row.state))
            return { ok: true, state: row.state };
        const code = row.state === 'submitting' ? 'unknown' : ['session', 'cart', 'unavailable', 'interrupted'].includes(body.code) ? body.code : 'interrupted';
        tx(() => {
            attention(row, code, code === 'unknown' ? 'unknown' : 'attention');
            notify(row.region, 'Auto-buy needs attention', reasons[code]);
        });
        return { ok: true, state: attemptRow(id).state };
    }
    function resolve(id, body) {
        const row = attemptRow(id);
        if (!row || row.state !== 'unknown')
            fail('Only an uncertain submission needs owner reconciliation.', 409);
        if (body.checkedStoreOrders !== true)
            fail('Check Store orders and payment activity before resolving this attempt.');
        // A running companion could still be receiving the payment result. Revoke it first.
        if (connection())
            fail('Disconnect the companion and close its checkout browser before resolving an uncertain order.', 409);
        if (body.outcome === 'purchased') {
            const config = JSON.parse(row.config_json);
            const receipt = { orderNumber: text(body.orderNumber, 'order number'), totalMinor: positive(body.totalMinor, 'paid total', 100000000), currency: config.currency, verified: false };
            tx(() => recordPurchase(row, receipt));
        }
        else if (body.outcome === 'not-purchased') {
            tx(() => { attention(row, 'paused', 'cancelled'); });
        }
        else
            fail('Choose whether an order was placed.');
        return { ok: true };
    }
    function disconnect() {
        pauseAll();
        const row = active();
        if (row?.state === 'submitting')
            tx(() => attention(row, 'unknown', 'unknown'));
        db.prepare('DELETE FROM auto_buy_connection').run();
        pairing = null;
        return { ok: true };
    }
    function startPairing() {
        if (connection() || active())
            fail('Disconnect the existing companion and resolve any pending order first.', 409);
        const code = crypto.randomBytes(24).toString('base64url');
        pairing = { hash: hash(code), expires: Date.now() + 300000 };
        return { code, expiresAt: new Date(pairing.expires).toISOString(), mode: mock ? 'mock' : 'live' };
    }
    function pair(body) {
        if (!pairing || Date.now() > pairing.expires || typeof body.code !== 'string' || hash(body.code) !== pairing.hash)
            fail('Pairing code is invalid or expired.', 401);
        if (body.mode !== (mock ? 'mock' : 'live') || body.protocol !== 1)
            fail('Companion mode or version does not match GearBeacon.', 409);
        const token = crypto.randomBytes(48).toString('base64url');
        db.prepare("INSERT INTO auto_buy_connection(id,token_hash,generation,mode,profiles_json,last_seen) VALUES(1,?,?,?,'{}',?)").run(hash(token), crypto.randomUUID(), body.mode, stamp());
        pairing = null;
        return { token, mode: body.mode };
    }
    function status() {
        maintain();
        const c = connection();
        return { mode: mock ? 'mock' : 'live', connection: c ? { connected: Date.now() - Date.parse(c.last_seen || '') < 30000, profiles: JSON.parse(c.profiles_json), lastSeen: c.last_seen } : null,
            rules: db.prepare('SELECT * FROM auto_buy_rules ORDER BY updated_at DESC').all().map(publicRule),
            attempts: db.prepare("SELECT * FROM auto_buy_attempts ORDER BY (state IN ('unknown','submitting','preparing')) DESC,created_at DESC LIMIT 100").all().map(publicAttempt),
            blocked: Boolean(active()), protocol: 1 };
    }
    function restore() { disconnect(); pauseAll('restored'); }
    function exportData() {
        return {
            rules: db.prepare('SELECT * FROM auto_buy_rules').all().map(row => ({ ...publicRule(row), state: row.state === 'purchased' ? 'purchased' : 'paused' })),
            attempts: db.prepare('SELECT * FROM auto_buy_attempts ORDER BY created_at LIMIT 100000').all().map(row => ({ ...publicAttempt(row), state: row.state === 'submitting' ? 'unknown' : ['queued', 'preparing'].includes(row.state) ? 'cancelled' : row.state })),
        };
    }
    function validateImport(data) {
        if (data === undefined)
            return;
        if (!data || !Array.isArray(data.rules) || !Array.isArray(data.attempts) || data.rules.length > 1000 || data.attempts.length > 100000)
            fail('Invalid auto-buy backup.');
        for (const row of [...data.rules, ...data.attempts]) {
            if (!row || !Object.hasOwn(regions, row.region) || !/^[a-f0-9-]{36}$/.test(row.id) || !['armed', 'paused', 'attention', 'purchased', 'expired', 'queued', 'preparing', 'submitting', 'unknown', 'cancelled'].includes(row.state))
                fail('Invalid auto-buy backup record.');
            for (const key of ['slug', 'sku', 'variantId', 'name', 'url', 'profileId', 'addressLabel', 'paymentLabel'])
                text(row[key], `backup ${key}`, 2048);
            if (!Number.isFinite(Date.parse(row.expiresAt)) || !Number.isFinite(Date.parse(row.updatedAt)) || row.currency !== regions[row.region].currency || !['mock', 'live'].includes(row.mode))
                fail('Invalid auto-buy backup values.');
            positive(row.quantity, 'backup quantity', 20);
            positive(row.maxTotalMinor, 'backup limit', 100000000);
            if (row.collectionId !== null)
                text(row.collectionId, 'backup collection');
            if (row.ruleId !== undefined && !/^[a-f0-9-]{36}$/.test(row.ruleId))
                fail('Invalid backup purchase rule identifier.');
            if (row.receipt) {
                text(row.receipt.orderNumber, 'backup order number');
                positive(row.receipt.totalMinor, 'backup order total', 100000000);
            }
        }
    }
    function importData(data) {
        validateImport(data);
        restore();
        if (!data)
            return;
        const configOf = row => Object.fromEntries(['sku', 'variantId', 'name', 'url', 'quantity', 'currency', 'maxTotalMinor', 'expiresAt', 'collectionId', 'profileId', 'addressLabel', 'paymentLabel', 'mode'].map(key => [key, row[key]]));
        tx(() => {
            for (const row of data.rules) {
                if (!getProduct(row.region, row.slug))
                    continue;
                // An existing live audit record always wins over an older exported copy.
                db.prepare(`INSERT OR IGNORE INTO auto_buy_rules VALUES(?,?,?,?,?,?,?,?,?,?)`)
                    .run(row.id, row.region, row.slug, 1, crypto.randomUUID(), JSON.stringify(configOf(row)), row.state === 'purchased' ? 'purchased' : 'paused', reasons.restored, stamp(), stamp());
            }
            for (const row of data.attempts) {
                const receipt = row.receipt ? { orderNumber: row.receipt.orderNumber, totalMinor: row.receipt.totalMinor, currency: row.currency, verified: false } : null;
                db.prepare(`INSERT OR IGNORE INTO auto_buy_attempts(id,rule_id,authorization,region,slug,config_json,state,receipt_json,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
                    .run(row.id, row.ruleId, crypto.randomUUID(), row.region, row.slug, JSON.stringify(configOf(row)), ['unknown', 'submitting'].includes(row.state) ? 'unknown' : row.state === 'purchased' ? 'purchased' : 'cancelled', receipt ? JSON.stringify(receipt) : null, reasons.restored, Number.isFinite(Date.parse(row.createdAt)) ? row.createdAt : stamp(), stamp());
            }
        });
    }
    // Startup never repeats a browser action whose outcome has not been established.
    for (const row of db.prepare("SELECT * FROM auto_buy_attempts WHERE state IN ('preparing','submitting')").all()) {
        attention(row, row.state === 'submitting' ? 'unknown' : 'interrupted', row.state === 'submitting' ? 'unknown' : 'attention');
    }
    return { status, save, pause, pauseAll, observe, authenticate, heartbeat, claim, authorize, complete, report, resolve, disconnect, startPairing, pair, restore, exportData, validateImport, importData,
        rule: (region, slug) => publicRule(db.prepare('SELECT * FROM auto_buy_rules WHERE region=? AND slug=?').get(region, slug)),
        attempt: (c, id) => publicAttempt(owned(c, id)),
    };
}
// Backups preserve audit history, but never a live purchase authorization or worker token.
function neutralizeAutoBuyBackup(db) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auto_buy_rules'").get())
        return;
    db.exec(`BEGIN IMMEDIATE;
    DELETE FROM auto_buy_connection;
    UPDATE auto_buy_rules SET state='paused',reason='Restored purchase instructions need fresh authorization.' WHERE state<>'purchased';
    UPDATE auto_buy_attempts SET state='cancelled',reason='Restored purchase instructions need fresh authorization.' WHERE state IN ('queued','preparing');
    UPDATE auto_buy_attempts SET state='unknown',reason='Check Store orders before allowing another purchase.' WHERE state='submitting';
    COMMIT;`);
}
module.exports = { createAutoBuy, AUTO_BUY_SCHEMA, neutralizeAutoBuyBackup };
