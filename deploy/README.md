# Deployment helpers

This directory contains GearBeacon's service installers, uninstallers, and owner-controlled update helpers. Complete hosting instructions now live in the [GearBeacon wiki](https://github.com/alexphillips-dev/GearBeacon/wiki).

## Choose a guide

| Platform / task | Documentation | Helpers |
|---|---|---|
| Windows automatic startup | [Windows guide](https://github.com/alexphillips-dev/GearBeacon/wiki/Windows-Installation) | `install-windows-service.ps1`, `uninstall-windows-service.ps1`, `update-windows.ps1` |
| macOS LaunchDaemon | [macOS guide](https://github.com/alexphillips-dev/GearBeacon/wiki/macOS-Installation) | `install-macos-service.sh`, `uninstall-macos-service.sh`, `update-mac-linux.sh` |
| Linux systemd | [Linux guide](https://github.com/alexphillips-dev/GearBeacon/wiki/Linux-Installation) | `install-linux-service.sh`, `uninstall-linux-service.sh`, `update-mac-linux.sh` |
| Docker / NAS | [Docker guide](https://github.com/alexphillips-dev/GearBeacon/wiki/Docker-and-NAS) | `update-docker.sh`; repository-root `docker-compose.yml` |
| HTTPS hosting | [Reverse proxy](https://github.com/alexphillips-dev/GearBeacon/wiki/Reverse-Proxy) | Same-host proxy configuration and Docker distinctions |
| Recovery and upgrades | [Backups](https://github.com/alexphillips-dev/GearBeacon/wiki/Backups-and-Recovery) · [Updates and rollback](https://github.com/alexphillips-dev/GearBeacon/wiki/Updates-and-Rollback) | Validated snapshots and explicit backup confirmation |
| Owner access | [Security and recovery](https://github.com/alexphillips-dev/GearBeacon/wiki/Security-and-Access) | Access modes, setup token, password reset |

## Before running a helper

- Native installers expect the **extracted standalone package**, with its executable, `web` directory, and manifest. They are copied into release archives; source-checkout launchers are in `../launchers/`.
- Automatic startup uses a low-privilege identity and a separate service data directory. Windows uses a **Scheduled Task named GearBeacon**, despite the installer filename.
- Create and verify a pre-update backup before passing `-BackupConfirmed` or `--backup-confirmed`. Native updaters verify SHA-256; Docker updates retain the existing data volume.
- Native update helpers replace application files, not every installer/service configuration. Review deployment changes before applying a new installer.
- The Docker helper selects a tag for its invocation only; also persist `GEARBEACON_IMAGE_TAG` in your Compose configuration.
- Uninstallers preserve application data unless you explicitly request `-RemoveData` or `--remove-data`.

Release requirements are defined by the [release checklist](../.github/RELEASE_CHECKLIST.md). Real-host installation, upgrade, rollback, manual accessibility, and soak testing are recommended additional validation, not prerequisites. See [Development and releases](https://github.com/alexphillips-dev/GearBeacon/wiki/Development-and-Releases) for the complete workflow.
