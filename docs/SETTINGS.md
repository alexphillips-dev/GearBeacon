# Settings navigation

GearBeacon keeps six Settings categories with a second row of tabs for their sections. Only the selected section is shown.

| Settings category | Sections |
|---|---|
| General | Application; Stores & access; Auto-buy |
| Notifications | Alert types; Channels; Delivery; Email |
| Data | Schedule & retention; Backups & transfer |
| Security | Overview; Password; Sessions |
| Privacy | Catalog & updates; Notifications |
| Operations | Overview; Monitoring; Delivery; Purchases; Backups; Diagnostics; Logs |

Each category remembers its last section in this browser, including after a page reload. Switching between Settings categories or sections keeps unsaved form entries in place. Use the section's Save button to apply changes; reloading the page does not save drafts. Passwords and other form entries are never stored as navigation preferences.

Use Tab to reach either row of tabs, then Left/Right arrow keys to select a neighboring tab. Home and End select the first and last tab in that row. The section tabs wrap on narrow screens, and the category row scrolls horizontally when needed.

Operations links open the relevant configuration section directly. The installation health banner and legacy `#operations` links open Settings > Operations > Overview. Run diagnostics and download support bundles under Diagnostics; filter or download application logs under Logs.

For recovery settings, use Data > Schedule & retention. Create or test backups and import/export data under Data > Backups & transfer. Check for updates or prepare a safe update under General > Application.

Security > Password includes optional authenticator setup and one-time recovery codes. Security > Sessions includes the sign-in lifetime, idle lock, and approved private notification hostnames. Sensitive changes and data transfers ask for fresh owner verification when needed. See [Owner security and recovery](SECURITY_CONTROLS.md) for setup, Windows key protection, and recovery instructions.

Optional purchasing is configured in General > Auto-buy. Pair the checkout companion there, then complete Connect in its terminal until it confirms SAVED. The address nickname does not create an address in the Store. Settings distinguishes a paired companion with no reported profile from a saved region/address/card profile. From the GearBeacon folder, `npm --prefix checkout run profiles` inspects local setup; stop the worker and use `npm --prefix checkout run verify` to compare the saved choices with Store checkout without replacing them. Arm individual orders from Watchlist cards. Operations > Purchases keeps each attempt and its outcome separate from notification deliveries. See the [Auto-buy setup and verification guide](https://github.com/alexphillips-dev/GearBeacon/wiki/Auto-buy).
