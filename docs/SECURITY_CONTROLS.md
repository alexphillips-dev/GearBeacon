# Owner security and recovery

GearBeacon remains a private, single-owner application. Local mode binds only to loopback. The former `GEARBEACON_ALLOW_INSECURE_REMOTE` override no longer permits remote access. Invalid saved configuration stops startup; it does not silently fall back to environment defaults. Use authenticated private mode for a LAN/VPN or proxy mode behind the configured same-host HTTPS reverse proxy.

## Sessions and verification

In **Settings > Security > Sessions**, set the absolute sign-in lifetime (1–168 hours, default 24) and inactivity lock (1–120 minutes, default 30). The environment defaults are `GEARBEACON_SESSION_HOURS` and `GEARBEACON_SESSION_IDLE_MINUTES`; saved settings take precedence. Values outside these bounds are rejected. An owner password is required for dashboard locking.

The server enforces both limits. Background polling does not extend the inactivity deadline. Browser interaction sends a separate authenticated, CSRF-protected activity request. Monitoring, notification processing, and an independently running checkout companion continue while the dashboard is locked or closed.

Configuration changes, data transfers and restore previews/tests, password changes, session revocation, and authenticator changes require owner verification within the last five minutes. A recent successful sign-in counts. Otherwise a modal asks for the password and, when enabled, a fresh authenticator or recovery code. Cancel or Escape leaves the requested action unapplied.

Schema v15 adds session activity and verification timestamps and signs existing browsers out once during upgrade. GearBeacon creates its normal validated migration backup first. Watchlists, history, notifications, and purchase records remain intact.

## Optional authenticator

1. Create an owner password if the installation does not have one.
2. Open **Settings > Security > Password > Authenticator app** and choose **Set up authenticator**.
3. Add a time-based account named GearBeacon in your authenticator app. Enter the displayed setup key manually. Use six digits, SHA-1, and a 30-second period. No external QR service or cloud account is used.
4. Enter a code to confirm setup within five minutes. Other signed-in browsers are revoked.
5. Save the ten recovery codes in your password manager before dismissing them. They are shown once. Each replaces an authenticator code once and still requires your password.

Codes cannot be replayed. If you just used an authenticator code, wait for the next one before another verification. Keep the host and phone clocks accurate. The setup key and recovery codes disappear from the dashboard on sign-out/lock and are excluded from portable exports and imports. The authenticator secret is encrypted with the installation key; only recovery-code hashes are retained.

If both the authenticator and recovery codes are lost, an administrator with host access can stop GearBeacon, configure `GEARBEACON_OWNER_PASSWORD_FILE` with a new private password file, and start once with **both** `GEARBEACON_RESET_OWNER_PASSWORD=1` and `GEARBEACON_RESET_MFA=1`. Remove both reset flags afterward and restart normally. This resets owner authentication and revokes browser sessions. It is an explicit host-admin recovery operation, never an unauthenticated browser endpoint.

## Local encryption and backups

On Windows, the application data directory and encryption key receive protected ACLs for the running account, SYSTEM, and Administrators. This applies to source/portable installs as well as services. Existing raw `secrets.key` files are atomically wrapped using Windows DPAPI for the current account after verifying that the wrapped key decrypts correctly. The underlying key remains unchanged. On Linux/macOS, the data directory is owner-only (0700) and the key is owner read/write (0600). Disk encryption adds protection when a device or disk is stolen.

A Windows-protected key requires the original Windows account and its DPAPI profile. Copying it to another user, service account, or machine is insufficient. Do not change the service identity without preparing a transfer. Raw SQLite backups are not encrypted transfer files; protect them and retain the matching key for same-installation recovery. Older builds cannot read DPAPI-wrapped keys: rollback requires a compatible pre-upgrade database and its **pre-upgrade** key.

For another machine or account, use **Settings > Data > Backups & transfer > Export encrypted data** and save its passphrase separately. Portable exports contain monitoring data, exclude owner credentials, authenticator secrets, sessions, and local integration secrets, and restore auto-buy instructions paused. Reconfigure integration credentials and pair the companion on the new installation. Encrypted secondary exports can also be selected under **Data > Schedule & retention**.

## Notification destinations

Notification HTTP requests go only to the currently configured origin. Connections pin the address checked by DNS validation, reject redirects, enforce a timeout and response-size bound, and retain TLS certificate verification. Configure the final notification URL directly. Metadata, unspecified, multicast, and link-local addresses are blocked even if entered explicitly.

Configured private IP addresses and `localhost` work directly. For a hostname resolving to LAN/VPN addresses, add that exact hostname in **Settings > Security > Sessions > Approved private notification hostnames**, or supply `GEARBEACON_NOTIFICATION_PRIVATE_HOSTS` before any saved host list exists. Enter hostnames/IPs only, without URLs, ports, or wildcards. Existing integrations using private DNS names need this one-time approval. Public notification hosts cannot silently resolve into the private network without approval.

## Verified updates

See [Updates](UPDATES.md) for checksum, signed provenance, and container digest verification. Updates always remain owner-initiated and require a prepared backup.
