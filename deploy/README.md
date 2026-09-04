# Private GearBeacon deployment

GearBeacon is a single-owner self-hosted application for a local computer, trusted LAN, private VPN, home server, NAS, or authenticated HTTPS reverse proxy. It is not designed for unrestricted public exposure or public registrations.

## Standalone services

Each release package includes the executable, browser assets, release metadata, and the matching installer, uninstaller, and update helper. No separate Node.js installation is needed.

### Windows

From an elevated PowerShell window in the extracted release directory:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install-windows-service.ps1
```

The installer copies GearBeacon to `%ProgramFiles%\GearBeacon`, stores data under `%ProgramData%\GearBeacon`, and registers a `SYSTEM` startup task with restart behavior. It uses private authenticated mode. Windows Firewall should allow TCP 8787 only on the Private profile and only from intended subnets.

```powershell
.\uninstall-windows-service.ps1
```

Uninstall preserves `%ProgramData%\GearBeacon`. Add `-RemoveData` only when permanent deletion is intentional.

### macOS

```bash
sudo ./install-macos-service.sh
```

This installs `/usr/local/lib/gearbeacon`, creates a system LaunchDaemon, stores data in `/Library/Application Support/GearBeacon`, and writes process output to `/var/log/gearbeacon.log`. The package is currently unsigned, so macOS may require an explicit owner approval until signing and notarization certificates are configured.

```bash
sudo ./uninstall-macos-service.sh
```

Add `--remove-data` only to delete the preserved application data.

### Linux

```bash
sudo ./install-linux-service.sh
```

This creates an unprivileged `gearbeacon` system account, installs the application in `/opt/gearbeacon`, stores data in `/var/lib/gearbeacon`, and starts a hardened systemd unit. Read the setup token with:

```bash
sudo journalctl -u gearbeacon
```

Uninstall while preserving data:

```bash
sudo ./uninstall-linux-service.sh
```

Add `--remove-data` only for permanent data removal.

## Docker Compose

```bash
docker compose up -d
docker compose logs gearbeacon
```

Compose uses the published GHCR image when available and can build the checkout. It maps only host loopback, requires owner authentication inside the container, and stores SQLite, primary backups, and the separate notification encryption key in `gearbeacon-data`.

For recovery from a lost Docker volume or host disk, mount a second destination and configure it in Settings → Data:

```yaml
services:
  gearbeacon:
    environment:
      GEARBEACON_SECONDARY_BACKUP_DIR: /recovery
    volumes:
      - gearbeacon-data:/data
      - /mnt/nas/gearbeacon:/recovery
```

Use a real separately protected disk or NAS path for the host side. GearBeacon warns when the secondary path appears to share the primary data filesystem. To keep the recovery copies confidential, enable encrypted secondary exports in Settings and save a passphrase of at least 12 characters. Store that passphrase outside GearBeacon; it is required to decrypt those copies after a total installation loss.

To expose only a private host interface, change the mapping deliberately:

```yaml
ports:
  - "192.168.1.20:8787:8787"
