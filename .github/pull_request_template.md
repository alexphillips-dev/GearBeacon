## What changed

Describe the user-visible result and why the change is needed.

## Verification

- [ ] `npm ci`
- [ ] `npm run build`
- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run test:browser`
- [ ] Relevant Docker or native-package checks, if applicable

## Trust and release checks

- [ ] Targets `dev`, not `main`, unless this is an approved stable-release promotion
- [ ] Contains no secrets, private URLs, user data, databases, or unredacted logs
- [ ] Preserves keyboard access, visible focus, responsive reflow, reduced motion, and light/dark contrast
- [ ] Updates documentation and changelog where behavior changed
- [ ] Does not introduce a required cloud service, telemetry, or unsupported mobile scope
