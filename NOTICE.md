# GearBeacon V1.4 notices

GearBeacon is an independent project and is not affiliated with or endorsed by Ubiquiti Inc.

The stock adapter uses publicly reachable data exposed to the UniFi Store frontend. That store integration can change without notice, so V1.4 isolates it behind the GearBeacon API and uses catalog-health guards to avoid treating malformed/partial responses as real sellouts.

GearBeacon uses Node.js's built-in SQLite interface for persistence. User data is stored outside the application folder by default and is not included in release archives.

V1.4 can integrate with GitHub Releases, Expo Push, ntfy, and Discord. Those external services have their own terms, availability, and configuration requirements.

During design, the MIT-licensed open-source project `jamesccupps/UnifiStockWatcher` was consulted as a reference for UniFi Store behavior. GearBeacon's code in this package was generated independently rather than copied from that project.