```

Do not use a blanket public host mapping without a private firewall/VPN or maintained HTTPS proxy.

## Reverse proxy

Set these values in the first-run wizard or environment, restart once, and keep the backend reachable only by the proxy:

```text
GEARBEACON_ACCESS_MODE=proxy
GEARBEACON_BIND_HOST=127.0.0.1
GEARBEACON_PUBLIC_BASE_URL=https://gearbeacon.example.internal
GEARBEACON_COOKIE_SECURE=1
```

Caddy:

```caddyfile
gearbeacon.example.internal {
    reverse_proxy 127.0.0.1:8787
}
```

Nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

GearBeacon trusts forwarded host, protocol, and address headers only in explicit `proxy` mode. Use an HTTPS public URL; secure-cookie and HSTS behavior is covered by integration tests.

## Owner setup and recovery

Authenticated first start prints a random one-time token. A fixed token can be set with `GEARBEACON_SETUP_TOKEN`. Automated installations may use `GEARBEACON_OWNER_PASSWORD_FILE`; avoid leaving a plaintext owner password in shell or Compose history.

Recovery procedure:

1. Stop GearBeacon.
2. Put a strong replacement password in a root/owner-readable file.
3. Set `GEARBEACON_OWNER_PASSWORD_FILE` to that file and `GEARBEACON_RESET_OWNER_PASSWORD=1`.
4. Start GearBeacon and sign in with the new password.
5. Remove the reset flag/password setting, then restart normally.

Recovery revokes every existing session. Never leave the reset flag active.

## Backup and disaster-recovery setup

The primary backup directory lives under the GearBeacon data directory. Configure a secondary absolute directory or mounted share in Settings → Data when recovery must survive failure of that primary disk or container volume. GearBeacon rejects symbolic-link destinations, verifies read/write access, and can retain the copies as either validated SQLite snapshots or passphrase-encrypted JSON exports.

After configuration:

1. Select **Create backup now**.
2. Confirm the secondary recovery card in Operations reports a copy.
3. Select **Test latest primary**, then **Test latest secondary**.
4. Store the secondary encryption passphrase and a copy of `secrets.key` in an appropriate secure location. The passphrase recovers encrypted backup content; `secrets.key` preserves saved notification credentials when restoring the SQLite database.
5. Repeat both restore tests after storage, permission, mount, or platform changes.

The restore test is non-destructive: it works on a temporary copy, runs SQLite integrity checks or decrypts and validates the export, verifies schema compatibility, and never replaces the active database. A secondary-copy failure leaves a successfully validated primary backup intact and raises an Operations warning.

For full recovery from SQLite, stop GearBeacon before replacing the active database, preserve the failed database for investigation, copy a tested backup into place, keep `secrets.key` alongside it, and then start the same or a schema-compatible newer GearBeacon release. Encrypted JSON recovery exports can be restored through Settings → Data on a fresh installation.

## Owner-controlled updates and rollback

1. Review **Check for updates** and its release notes.
2. Select **Prepare safe update**. This flushes regional state and creates a validated pre-update database backup.
3. Stop the service if the helper does not manage it automatically.
4. Run the package helper with the version and explicit confirmation shown by GearBeacon:

```powershell
.\update-windows.ps1 -Version VERSION -BackupConfirmed
```

```bash
./update-mac-linux.sh VERSION --backup-confirmed
./update-docker.sh VERSION --backup-confirmed
```

Standalone helpers download the exact platform archive and reject an invalid SHA-256 checksum. Docker selects the explicit image tag. None of the helpers runs silently or on a timer.

For rollback, stop GearBeacon, copy the validated `pre-update-*` SQLite backup over the active database while the process is stopped, reinstall/select the previous application or image version, and start it again. Keep the `secrets.key` file with the database so configured integration credentials remain decryptable.

## Health and logs

- `GET /healthz` — process liveness without private data.
- `GET /readyz` — every configured region has current healthy catalog data.
- `GET /api/health` — authenticated detailed monitor health.
- Operations — authenticated regional status, pending confirmations, queue failures, primary/secondary recovery, disk use, warnings, diagnostics, redacted support bundle, and filtered/downloadable application logs.

Container and service managers should use `/healthz` for liveness and `/readyz` when routing should depend on fresh store data.

Use **Run diagnostics** after initial setup and whenever storage, notifications, connectivity, or reverse-proxy settings change. The downloaded support bundle is designed for troubleshooting and redacts secrets, addresses, and local paths, but review any diagnostic artifact before sharing it outside your household or organization.

## Release candidates

Manually run the **Candidate packages** workflow with a version such as `1.10.0-rc.1` to build downloadable Actions artifacts without creating a public release. It uses the same locked packaging jobs as tag publication, then extracts and starts each native package and validates the source package. Each archive includes a checksum and SPDX JSON SBOM and receives a GitHub artifact attestation.

Prerelease tags such as `v1.10.0-rc.1` must point to `dev`, publish only prerelease-specific container tags, and never replace the stable `latest` image. Stable tags such as `v1.10.0` must point to protected `main` and pass exact-commit CI, security, version, changelog, manifest, package, container, SBOM, and provenance gates. Complete the repository's stable release checklist—including real installs, updates, rollbacks, and a 24–48 hour soak—before creating the stable tag.
