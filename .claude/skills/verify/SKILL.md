---
name: verify
description: Launch and drive the React CMS safely without running Fastlane.
---

# Verify AutoPushApp CMS

1. Build the app with `npm run build`.
2. Serve `web/dist` from an isolated local HTTP server that also stubs the `/api` endpoints needed by the flow. Never start the worker or invoke Fastlane for CMS-only verification.
3. Launch Google Chrome headless with a temporary `--user-data-dir` and a dedicated `--remote-debugging-port`.
4. Drive the UI through Chrome DevTools Protocol, set `sessionStorage['autopush.adminToken']`, interact with the rendered controls, and capture screenshots plus API request bodies.
5. For `/builds/new`, verify project loading/preselection, project configuration preview, disabled project options, POST `/api/projects/:projectKey/builds` with an `Idempotency-Key`, and navigation to `/builds/:id`.

Use unique ports and temporary files under `/tmp`; do not connect to production Redis, SQLite, Firebase, or an iOS runner.
