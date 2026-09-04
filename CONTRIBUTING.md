# Contributing to GearBeacon

Thanks for helping improve GearBeacon. Keep contributions aligned with its private, self-hosted scope: Windows, macOS, Linux, and Docker deployments without a required public cloud account.

## Before opening a change

- Use a public issue for reproducible bugs and bounded feature proposals.
- Use private vulnerability reporting for security findings; see [SECURITY.md](SECURITY.md).
- Never include credentials, owner sessions, notification endpoints, private URLs, production databases, or unredacted logs.
- Target the `dev` branch. `main` is reserved for reviewed stable-release commits.

## Development setup

Install Node.js 22.16.0 and Docker when container testing is needed, then run:

```bash
npm ci
npm run build
npm run check
npm test
npm run test:browser
```

The browser test requires Chrome or Chromium. The weekly live catalog canary is intentionally separate because it contacts the real UniFi Store; do not add watchlist or notification credentials to it.

## Pull requests

- Keep the change focused and explain its user-visible behavior and risk.
- Add deterministic coverage for fixes and new behavior.
- Preserve keyboard access, visible focus, responsive reflow, reduced-motion behavior, and light/dark contrast.
- Update the README for current behavior and the changelog for release-visible changes.
- Do not commit generated release archives, local data, secrets, or `node_modules`.
- Confirm CI and security scanning are green before requesting review.

By contributing, you agree that your contribution is licensed under the Apache License 2.0 used by this repository.
