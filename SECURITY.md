# Security policy

GearBeacon is a private, self-hosted monitor. It stores watchlists, history, owner credentials, and optional notification secrets on the machine or server where it runs. It does not provide a GearBeacon cloud account or telemetry service.

## Supported versions

Security fixes are provided for the latest stable release. Development builds on `dev` receive fixes before release but are not a supported production channel. Older releases should be upgraded after a validated backup and restore test.

| Version | Supported |
|---|---|
| Latest stable release | Yes |
| Prerelease and `dev` builds | Testing only |
| Older releases | No |

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability or include secrets, private URLs, logs, backups, or exploit details in a public discussion.

Use GitHub's **Report a vulnerability** option on this repository's Security page. Include the affected version and deployment type, a minimal reproduction, expected impact, and any suggested mitigation. Redact credentials and personal data.

You should receive an acknowledgement within three business days. The report will be assessed, a remediation and disclosure plan will be coordinated when applicable, and credit will be offered unless you prefer to remain anonymous.

## Deployment responsibility

GearBeacon is intended for a trusted local computer, private LAN/VPN, or authenticated HTTPS reverse proxy. Operators remain responsible for host updates, TLS and proxy configuration, filesystem permissions, backup protection, and access to the dashboard. Never expose local mode beyond loopback; use owner authentication for private or proxy deployments.

Before sharing a support bundle, diagnostic output, or backup, review it for information specific to your installation even though GearBeacon applies redaction to its support bundle.
