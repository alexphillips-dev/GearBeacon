# GearBeacon V1.4 cloud deployment

V1.4 can run the monitor as one always-on server so phones and browsers connect to the same stock engine instead of polling the UniFi Store themselves.

## Docker Compose

```bash
docker compose up -d --build
```

Persistent SQLite data lives in the `gearbeacon-data` volume. Rebuilding/replacing the container does not replace the watchlist.

Health endpoints:

- `GET /healthz` — process is alive.
- `GET /readyz` — monitor has a recent successful inventory check.
- `GET /api/health` — detailed monitor health JSON.

## Important V1.4 limitation

V1.4 is still a single-watchlist server without user accounts/authentication. Do not expose it directly to the public internet. Put it behind a private network, VPN, Tailscale, Cloudflare Access, or another authenticated reverse proxy. Multi-user accounts and authorization belong in the planned V1.5 cloud-sync milestone.
