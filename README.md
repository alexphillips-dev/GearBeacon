![GearBeacon — Track Ubiquiti gear and get notified when it is back in stock](.github/assets/banner.png)

[![Latest release](https://img.shields.io/github/v/release/alexphillips-dev/GearBeacon?label=release&color=0088ff)](https://github.com/alexphillips-dev/GearBeacon/releases/latest)
[![CI status on main](https://img.shields.io/github/actions/workflow/status/alexphillips-dev/GearBeacon/ci.yml?branch=main&label=CI%20%28main%29&logo=githubactions&logoColor=white)](https://github.com/alexphillips-dev/GearBeacon/actions/workflows/ci.yml?query=branch%3Amain)
[![Apache 2.0 license](https://img.shields.io/github/license/alexphillips-dev/GearBeacon?color=0088ff)](LICENSE)
[![Platforms: Windows, macOS, Linux](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-555555)](#choose-an-installation)
[![Docker: GHCR](https://img.shields.io/badge/Docker-GHCR-2496ed?logo=docker&logoColor=white)](https://github.com/alexphillips-dev/GearBeacon/wiki/Docker-and-NAS)
[![Documentation: Wiki](https://img.shields.io/badge/docs-Wiki-0088ff)](https://github.com/alexphillips-dev/GearBeacon/wiki)

# GearBeacon

**Know the second it's back.**

GearBeacon is a private, self-hosted Ubiquiti and UniFi Store inventory monitor for Windows, macOS, Linux, NAS, and Docker. Watch exact products, plan purchases, and receive stock or price alerts through a responsive browser dashboard.

One installation serves one owner. Monitoring and external notification delivery run on your server, even when the browser is closed. There is no GearBeacon cloud account, subscription, hosted database, analytics, or telemetry, and no Ubiquiti login is required.

**Current version: 1.2.0** · [Downloads](https://github.com/alexphillips-dev/GearBeacon/releases) · [Release notes](docs/RELEASE_NOTES.md) · [Wiki](https://github.com/alexphillips-dev/GearBeacon/wiki)

The current `dev` checkout also includes named views, a compact Watchlist, budget-aware collection alerts, alert explanations, smoother background refreshes, automatic Activity arrivals that preserve your reading position, update startup verification, per-watch/collection delivery channels, delayed-alert context and expiry, and product freshness indicators. It uses schema v13 and recovery export format v9, with a validated backup before migration. These additions are not included in the published v1.2.0 downloads; see the [changelog](docs/CHANGELOG.md) and [Wiki](https://github.com/alexphillips-dev/GearBeacon/wiki).

## What it does

- **Regional monitoring:** United States, Canada, Europe, and United Kingdom Stores, with separate watches, prices, activity, and health.
- **Precise watches:** Any variant or an exact SKU, color, length, or pack size; import Store links and TXT/CSV/JSON lists with a review before saving.
- **Purchase planning:** Collections with product previews, quantities, recorded spending, budgets, archive/undo, and optional grouping without duplicate item cards.
- **Flexible alerts:** Restocks, price drops, available-at-target conditions, and collection readiness; per-item rules, pauses, quiet hours, digests, and collection-only overrides. The current dev checkout adds [delivery routes, optional expiry, and freshness indicators](docs/ALERT_DELIVERY.md).
- **Multiple channels:** ntfy, Discord, Gotify, SMTP email, and signed webhooks, with durable delivery and bounded retries. Browser popups are also available while the page is running.
- **Useful evidence:** Observed stock timelines, 7/30/90-day price insights, and searchable, paginated Activity with delivery outcomes and exports.
- **Recovery and oversight:** Validated SQLite backups, encrypted exports, secondary recovery copies, restore tests, diagnostics, and owner-controlled updates.

Complete valid restocks are recorded immediately; sellouts, ordinary price/status changes, and catalog disappearance require two matching complete observations. Failed or partial checks preserve the last-known-good state. GearBeacon observes catalog data; it does not predict stock, reserve items, or automate checkout.

## Choose an installation

| Option | Requirements | Start here |
|---|---|---|
| **Windows standalone** | Windows x64; runtime included | [Windows guide](https://github.com/alexphillips-dev/GearBeacon/wiki/Windows-Installation) |
| **macOS standalone** | Intel or Apple Silicon; runtime included | [macOS guide](https://github.com/alexphillips-dev/GearBeacon/wiki/macOS-Installation) |
| **Linux standalone** | x64 or ARM64; runtime included | [Linux guide](https://github.com/alexphillips-dev/GearBeacon/wiki/Linux-Installation) |
| **Docker / NAS** | Docker with Compose; amd64/arm64 images | [Docker guide](https://github.com/alexphillips-dev/GearBeacon/wiki/Docker-and-NAS) |
| **Source checkout** | Node.js **22.13 or newer** | [Source guide](https://github.com/alexphillips-dev/GearBeacon/wiki/Source-Installation) |

**Easiest start:** download and extract your standalone package from [Releases](https://github.com/alexphillips-dev/GearBeacon/releases), run `GearBeacon.exe` on Windows or `./gearbeacon` on macOS/Linux, and open `http://localhost:8787`. Included installers provide automatic startup with a low-privilege identity. Packages include checksum/SBOM/provenance metadata; native signing and macOS notarization are not yet provided.

### Docker Compose

From a checkout or a directory containing the supplied [Compose file](docker-compose.yml):

```bash
docker compose up -d
docker compose logs gearbeacon
```

Compose uses the published image, publishes only `127.0.0.1:8787` on the host, and persists `/data` in a named volume. Use the token in the logs to complete owner setup. The [Docker guide](https://github.com/alexphillips-dev/GearBeacon/wiki/Docker-and-NAS) covers NAS storage, private access, local builds, and version pinning.

### Source checkout

No `npm install` is needed just to run the committed application. From the current checkout root:

```text
Windows:      launchers/run-windows.bat
macOS/Linux:  ./launchers/run-mac-linux.sh
```

Open `http://localhost:8787`. Private-server and offline-demo launchers are also in `launchers/`; see [START_HERE](docs/START_HERE.txt). The published v1.2.0 source archive has its launchers at the root, so omit `launchers/` for that download.

## First run and safe access

The browser wizard walks through owner setup, Store regions, access mode, notification channels, and backup settings. Authenticated installations first require the one-time setup token from the process/service/container log. Region, bind-address, and access-mode changes require a restart; other operational settings apply immediately.

| Mode | Initial bind | Owner authentication | Intended use |
|---|---|---|---|
| `local` | `127.0.0.1` | Optional | One computer |
| `private` | `0.0.0.0` | Required | Trusted LAN/VPN, service, or container |
| `proxy` | `127.0.0.1` | Required | Same-host HTTPS reverse proxy |

Local mode cannot expose an unauthenticated server beyond loopback. Keep remote access private or behind a restricted HTTPS proxy. Read [Security and access](https://github.com/alexphillips-dev/GearBeacon/wiki/Security-and-Access) and [Reverse proxy](https://github.com/alexphillips-dev/GearBeacon/wiki/Reverse-Proxy) before changing exposure.

## Keep your data recoverable

Live data stays in the operating system's application-data directory or Docker `/data`, outside application files. SQLite backups and the separate `secrets.key` preserve saved state and encrypted integration credentials. Portable encrypted exports exclude owner credentials, sessions, and local integration secrets.

Use **Settings > Data** to configure backups and test primary/secondary recovery. Before updating, choose **Prepare safe update** and verify its backup. GearBeacon never installs updates automatically. Data paths, migration, encryption, and rollback procedures are in [Backups and recovery](https://github.com/alexphillips-dev/GearBeacon/wiki/Backups-and-Recovery) and [Updates and rollback](https://github.com/alexphillips-dev/GearBeacon/wiki/Updates-and-Rollback).

## Documentation

The [wiki](https://github.com/alexphillips-dev/GearBeacon/wiki) contains the complete guides and technical reference:

| Task | Guide |
|---|---|
| Find products, import watches, and choose variants | [Watchlist and Browse](https://github.com/alexphillips-dev/GearBeacon/wiki/Watchlist-and-Browse) |
| Group items, plan quantities, and track spending | [Collections and purchase planning](https://github.com/alexphillips-dev/GearBeacon/wiki/Collections-and-Purchase-Planning) |
| Configure item/project rules and delivery | [Alerts](https://github.com/alexphillips-dev/GearBeacon/wiki/Alerts-and-Notifications) · [Email and webhooks](https://github.com/alexphillips-dev/GearBeacon/wiki/Email-and-Webhooks) |
| Understand prices, stock evidence, and monitoring gaps | [Stock insights](https://github.com/alexphillips-dev/GearBeacon/wiki/Stock-Insights-and-Monitoring) |
| Investigate activity, failures, and health | [Activity and Operations](https://github.com/alexphillips-dev/GearBeacon/wiki/Activity-and-Operations) · [Troubleshooting](https://github.com/alexphillips-dev/GearBeacon/wiki/Troubleshooting) |
| Automate or customize an installation | [Configuration reference](https://github.com/alexphillips-dev/GearBeacon/wiki/Configuration-Reference) · [API reference](https://github.com/alexphillips-dev/GearBeacon/wiki/API-Reference) |

## Development and support

```bash
npm ci
npm run build
npm run check
```

Contributions target `dev`; `main` is reserved for reviewed stable work. See [CONTRIBUTING](.github/CONTRIBUTING.md) and the [development guide](https://github.com/alexphillips-dev/GearBeacon/wiki/Development-and-Releases) for architecture, tests, packaging, and release validation. Release history lives in the [changelog](docs/CHANGELOG.md).

For help, include the version, installation type, reproduction steps, and a reviewed redacted support bundle from **Settings > Operations**. Report vulnerabilities privately using [SECURITY](.github/SECURITY.md).

## License and trademarks

Copyright 2026 alexphillips-dev. Licensed under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE).

GearBeacon is independent and is not affiliated with or endorsed by Ubiquiti Inc. Ubiquiti and UniFi are trademarks of their respective owner. The license does not grant permission to use GearBeacon or third-party trademarks beyond applicable law.
