# Update checks and channels

When GearBeacon confirms an update, a compact blue **update available · vX.Y.Z** button appears below the main header on every tab. It opens the matching release notes in a new browser tab. If no notes link is available, it opens the existing update details in **Settings > General > Application**. Appearing or disappearing preserves the Activity card being read and its keyboard focus.

Checks run on the server at startup and every 24 hours, even with no browser open. Open browsers receive the shared result during their normal refresh. **Check for updates** in Settings performs a manual check. Concurrent checks share one request sequence; browser refreshes never trigger additional requests to GitHub.

GearBeacon does not automatically download or install updates. Use the existing installation or deployment update procedure, including its backup confirmation, when you choose to update.

## Main and dev

| Running channel | Update selection | Notes destination |
|---|---|---|
| `main` | Newer published stable release; drafts and prereleases are excluded. | That release's page. |
| `dev` | A newer commit ahead of the running commit on `dev`, including commits with the same version number. Older application versions are excluded. | A matching prerelease page when it identifies the exact commit; otherwise that commit's changelog, falling back to its release notes file. |

An identical or locally ahead dev checkout does not show an update. A diverged checkout is reported in the Settings check result without offering a dev update. If commit identity or comparison is unavailable, only a higher version can confirm an update; Settings explains this limitation. An unavailable update source is never reported as proof that the installation is current.

The running source checkout supplies its Git branch and commit. Packaged source archives and standalone builds include `build-info.json`; container builds record the branch, commit, and package version in the image. Identity is captured at server startup, so restart GearBeacon after changing the installed code. Older packages or raw source archives with no branch metadata default to `main`, unless a prerelease version or a `dev` image tag identifies development.

## Configuration

These are server environment settings. Restart GearBeacon after changing them. The supplied Compose file passes the update settings into the container.

| Setting | Default | Purpose |
|---|---|---|
| `GEARBEACON_UPDATE_CHANNEL` | `auto` | Detect the installed channel, or explicitly select `main` or `dev`. |
| `GEARBEACON_AUTO_UPDATE_CHECKS` | `1` | Set `0` to disable automatic checks while keeping the manual Settings check. |
| `GEARBEACON_GITHUB_RELEASE_API` | GearBeacon's GitHub `/releases/latest` API endpoint | Main reads stable releases; dev derives the repository API from this endpoint to compare commits and locate notes. Set an empty value to disable GitHub update requests. |
| `GEARBEACON_UPDATE_MANIFEST_URL` | Empty | Optional replacement manifest source. `{channel}` expands to `main` or `dev`. |

To disable all online update checks, leave both source URLs empty. A network or parsing failure retains the last confirmed result for the running server and schedules a retry after one hour. GitHub's `Retry-After` and exhausted rate-limit reset time are respected, including for manual checks. Successful checks normally resume the daily schedule. Settings displays failure details; a previously confirmed update button stays available during an outage.

Source builds with `.git` are detected automatically. For a locally built Docker image, pass `BUILD_BRANCH=dev` and `VCS_REF=<full commit SHA>` as build arguments. With Compose, set `GEARBEACON_BUILD_BRANCH=dev` and `GEARBEACON_BUILD_COMMIT=<full commit SHA>` before building. This metadata is embedded in the image. Official package and image workflows set it from the build ref. `GEARBEACON_UPDATE_CHANNEL=dev` can select development for an older installation, but cannot reconstruct a missing commit for same-version comparisons.

An optional manifest must contain `latestVersion` as a semantic version and may provide `releaseNotesUrl`, `releasePageUrl`, inline `releaseNotes`, `downloadUrl`, and the existing compatibility fields. Set `channel` to `dev` for development manifests with a stable-looking version number; otherwise stable versions imply `main` and prerelease versions imply `dev`. Wrong-channel entries and drafts are rejected. Custom manifests compare versions only; commit comparison is provided by the default GitHub dev source. Notes and download links must be absolute HTTP(S) URLs without embedded credentials.

## Privacy and API

Checks read public GitHub release, commit, comparison, and repository-file endpoints, or the explicitly configured manifest. GitHub receives ordinary connection/request metadata, the application version in the user agent, and the running commit when a dev comparison is needed. Watches, credentials, notification destinations, and application data are not included. The Settings > Privacy outbound-connections inventory identifies automatic or manual update checking.

`GET /api/status` includes the cached `update` result, including channel, versions, commits when known, `verified`, `updateAvailable`, `releaseNotesUrl`, check times, and warning state. `GET /api/update/check` requests a shared manual check. These routes retain their existing owner-access requirements; neither installs anything.

GitHub API behavior is documented in the official [Releases API](https://docs.github.com/en/rest/releases/releases) and [commit comparison API](https://docs.github.com/en/rest/commits/commits#compare-two-commits).
