# API Monitor AI Context

Last updated: 2026-07-22

This is the first file an AI maintainer should read before changing API Monitor. It records the current architecture, non-negotiable rules, high-risk files, and safe maintenance commands.

## Current Architecture

- Frontend: React 19, Vite 8, Tailwind CSS 4, Zustand, and `@cloudflare/kumo` 2.6.
- UI system: Kumo-only for base controls and charts. Local components should be business compositions or narrow transition wrappers.
- Backend: Go single-process backend in `backend-go/`, with routes governed by `backend-go/internal/manifest/manifest.go`.
- Persistence: SQLite remains the only durable store. Do not replace it unless there is an explicit product decision.
- Agent: Rust agent in `agent-rust/`, connected through the Go backend's Engine.IO/Socket.IO-compatible server.
- Managed proxy runtime: Linux-only Agent capability that reconciles the pinned sing-box runtime and per-subscription users. Xray is not installed or managed by the control plane. See `docs/adr/0001-managed-proxy-runtime.md`.
- Subscription accounting: the Agent reads loopback-only sing-box V2Ray Stats counters, persists a baseline, and sends idempotent deltas to the Go subscription ledger. Imported external nodes are never included in that ledger.
- Runtime data: data, backups, uploads, secrets, and local environment files are intentionally ignored and must be protected.

Normal development should assume the Go backend owns the active route surface. Node sidecar-era Express/module documentation is historical unless a current file explicitly says otherwise.

## High-Risk Files

- `src/js/pages/ServerPage.jsx`: large page with terminal, Docker, SFTP, metrics, and destructive server actions.
- `src/js/pages/DnsPage.jsx`: large Cloudflare surface with DNS, Workers, Pages, R2, tunnels, and media previews.
- `src/js/pages/OpenAIPage.jsx`: OpenAI-compatible gateway configuration, logging, and model routing.
- `src/js/components/MainLayout.jsx`: app shell, module routing, sidebar, page width, and theme integration.
- `src/js/store.js`: module registry, visibility/order settings, auth headers, and global UI state.
- `backend-go/internal/server/server.go`: HTTP dispatch, static serving, manifest routing, middleware, and realtime entry points.
- `backend-go/internal/manifest/manifest.go`: source of truth for backend route ownership and auth modes.
- `backend-go/internal/serveragent/service.go`: Rust agent protocol, realtime metrics, terminal, Docker, and host actions.
- `backend-go/internal/database` and settings/database maintenance files: SQLite lifecycle and real data safety.

Touch these files only for focused reasons. Avoid broad formatting or opportunistic rewrites inside them.

## Non-Negotiable Rules

- Kumo-only: use Kumo `Button`, `Input`, `Select`, `Tabs`, `Table`, `Dialog`, `DeleteResource`, `Toasty`, `Checkbox`, `Switch`, `Sidebar`, `Loader`, `Tooltip`, `Popover`, `Dropdown`, `TimeseriesChart`, `Meter`, and `ChartPalette` where applicable.
- Destructive delete confirmations should gradually move to `dialog.deleteResource` / Kumo `DeleteResource`. Non-delete confirmations can use normal confirm flows.
- Every backend route change must be represented in the Go route manifest and pass route governance.
- Do not delete or rewrite `.env`, `data/`, `backup/`, `backend-go/data/`, `backend-go/internal/server/data/`, `node_modules/`, or `public/` by default.
- Do not replace SQLite, split into microservices, or perform a large architecture rewrite unless explicitly requested.
- Never combine machine NIC traffic, managed-node raw traffic, subscriber usage, or imported external-node traffic into one total.
- Managed internal proxy nodes use panel-assigned ports in the inclusive range `45654-55654`; never assume port 443. Allocation is unique per server, Agent bind-checked before apply, and does not alter imported external-node ports.
- Do not optimize performance proactively when current performance is acceptable. Prefer governance, clarity, and low-risk locality improvements.
- Do not revert existing uncommitted user or AI changes unless explicitly asked.

## AI Maintenance Commands

Fast local audit:

```bash
npm run audit:fast
```

Full audit, including Go tests, route inventory, and backend smoke against a running Go backend:

```bash
npm run audit:full
```

Cleanable workspace report only:

```bash
npm run clean:check
```

Delete only regenerable caches/build artifacts protected by the cleanup allowlist:

```bash
npm run clean:workspace
```

Core checks:

```bash
npm run governance:check
npm run ui:governance
npm run lint
npm test
npm run backend-go:test
node tools/backend-route-inventory.mjs
```

Backend smoke expects a Go backend at `API_MONITOR_BASE_URL` or `http://127.0.0.1:3000`:

```bash
npm run backend-go:smoke
```

## Cleanup Policy

Safe regenerable targets:

- `.cache/`
- `.tmp/`
- `dist/`
- `backend-go/tmp/`
- `backend-go/api-monitor.exe`
- `agent-rust/target/`
- ignored temporary trace/test files matched by `tools/workspace-cleanup.mjs`

Always preserve:

- `.env`
- `data/`
- `backup/`
- `backend-go/data/`
- `backend-go/internal/server/data/`
- `node_modules/`
- `public/`

`public/` is ignored but may still be used by static serving or deployment flows. Confirm explicitly before removing or rewriting it.

## UI Exception List

Allowed UI exceptions are documented in `docs/refactor-verification.md`. Future audits should use that file before flagging hardcoded colors or file-input patterns as regressions.

Current known exception groups:

- Brand colors in `BrandIcon`.
- QR code dark/light colors and QR image backgrounds.
- Terminal fallback colors for xterm readability.
- Media preview black/white backgrounds.
- Legacy ECharts colors that should be migrated only when the related chart is touched.
- Hidden native file inputs when required for browser file pickers.

## Refactoring Order

For giant files, split only when a related change justifies it. Use this order:

1. Constants and pure helpers.
2. Hooks.
3. Dialogs.
4. Tables and panels.
5. Page container.

Keep each step independently verifiable.
