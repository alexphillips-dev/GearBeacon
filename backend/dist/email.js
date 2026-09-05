// GearBeacon email rendering and SMTP MIME composition.
// Kept dependency-free so the same implementation works in source, Docker, and standalone builds.
// @ts-nocheck
const fs = require('node:fs');
const crypto = require('node:crypto');
const INLINE_IMAGE_HOSTS = new Set(['images.svc.ui.com', 'cdn.ecomm.ui.com', 'assets.ecomm.ui.com']);
const INLINE_IMAGE_TYPES = new Map([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
]);
const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;
const MAX_INLINE_TOTAL_BYTES = 3 * 1024 * 1024;
function htmlEscape(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
}
function cleanHeader(value, fallback = '') {
    const text = String(value ?? '').trim();
    if (/[\r\n]/.test(text))
        throw new Error('Email headers must not contain line breaks.');
    return (text || fallback).slice(0, 200);
}
function safeEmailUrl(value) {
    if (!value)
        return null;
    try {
        const url = new URL(String(value));
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
            return null;
        return url.toString();
    }
    catch {
        return null;
    }
}
function numericPrice(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    const compact = String(value || '').replace(/[^0-9,.-]/g, '');
    const negative = compact.startsWith('-');
    const unsigned = compact.replace(/-/g, '');
    if (!/[0-9]/.test(unsigned))
        return null;
    const lastComma = unsigned.lastIndexOf(',');
    const lastDot = unsigned.lastIndexOf('.');
    let decimal = '';
    if (lastComma >= 0 && lastDot >= 0)
        decimal = lastComma > lastDot ? ',' : '.';
    else {
        const separator = lastComma >= 0 ? ',' : lastDot >= 0 ? '.' : '';
        if (separator) {
            const fractionLength = unsigned.length - unsigned.lastIndexOf(separator) - 1;
            if (fractionLength === 1 || fractionLength === 2)
                decimal = separator;
        }
    }
    const decimalAt = decimal ? unsigned.lastIndexOf(decimal) : -1;
    const whole = (decimalAt >= 0 ? unsigned.slice(0, decimalAt) : unsigned).replace(/[.,]/g, '') || '0';
    const fraction = decimalAt >= 0 ? unsigned.slice(decimalAt + 1).replace(/[.,]/g, '') : '';
    const parsed = Number.parseFloat(`${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`);
    return Number.isFinite(parsed) ? parsed : null;
}
function priceChange(event) {
    const current = event.priceValue ?? numericPrice(event.price);
    const previous = event.previousPriceValue ?? numericPrice(event.previousPrice);
    const difference = event.priceDifference ?? (current !== null && previous !== null ? Math.round((current - previous) * 100) / 100 : null);
    const percent = event.priceDifferencePercent ?? (difference !== null && previous ? Math.round((difference / previous) * 1000) / 10 : null);
    return { current, previous, difference, percent };
}
function emailKind(event) {
    if (event.alertKind)
        return event.alertKind;
    if (event.type === 'price_change') {
        const prices = priceChange(event);
        if (event.targetPrice !== null && event.targetPrice !== undefined && prices.current !== null && prices.current <= Number(event.targetPrice))
            return 'target_price';
        if (prices.difference !== null && prices.difference < 0)
            return 'price_drop';
    }
    return event.type || 'restock';
}
const KIND_DETAILS = {
    restock: { label: 'Back in stock', eyebrow: 'RESTOCK ALERT', color: '#36d17c', subject: (event) => `${event.name || 'A watched product'} is back in stock` },
    target_price: { label: 'Target price reached', eyebrow: 'PRICE TARGET', color: '#4d9fff', subject: (event) => `${event.name || 'A watched product'} reached your target price` },
    price_drop: { label: 'Price dropped', eyebrow: 'PRICE DROP', color: '#f2b84b', subject: (event) => `${event.name || 'A watched product'} dropped in price` },
    price_change: { label: 'Price changed', eyebrow: 'PRICE CHANGE', color: '#f2b84b', subject: (event) => `${event.name || 'A watched product'} changed price` },
    sold_out: { label: 'Sold out', eyebrow: 'AVAILABILITY ALERT', color: '#ff667d', subject: (event) => `${event.name || 'A watched product'} sold out` },
    status_change: { label: 'Status changed', eyebrow: 'STATUS ALERT', color: '#af8cff', subject: (event) => `${event.name || 'A watched product'} changed status` },
    new_product: { label: 'New product discovered', eyebrow: 'NEW PRODUCT', color: '#42d4c8', subject: (event) => `New UniFi product: ${event.name || 'Product discovered'}` },
    operational: { label: 'GearBeacon needs attention', eyebrow: 'OPERATIONAL ALERT', color: '#ff667d', subject: (event) => `GearBeacon needs attention: ${event.name || 'Operational issue'}` },
    test: { label: 'Email is working', eyebrow: 'TEST EMAIL', color: '#36d17c', subject: () => 'GearBeacon test email' },
    digest: { label: 'Your GearBeacon digest', eyebrow: 'GEARBEACON DIGEST', color: '#4d9fff', subject: (event) => `${event.events?.length || 0} GearBeacon product updates` },
};
function kindDetails(event) {
    return KIND_DETAILS[emailKind(event)] || KIND_DETAILS.status_change;
}
function formatDetectedAt(event, configuredTimeZone) {
    const timeZone = event.notificationTimeZone || configuredTimeZone || 'UTC';
    const parsed = new Date(event.detectedAt || Date.now());
    try {
        return `${new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(parsed)} (${timeZone})`;
    }
    catch {
        return parsed.toISOString();
    }
}
function regionLabel(event, regions) {
    const key = event.region || 'us';
    return regions?.[key]?.label || String(key).toUpperCase();
}
function reasonText(event) {
    if (event.triggerReason)
        return String(event.triggerReason);
    const kind = emailKind(event);
    if (kind === 'target_price')
        return `The price met your configured target${event.targetPrice != null ? ` of ${event.targetPrice}` : ''}.`;
    if (kind === 'price_drop')
        return 'The price decreased on a product you monitor.';
    if (kind === 'restock')
        return event.watchedAtDetection ? 'A product you monitor became available.' : 'GearBeacon detected that this product became available.';
    if (kind === 'sold_out')
        return 'A product you monitor became unavailable.';
    if (kind === 'new_product')
        return 'New-product alerts are enabled for this store region.';
    if (kind === 'operational')
        return 'Operational alerts are enabled for this GearBeacon installation.';
    if (kind === 'test')
        return 'You requested a test from GearBeacon notification settings.';
    return 'A monitored product changed on the UniFi Store.';
}
function moneyDelta(event) {
    const values = priceChange(event);
    if (values.difference === null)
        return null;
    const currencySymbol = String(event.price || event.previousPrice || '').match(/[^\d\s.,-]+/)?.[0] || '$';
    const absolute = `${currencySymbol}${Math.abs(values.difference).toFixed(2)}`;
    if (values.difference < 0)
        return `Save ${absolute}${values.percent !== null ? ` (${Math.abs(values.percent)}%)` : ''}`;
    if (values.difference > 0)
        return `Up ${absolute}${values.percent !== null ? ` (${Math.abs(values.percent)}%)` : ''}`;
    return 'No price difference';
}
function button(url, label, accent, secondary = false) {
    const safe = safeEmailUrl(url);
    if (!safe)
        return '';
    const background = secondary ? 'transparent' : accent;
    const color = secondary ? '#f4f7fa' : '#07110c';
    const border = secondary ? '#48505a' : accent;
    return `<a href="${htmlEscape(safe)}" style="display:inline-block;margin:0 8px 8px 0;padding:12px 17px;border:1px solid ${border};border-radius:8px;background:${background};color:${color};font:700 13px Arial,sans-serif;text-decoration:none">${htmlEscape(label)}</a>`;
}
function imageSource(event, options) {
    const source = validInlineImageUrl(event.imageUrl);
    if (!source)
        return null;
    if (options.imageSources?.[source])
        return options.imageSources[source];
    return options.allowRemoteImages ? source : null;
}
function productImage(event, options, size = 184) {
    const source = imageSource(event, options);
    if (source)
        return `<img src="${htmlEscape(source)}" width="${size}" alt="${htmlEscape(event.name || 'Product')}" style="display:block;width:100%;max-width:${size}px;height:auto;margin:0 auto;border:0;object-fit:contain">`;
    return `<div role="img" aria-label="Product image unavailable" style="width:${size}px;max-width:100%;height:${Math.round(size * .72)}px;margin:0 auto;border:1px solid #343a41;border-radius:12px;background:#202428;color:#8e98a4;font:700 11px Arial,sans-serif;line-height:${Math.round(size * .72)}px;text-align:center">IMAGE UNAVAILABLE</div>`;
}
function productPriceMarkup(event, options) {
    const delta = moneyDelta(event);
    const previous = event.previousPrice;
    return `<div style="margin:18px 0 4px;color:#ffffff;font:700 28px Arial,sans-serif">${htmlEscape(event.price || 'Price unavailable')}</div>${previous ? `<div style="color:#939daa;font:400 12px Arial,sans-serif">Previously <span style="text-decoration:line-through">${htmlEscape(previous)}</span>${options.priceCalculations && delta ? ` · <strong style="color:#d9e0e7">${htmlEscape(delta)}</strong>` : ''}</div>` : ''}`;
}
function detailRows(event, options) {
    if (options.detailLevel === 'compact')
        return '';
    const rows = [
        ['SKU', event.slug || 'Unavailable'],
        ['Category', event.category || 'Unavailable'],
        ['Store', regionLabel(event, options.regions)],
        ['Detected', formatDetectedAt(event, options.timeZone)],
    ];
    if (event.targetPrice !== null && event.targetPrice !== undefined)
        rows.push(['Target price', String(event.targetPrice)]);
    if (event.previousStatus)
        rows.push(['Previous status', event.previousStatus]);
    if (options.detailLevel === 'detailed') {
        rows.push(['Current status', event.status || 'Unknown']);
        rows.push(['Delivery preference', event.immediateRestock ? 'Immediate restock' : 'Scheduled delivery']);
    }
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:18px 0;border-collapse:collapse">${rows.map(([label, value]) => `<tr><td style="padding:8px 0;border-top:1px solid #30363c;color:#8e98a4;font:400 11px Arial,sans-serif">${htmlEscape(label)}</td><td style="padding:8px 0;border-top:1px solid #30363c;color:#e8edf2;font:600 11px Arial,sans-serif;text-align:right">${htmlEscape(value)}</td></tr>`).join('')}</table>`;
}
function shell(content, event, options) {
    const details = kindDetails(event);
    const theme = ['light', 'dark'].includes(options.theme) ? options.theme : 'auto';
    const lightCss = theme === 'light' ? 'body,.email-bg{background:#f2f4f6!important}.email-card{background:#ffffff!important;border-color:#d8dde3!important}.email-copy{color:#303943!important}.email-title{color:#0b1015!important}' : '';
    const autoCss = theme === 'auto' ? '@media(prefers-color-scheme:light){body,.email-bg{background:#f2f4f6!important}.email-card{background:#ffffff!important;border-color:#d8dde3!important}.email-copy{color:#303943!important}.email-title{color:#0b1015!important}}' : '';
    const logo = options.logoSource ? `<img src="${htmlEscape(options.logoSource)}" width="38" height="38" alt="" style="display:block;border:0;border-radius:10px">` : '<div style="width:38px;height:38px;border:1px solid #3b424a;border-radius:10px;color:#fff;font:700 12px Arial,sans-serif;line-height:38px;text-align:center">GB</div>';
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${htmlEscape(details.subject(event))}</title><style>html,body{margin:0!important;padding:0!important;width:100%!important}${lightCss}${autoCss}@media(max-width:620px){.email-wrap{width:100%!important}.email-pad{padding:22px 16px!important}.product-columns,.product-columns tbody,.product-columns tr,.product-columns td{display:block!important;width:100%!important}.product-visual{padding:0 0 18px!important}}</style></head><body style="margin:0;padding:0;background:#0d1012"><table class="email-bg" role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#0d1012"><tr><td align="center" style="padding:26px 10px"><table class="email-wrap" role="presentation" width="620" cellspacing="0" cellpadding="0" style="width:620px;max-width:100%;border-collapse:separate"><tr><td style="padding:0 4px 16px"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="padding-right:11px">${logo}</td><td><div class="email-title" style="color:#ffffff;font:700 18px Arial,sans-serif">GearBeacon</div><div class="email-copy" style="margin-top:3px;color:#aab3bd;font:400 11px Arial,sans-serif">Know the second it&apos;s back.</div></td></tr></table></td></tr><tr><td class="email-card" style="overflow:hidden;border:1px solid #30363c;border-radius:15px;background:#171b1e"><div style="height:4px;background:${details.color}"></div>${content}</td></tr><tr><td class="email-copy" style="padding:16px 7px 0;color:#77818c;font:400 10px/1.55 Arial,sans-serif;text-align:center">Sent by your private GearBeacon installation. No tracking pixels, remote scripts, or analytics are included.</td></tr></table></td></tr></table></body></html>`;
}
function singleEmail(event, options) {
    const details = kindDetails(event);
    const kind = emailKind(event);
    const statusLine = kind === 'status_change' ? `${event.previousStatus || 'Unknown'} → ${event.status || 'Unknown'}`
        : kind === 'test' ? 'Your SMTP settings are ready.'
            : kind === 'operational' ? (event.detail || 'Open GearBeacon Operations for more information.')
                : details.label;
    const isProduct = !['test', 'operational'].includes(kind);
    const actions = `${button(event.url, 'Open UniFi Store', details.color)}${button(event.dashboardUrl, 'Open in GearBeacon', details.color, true)}`;
    const explanation = options.explainReason ? `<div style="margin-top:20px;padding:13px 14px;border:1px solid #30363c;border-radius:10px;background:#111416"><div style="margin-bottom:4px;color:#8e98a4;font:700 9px Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase">Why you received this</div><div class="email-copy" style="color:#c7cfd7;font:400 12px/1.55 Arial,sans-serif">${htmlEscape(reasonText(event))}</div></div>` : '';
    const product = isProduct ? `<table class="product-columns" role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td class="product-visual" width="205" valign="top" style="width:205px;padding:0 24px 0 0">${productImage(event, options)}</td><td valign="top"><h1 class="email-title" style="margin:0;color:#fff;font:700 26px/1.15 Arial,sans-serif;letter-spacing:-.5px">${htmlEscape(event.name || 'Product update')}</h1><div class="email-copy" style="margin-top:8px;color:#b5bec8;font:500 13px/1.5 Arial,sans-serif">${htmlEscape(statusLine)}</div>${productPriceMarkup(event, options)}${detailRows(event, options)}</td></tr></table>` : `<h1 class="email-title" style="margin:0;color:#fff;font:700 27px/1.2 Arial,sans-serif">${htmlEscape(details.label)}</h1><p class="email-copy" style="margin:12px 0 0;color:#c7cfd7;font:400 14px/1.65 Arial,sans-serif">${htmlEscape(statusLine)}</p>${options.detailLevel === 'detailed' ? `<p class="email-copy" style="color:#8e98a4;font:400 11px Arial,sans-serif">${htmlEscape(formatDetectedAt(event, options.timeZone))}</p>` : ''}`;
    return shell(`<div class="email-pad" style="padding:30px"><div style="margin-bottom:17px;color:${details.color};font:700 10px Arial,sans-serif;letter-spacing:.13em">${htmlEscape(details.eyebrow)}</div>${product}<div style="margin-top:23px">${actions}</div>${explanation}</div>`, event, options);
}
function digestEmail(event, options) {
    const original = Array.isArray(event.events) ? event.events : [];
    const seen = new Set();
    const unique = [];
    for (const item of original) {
        const key = item.slug || `${item.name}:${emailKind(item)}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        unique.push(item);
    }
    const shown = unique.slice(0, options.digestMaxItems);
    const order = ['restock', 'target_price', 'price_drop', 'price_change', 'new_product', 'sold_out', 'status_change'];
    const groups = new Map();
    for (const item of shown) {
        const kind = emailKind(item);
        if (!groups.has(kind))
            groups.set(kind, []);
        groups.get(kind).push(item);
    }
    const sections = [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([kind, items]) => {
        const details = KIND_DETAILS[kind] || KIND_DETAILS.status_change;
        const cards = items.map((item) => {
            const store = safeEmailUrl(item.url);
            const dashboard = safeEmailUrl(item.dashboardUrl);
            const destination = store || dashboard;
            const image = productImage(item, options, 82);
            const price = item.price ? `<div style="margin-top:6px;color:#fff;font:700 13px Arial,sans-serif">${htmlEscape(item.price)}${options.priceCalculations && moneyDelta(item) ? ` <span style="color:${details.color};font-size:10px">${htmlEscape(moneyDelta(item))}</span>` : ''}</div>` : '';
            return `<tr><td style="padding:12px 0;border-top:1px solid #30363c"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td width="96" valign="middle" style="width:96px">${image}</td><td valign="middle"><div class="email-title" style="color:#f5f7fa;font:700 14px Arial,sans-serif">${htmlEscape(item.name || 'Product update')}</div><div class="email-copy" style="margin-top:4px;color:#8e98a4;font:400 10px Arial,sans-serif">${htmlEscape(item.category || item.slug || regionLabel(item, options.regions))}</div>${price}</td>${destination ? `<td width="82" align="right" valign="middle"><a href="${htmlEscape(destination)}" style="color:${details.color};font:700 11px Arial,sans-serif;text-decoration:none">View →</a></td>` : ''}</tr></table></td></tr>`;
        }).join('');
        return `<div style="margin-top:24px"><div style="padding-bottom:8px;color:${details.color};font:700 10px Arial,sans-serif;letter-spacing:.11em">${htmlEscape(details.eyebrow)} · ${items.length}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${cards}</table></div>`;
    }).join('');
    const remaining = Math.max(0, unique.length - shown.length);
    const content = `<div class="email-pad" style="padding:30px"><div style="color:#4d9fff;font:700 10px Arial,sans-serif;letter-spacing:.13em">GEARBEACON DIGEST</div><h1 class="email-title" style="margin:10px 0 0;color:#fff;font:700 27px/1.2 Arial,sans-serif">${unique.length} product update${unique.length === 1 ? '' : 's'}</h1><p class="email-copy" style="margin:10px 0 0;color:#aab3bd;font:400 13px/1.55 Arial,sans-serif">Grouped by what changed in ${htmlEscape(regionLabel(event, options.regions))}.</p>${sections || '<p class="email-copy" style="color:#aab3bd;font:400 13px Arial,sans-serif">There are no product updates in this digest.</p>'}${remaining ? `<div class="email-copy" style="margin-top:20px;color:#aab3bd;font:600 12px Arial,sans-serif">And ${remaining} more update${remaining === 1 ? '' : 's'} not shown.</div>` : ''}<div style="margin-top:24px">${button(event.dashboardUrl || event.url, 'Open GearBeacon', '#4d9fff')}</div></div>`;
    return shell(content, event, options);
}
function textForEvent(event, options) {
    if (emailKind(event) === 'digest') {
        const seen = new Set();
        const lines = [];
        for (const item of event.events || []) {
            const key = item.slug || `${item.name}:${emailKind(item)}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            if (lines.length >= options.digestMaxItems)
                continue;
            lines.push(`- ${kindDetails(item).label}: ${item.name || 'Product'}${item.price ? ` — ${item.price}` : ''}${item.previousPrice ? ` (was ${item.previousPrice})` : ''}${item.url ? `\n  ${item.url}` : ''}`);
        }
        const remaining = Math.max(0, seen.size - lines.length);
        return [`GearBeacon digest`, `${seen.size} product update${seen.size === 1 ? '' : 's'} in ${regionLabel(event, options.regions)}`, '', ...lines, remaining ? `\nAnd ${remaining} more update${remaining === 1 ? '' : 's'} not shown.` : '', event.dashboardUrl || event.url ? `\nOpen GearBeacon: ${event.dashboardUrl || event.url}` : '', '', 'Sent by your private GearBeacon installation.'].filter(Boolean).join('\n');
    }
    const details = kindDetails(event);
    const lines = ['GearBeacon', details.label, '', event.name || details.label];
    if (event.previousStatus || event.status)
        lines.push(`${event.previousStatus || 'Status'} → ${event.status || 'Updated'}`);
    if (event.price)
        lines.push(`Price: ${event.price}${event.previousPrice ? ` (was ${event.previousPrice})` : ''}`);
    if (options.priceCalculations && moneyDelta(event))
        lines.push(moneyDelta(event));
    if (event.slug)
        lines.push(`SKU: ${event.slug}`);
    if (event.category)
        lines.push(`Category: ${event.category}`);
    lines.push(`Store: ${regionLabel(event, options.regions)}`);
    if (options.detailLevel !== 'compact')
        lines.push(`Detected: ${formatDetectedAt(event, options.timeZone)}`);
    if (event.detail)
        lines.push('', event.detail);
    if (options.explainReason)
        lines.push('', 'Why you received this:', reasonText(event));
    if (event.url)
        lines.push('', `Open UniFi Store: ${event.url}`);
    if (event.dashboardUrl)
        lines.push(`Open in GearBeacon: ${event.dashboardUrl}`);
    lines.push('', 'Sent by your private GearBeacon installation.');
    return lines.join('\n');
}
function renderEmail(event, inputOptions = {}) {
    const options = {
        detailLevel: ['compact', 'standard', 'detailed'].includes(inputOptions.detailLevel) ? inputOptions.detailLevel : 'standard',
        explainReason: inputOptions.explainReason !== false,
        priceCalculations: inputOptions.priceCalculations !== false,
        digestMaxItems: Math.max(1, Math.min(50, Number(inputOptions.digestMaxItems) || 12)),
        subjectPrefix: cleanHeader(inputOptions.subjectPrefix === undefined ? '[GearBeacon]' : inputOptions.subjectPrefix),
        theme: ['auto', 'light', 'dark'].includes(inputOptions.theme) ? inputOptions.theme : 'auto',
        timeZone: inputOptions.timeZone || 'UTC',
        regions: inputOptions.regions || {},
        imageSources: inputOptions.imageSources || {},
        allowRemoteImages: Boolean(inputOptions.allowRemoteImages),
        logoSource: inputOptions.logoSource || null,
    };
    const details = kindDetails(event);
    const subject = `${options.subjectPrefix ? `${options.subjectPrefix} ` : ''}${details.subject(event)}`.trim().slice(0, 240);
    return {
        subject,
        text: textForEvent(event, options).replace(/\r?\n/g, '\r\n'),
        html: emailKind(event) === 'digest' ? digestEmail(event, options) : singleEmail(event, options),
    };
}
function validInlineImageUrl(value) {
    try {
        const url = new URL(String(value));
        return url.protocol === 'https:' && !url.username && !url.password && INLINE_IMAGE_HOSTS.has(url.hostname.toLowerCase()) ? url.toString() : null;
    }
    catch {
        return null;
    }
}
async function fetchInlineImage(value, remainingBytes = MAX_INLINE_TOTAL_BYTES) {
    const url = validInlineImageUrl(value);
    if (!url || remainingBytes <= 0)
        return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
        const response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp' } });
        if (!response.ok || response.status >= 300)
            throw new Error(`HTTP ${response.status}`);
        const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!INLINE_IMAGE_TYPES.has(type))
            throw new Error(`unsupported content type ${type || 'unknown'}`);
        const contentLength = Number(response.headers.get('content-length') || 0);
        const limit = Math.min(MAX_INLINE_IMAGE_BYTES, remainingBytes);
        if (contentLength && contentLength > limit)
            throw new Error('image is too large');
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error('image response has no body');
        const chunks = [];
        let size = 0;
        while (true) {
            const { done, value: chunk } = await reader.read();
            if (done)
                break;
            size += chunk.length;
            if (size > limit) {
                try {
                    await reader.cancel();
                }
                catch { }
                throw new Error('image is too large');
            }
            chunks.push(Buffer.from(chunk));
        }
        return { url, contentType: type, extension: INLINE_IMAGE_TYPES.get(type), data: Buffer.concat(chunks), size };
    }
    finally {
        clearTimeout(timer);
    }
}
function base64Lines(value) {
    return Buffer.from(value).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
}
function mimeAttachment(attachment, boundary) {
    return [`--${boundary}`, `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`, 'Content-Transfer-Encoding: base64', `Content-ID: <${attachment.cid}>`, `Content-Disposition: inline; filename="${attachment.filename}"`, '', base64Lines(attachment.data)].join('\r\n');
}
async function buildMimeEmail(event, input) {
    const relatedBoundary = `gearbeacon-related-${crypto.randomBytes(12).toString('hex')}`;
    const alternativeBoundary = `gearbeacon-alternative-${crypto.randomBytes(12).toString('hex')}`;
    const imageSources = {};
    const attachments = [];
    const warnings = [];
    let totalBytes = 0;
    if (input.iconPath) {
        try {
            const data = fs.readFileSync(input.iconPath);
            if (data.length <= MAX_INLINE_IMAGE_BYTES) {
                attachments.push({ cid: 'gearbeacon-logo', filename: 'gearbeacon.png', contentType: 'image/png', data });
                totalBytes += data.length;
            }
        }
        catch (error) {
            warnings.push(`Logo was not embedded: ${error?.message || error}`);
        }
    }
    if (input.embedImages !== false) {
        const candidates = event.type === 'digest' ? (event.events || []) : [event];
        const urls = [...new Set(candidates.map((item) => validInlineImageUrl(item.imageUrl)).filter(Boolean))].slice(0, 4);
        for (const url of urls) {
            try {
                const image = await fetchInlineImage(url, MAX_INLINE_TOTAL_BYTES - totalBytes);
                if (!image)
                    continue;
                const cid = `product-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 20)}@gearbeacon`;
                attachments.push({ cid, filename: `product-${attachments.length}.${image.extension}`, contentType: image.contentType, data: image.data });
                imageSources[url] = `cid:${cid}`;
                totalBytes += image.size;
            }
            catch (error) {
                warnings.push(`Product image was not embedded: ${error?.message || error}`);
            }
        }
    }
    const rendered = renderEmail(event, {
        ...input,
        imageSources,
        allowRemoteImages: input.embedImages === false,
        logoSource: attachments.some((item) => item.cid === 'gearbeacon-logo') ? 'cid:gearbeacon-logo' : null,
    });
    const alternative = [
        `--${alternativeBoundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '', base64Lines(Buffer.from(rendered.text, 'utf8')),
        `--${alternativeBoundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '', base64Lines(Buffer.from(rendered.html, 'utf8')),
        `--${alternativeBoundary}--`,
    ].join('\r\n');
    const content = attachments.length ? [
        `Content-Type: multipart/related; boundary="${relatedBoundary}"`, '',
        `--${relatedBoundary}`,
        `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`, '',
        alternative,
        ...attachments.map((attachment) => mimeAttachment(attachment, relatedBoundary)),
        `--${relatedBoundary}--`,
    ].join('\r\n') : [`Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`, '', alternative].join('\r\n');
    const messageIdHost = String(input.messageIdHost || 'gearbeacon.local').replace(/[^a-zA-Z0-9.-]/g, '') || 'gearbeacon.local';
    const message = [
        `From: ${cleanHeader(input.from)}`,
        `To: ${cleanHeader(input.to)}`,
        `Subject: =?UTF-8?B?${Buffer.from(cleanHeader(rendered.subject), 'utf8').toString('base64')}?=`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${Date.now()}.${crypto.randomBytes(8).toString('hex')}@${messageIdHost}>`,
        'MIME-Version: 1.0',
        content,
    ].join('\r\n');
    if (Buffer.byteLength(message) > 9 * 1024 * 1024)
        throw new Error('Rendered email exceeds the 9 MB safety limit.');
    return { ...rendered, message, warnings, attachments: attachments.length };
}
module.exports = { renderEmail, buildMimeEmail, emailKind, htmlEscape, cleanHeader, validInlineImageUrl, numericPrice };
