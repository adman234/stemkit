# Security Policy

## Reporting a Vulnerability

Please **do not open a public issue** for security problems.

Report vulnerabilities privately via GitHub's [private vulnerability reporting](https://github.com/danvelope/stemkit/security/advisories/new) (Security → Report a vulnerability). That keeps the issue hidden until it is fixed.

When reporting, include:

- what you found and why it is a problem
- steps to reproduce (or a minimal proof of concept)
- affected version(s) and platform(s)
- your contact info if you want a direct reply

We aim to acknowledge reports within 72 hours and to keep you updated as the issue is triaged and fixed.

## Supported Versions

Only the **latest release** is supported. Users are expected to update through the in-app updater (or re-download from [Releases](https://github.com/danvelope/stemkit/releases)).

| Version | Supported |
| ------- | --------- |
| latest  | ✅        |
| older   | ❌        |

## Scope

The following are in scope:

- the Electron app (main, preload, renderer) in `src/`
- the Python sidecar and scripts in `python/`
- the self-hosted telemetry worker in `telemetry-worker/`
- the release build pipeline (`.github/workflows/`)

### Known considerations

- On first launch the app downloads third-party components and installs them without cryptographic verification: a Python runtime, pip packages, and model weights (fetched over HTTPS from Hugging Face). Treat your network and the first-run downloads accordingly.
- The app shells out to `yt-dlp` and a bundled `ffmpeg` binary.
- The telemetry worker stores only an anonymous install id, version, OS, and arch — no PII. It is an aggregation endpoint, not a service boundary; do not assume it is hardened against abuse.

## Coordinated Disclosure

We will not assign CVEs or publish details of a reported issue without the reporter's agreement. We ask that you give us a reasonable window (default 30 days) to fix and release before public disclosure.