# Private GearBeacon deployment

GearBeacon is a single-owner self-hosted web application. It is suitable for a local computer, trusted LAN, private VPN, home server, NAS with Docker support, or an HTTPS reverse proxy. It is not designed as a public registration service.

## Security boundary

- Direct launch defaults to `local` mode and `127.0.0.1`.
- `private` and `proxy` modes require owner authentication.
- GearBeacon refuses a non-loopback `local` bind unless the explicit emergency override is enabled.
- Docker Compose publishes only `127.0.0.1:8787` on the host by default.
- Only liveness, readiness, and authentication bootstrap routes are public in authenticated modes.

Do not publish GearBeacon directly to the unrestricted internet. Prefer a private VPN. If internet routing is unavoidable, terminate HTTPS at a maintained reverse proxy, keep owner authentication enabled, limit firewall sources where possible, and keep the host and proxy patched.

## Windows

Install Node.js 22.13 or newer, extract GearBeacon to a stable directory, and run:

```text
run-windows.bat
```

That mode is reachable only at `http://localhost:8787` on the Windows computer.

For a trusted LAN or VPN server:

```text
run-private-windows.bat
```

Allow inbound TCP `8787` only on the Windows Firewall private profile and only from the intended subnet. The terminal prints the first-run setup token. Keep the terminal running, or use a service wrapper or Task Scheduler configured for the same working directory and command:

```text
node --no-warnings backend\dist\index.js
```

Configure service environment variables rather than editing source files.

## macOS

Install Node.js, then:

```bash
chmod +x run-mac-linux.sh run-private-mac-linux.sh
./run-mac-linux.sh
```

Use `./run-private-mac-linux.sh` for a trusted LAN/VPN server. For an always-on Mac, create a LaunchAgent or LaunchDaemon that sets the working directory, required environment variables, and runs `/usr/local/bin/node --no-warnings backend/dist/index.js`. Node may instead be under `/opt/homebrew/bin/node` on Apple Silicon; use the result of `command -v node`.

## Linux

Run `./run-mac-linux.sh` for local access or `./run-private-mac-linux.sh` for private network access.

A systemd service can use:

```ini
[Unit]
Description=GearBeacon private stock monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gearbeacon
Group=gearbeacon
WorkingDirectory=/opt/gearbeacon
Environment=NODE_ENV=production
Environment=GEARBEACON_ACCESS_MODE=proxy
Environment=GEARBEACON_BIND_HOST=127.0.0.1
Environment=GEARBEACON_DATA_DIR=/var/lib/gearbeacon
ExecStart=/usr/bin/node --no-warnings /opt/gearbeacon/backend/dist/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/gearbeacon

[Install]
WantedBy=multi-user.target
```

Create the `gearbeacon` system user and writable `/var/lib/gearbeacon` directory before enabling the service. Adjust paths to the actual install.

## Docker Compose

```bash
docker compose up -d --build
docker compose logs gearbeacon
```

The container listens on its internal network, but Compose maps it only to host loopback. Owner authentication is still mandatory. Persistent SQLite data is stored in the `gearbeacon-data` volume.

To use a fixed setup token during automation:

```bash
GEARBEACON_SETUP_TOKEN='a-long-random-one-time-value' docker compose up -d --build
```

Remove that variable after setup. For unattended initial provisioning, use a Docker secret mounted as a file and set `GEARBEACON_OWNER_PASSWORD_FILE` to its container path. Avoid leaving a plain password in Compose history.

To expose GearBeacon only on a private host interface, replace the port mapping with that interface's address:

```yaml
ports:
  - "192.168.1.20:8787:8787"
```

Keep `GEARBEACON_ACCESS_MODE=private`. Do not use a blanket public bind without a private firewall/VPN or HTTPS proxy.

## Reverse proxy

Recommended environment:

```text
GEARBEACON_ACCESS_MODE=proxy
GEARBEACON_BIND_HOST=127.0.0.1
GEARBEACON_PUBLIC_BASE_URL=https://gearbeacon.example.internal
GEARBEACON_COOKIE_SECURE=1
```

Minimal Caddy example:

```caddyfile
gearbeacon.example.internal {
    reverse_proxy 127.0.0.1:8787
}
```

Minimal Nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

GearBeacon trusts forwarded host/protocol/client-address headers only in `proxy` mode. Configure extra browser origins only when genuinely required using `GEARBEACON_ALLOWED_ORIGINS`.

## Owner setup and recovery

Authenticated first start prints a one-time random setup token. Alternatively set `GEARBEACON_SETUP_TOKEN`, `GEARBEACON_OWNER_PASSWORD_FILE`, or `GEARBEACON_OWNER_PASSWORD` before first start.

For owner-password recovery:

1. Stop GearBeacon.
2. Set a strong value through `GEARBEACON_OWNER_PASSWORD_FILE`.
3. Set `GEARBEACON_RESET_OWNER_PASSWORD=1`.
4. Start GearBeacon and verify the new password.
5. Remove or reset `GEARBEACON_RESET_OWNER_PASSWORD=0`, then restart normally.

A password reset revokes all existing sessions. Leaving the reset flag enabled would reset the password on every restart.

## Backups and upgrades

Back up the persistent data directory or Docker volume in addition to GearBeacon's internal backups. Stop the process for raw filesystem copies, or use the dashboard's validated SQLite backup/export paths while it is running.

Recommended upgrade sequence:

1. Create an encrypted export and store its passphrase separately.
2. Create an on-demand database backup in Settings.
3. Replace the application files or pull the new container.
4. Start GearBeacon against the same data directory/volume.
5. Confirm Settings shows healthy SQLite integrity and the expected watchlists.

GearBeacon automatically creates a pre-update database backup when the recorded application version changes.

## Health checks

- `GET /healthz` — process liveness; no private monitor state.
- `GET /readyz` — all configured regional monitors are ready/current.
- `GET /api/health` — detailed authenticated health.

The Docker image includes a liveness health check against `127.0.0.1:8787/healthz`.
