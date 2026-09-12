# Activity

Activity keeps every event as its own compact card. Parent products and exact variants remain separate, even when they change during the same check. Date separators help you scan the timeline without combining or collapsing cards.

## Reading a card

- **Original change:** the existing transition, price change, and time describe what GearBeacon detected. Restocks use green, sellouts use red, price increases use amber, and price decreases use blue.
- **Current availability:** a separate line shows the latest known state, such as Still in stock or Sold out since. Confirming change, Checks delayed, and Status unconfirmed distinguish pending or incomplete evidence. A pending change retains the last confirmed value.
- **Watch context:** Watching means the exact item is currently watched. Parent watched means its parent is watched separately. Current collection names and exact variant information appear when available. Open the card to see full collection names, SKU, and whether the item was watched when the event occurred.
- **Price context:** the event price is compared with your current target for that exact item. Editing a target updates the comparison while preserving the event's original target and price. Parent products with multiple variants do not receive a potentially misleading comparison.
- **Delivery:** badges explain outcomes such as Not watched, Alerts paused, Rule filtered, Target not met, Cooldown, or Sent · Webhook. Multiple successful channels show a count; full delivery details remain available inside the card. Recorded decisions describe the rules at detection, independently of current watch settings.

Long context fits horizontally and may be shortened on small screens. Open a card for full readable details; its accessible description also contains the complete context.

## Observed price lows

Lowest observed in 30 days compares the event price with recorded prices for the same regional Store, currency, and exact item during the 30 days ending at that event. Later prices and other variants do not affect that comparison.

The indicator requires retained price history reaching the start of that window and observations within it. New installations and items with shorter history show Not enough recorded price history in details. This describes GearBeacon's observations; monitoring gaps may exist.

## Dates, totals, and live updates

Today, Yesterday, older date headings, and calendar-date filters use the configured notification timezone, shown in the summary. Day boundaries follow that timezone's daylight-saving rules. Direct API requests default to UTC unless they supply a valid IANA `timeZone`; explicit ISO timestamps retain their exact meaning.

The summary counts all retained events matching the selected Store, event type, search, date range, and delivery filter across every page. It updates with arrivals while an older page remains in place. Counts include restocks, sellouts, price increases and decreases, other price/status changes, new products, and collection readiness as applicable.

While Activity is visible, automatic checks continue every second. Arrivals appear immediately after a successful refresh, and existing cards update their current context. Scrolling preserves the card you are reading and keyboard focus; open event details update their current context without replacing focused actions. Monitoring and server notification delivery continue with the browser closed.
