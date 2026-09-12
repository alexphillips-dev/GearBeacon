# Delivery channels, delayed alerts, and product freshness

These features are available in the current development checkout. Monitoring and external delivery continue on the GearBeacon server when the browser is closed.

## Choose channels for a watch

Open a watched product and find **Server delivery** under its alert rules. **Use defaults** sends qualifying alerts through every enabled, configured server channel. **Choose channels** lets you select ntfy, Discord, Gotify, Webhook, or Email. Save with **Save alert rules**; **Preview rule & notification** shows which selected channels are currently usable.

A selected channel must also be configured and enabled in Settings > Notifications. Selecting no channels deliberately disables external delivery for that watch. Browser popups are controlled separately by browser permissions and event preferences.

## Choose channels for a collection

Open the collection's **Alerts** view. Readiness, budget, and individual-item switches save automatically. Channel and expiry edits use their own **Save delivery options** button. Unsaved delivery edits remain available while background refreshes and the readiness switches update.

Collection delivery choices apply to collection-ready events. Member watches retain their own routes. Existing **Collection alerts only** behavior still suppresses individual member alerts, including All activity and immediate restocks. Routes do not bypass pauses, purchased state, archived collections, or the existing collection override rules.

Removing a channel cancels its pending and failed deliveries. Adding a channel affects future events; it does not resend earlier events. A send already in progress cannot be recalled.

## Optional alert expiry

Set **Expire time-sensitive alerts after (minutes)** to a whole number from 1 to 10,080, or leave it blank for no expiry. The default is no expiry.

Expiry applies to restocks, target-price and price-drop opportunities, and collection readiness. It is measured from the original detection time and includes time spent in quiet hours, digests, and retries. It does not expire ordinary sellout/status/new-product history or operational and test messages.

Before sending, GearBeacon applies the shorter of the queued alert's original expiry limit and its current limit. Increasing or clearing the limit does not extend a queued alert's existing deadline. A shorter limit also cancels already-expired pending or failed jobs when saved. Expired delivery is labeled **Expired** in Activity and retained as a cancelled job in Operations; **Retry failed** cannot revive it. The original stock event remains in Activity.

## Context on delayed messages

Messages at least one minute old include a **Delayed alert** label, their original detection time, and separately labeled current status. When recent complete evidence exists, that status is confirmed. Pending transitions, partial catalogs, outages, overdue checks, and startup gaps are described as unconfirmed or last known.

For an Any variant target alert triggered by a particular SKU, the current context refers to that triggering variant. A different in-stock sibling does not make the original SKU appear available. A collection-ready message includes its current readiness when that can be confirmed.

This context appears in supported server channels, including compact email and digests. Grouped text may show fewer items to keep messages bounded; webhooks retain their complete event payload. The original event snapshot and Activity evidence are unchanged. Delivery details in Operations record the context used for that attempt; support bundles redact that product context.

## Read freshness indicators

Watchlist, Browse, and product details distinguish:

- **Confirmed … ago:** a recent complete check supports the displayed value.
- **Change awaiting confirmation:** a stock, price, status, or listing change is pending. The last-known-good value stays visible.
- **Last known … · checks delayed:** monitoring evidence is stale or the browser cannot verify a current state.
- **Awaiting a complete check:** no usable current confirmation is available, such as after importing early history.

The freshness indicator's accessible title provides the absolute observation time when available. Its relative text updates without rebuilding the product card or discarding edits. Monitoring gaps never establish new confirmation evidence, and no freshness indicator promises checkout availability or stock quantity.

## Recovery and API compatibility

This change advances the database to schema **13** and recovery exports to format **9**. GearBeacon validates a safety backup before migration. Previous exports remain importable; missing delivery options default to all enabled/configured channels and no expiry. Restore a compatible pre-upgrade database and its matching key before downgrading.

Watch rule endpoints and collection updates accept:

```json
{
  "channels": ["ntfy", "email"],
  "maxAlertAgeMinutes": 30
}
```

Use `channels: null` for defaults, `channels: []` for no external delivery, and `maxAlertAgeMinutes: null` for no expiry. Watch updates wrap these fields in the existing `rule` object; collection updates use top-level fields. Unknown channels and invalid expiry values are rejected. Product details and collection responses expose `capabilities.alertDelivery` so newer browser controls can refuse an older server that cannot save these options.

Product responses include `freshness` with `state`, `checkedAt`, `expiresAt`, and `pendingKinds`. Delayed webhook events add `deliveryContext` alongside the immutable detection fields. No extra Store checks, credentials, or notification integrations are required.
