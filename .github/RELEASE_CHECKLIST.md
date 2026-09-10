# GearBeacon stable release checklist

Use the required sections after a manually dispatched candidate-package run and when publishing a stable tag from `main`. Automated validation and publication checks are release prerequisites. Real-host and manual testing below are recommended additional validation; they do not block tagging or publication and require no waiver when unavailable. Record only checks that were actually performed as passed.

## Required: candidate identity and automated evidence

- [ ] Candidate commit is on `dev`, CI and Security scanning are green at that exact SHA, and no higher-severity alert is open.
- [ ] Candidate packages were produced by **Candidate packages**, not by a local ad hoc build.
- [ ] Every platform archive has a passing checksum, SPDX JSON SBOM, and GitHub artifact attestation.
- [ ] Candidate version, changelog, release manifest, UI version, and compiled server version agree.
- [ ] The scheduled or manually dispatched live catalog canary is green for US, Canada, EU, and UK.

## Required: promotion and publication

- [ ] Create a release pull request from `dev` to protected `main`; do not force-push or bypass required checks.
- [ ] After merge and green checks on the exact `main` SHA, place the owner-authorized stable `vMAJOR.MINOR.PATCH` tag on that SHA.
- [ ] Keep the GitHub release as a draft until archives, checksums, SBOMs, amd64/arm64 container images, and attestations all succeed.
- [ ] Verify the published release, curated notes, downloads, checksums, provenance, and container tags against the reviewed commit.

## Recommended: real installation and upgrade matrix

When these checks are performed, record OS versions, CPU architecture, package names, commit SHA, tester, and results in the release pull request. This manual matrix is optional; automated platform installation, upgrade, browser, and package tests remain required.

- [ ] Clean Windows x64 install, first-run setup, service restart, browser access, and uninstall with data-preservation choice.
- [ ] Windows x64 upgrade from the latest stable release after backup/restore test, followed by rollback to that release.
- [ ] Clean macOS x64 install, first-run setup, launchd restart, browser access, update, rollback, and uninstall.
- [ ] Clean macOS ARM64 install, first-run setup, launchd restart, browser access, update, rollback, and uninstall.
- [ ] Clean Linux x64 install, first-run setup, systemd restart, browser access, update, rollback, and uninstall.
- [ ] Clean Linux ARM64 install, first-run setup, systemd restart, browser access, update, rollback, and uninstall.
- [ ] Docker Compose amd64 and arm64 clean install, named-volume persistence, explicit-tag update, rollback, and container recreation.
- [ ] Existing watchlist, alert rules, history, settings, secrets, and owner access survive every upgrade and rollback exercise.

## Recommended: manual accessibility and daily use

- [ ] Complete all primary workflows using only the keyboard in current Chrome, Edge, Firefox, and Safari where available.
- [ ] Confirm visible focus, dialog focus containment and restoration, Escape behavior, status announcements, 200% browser zoom/reflow, reduced motion, and light/dark contrast.
- [ ] Confirm product images, import preview, Activity evidence, notifications preview/test, backups, diagnostics, logout, and login.

## Recommended: soak testing

- [ ] Run the exact candidate for at least 24 hours, preferably 48, against every enabled real region with normal polling.
- [ ] Review monitor failures, partial catalogs, pending confirmations, notification retries, memory/disk use, backups, and restart recovery during the soak.

Code signing and platform notarization are not currently automated and remain a separate milestone requiring protected signing credentials and platform-specific release validation.
