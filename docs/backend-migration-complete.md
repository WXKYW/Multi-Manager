# Go Backend Migration Status

Last updated: 2026-07-07

## Current Status

The active backend architecture is the Go backend in `backend-go/`, governed by `backend-go/internal/manifest/manifest.go`.

Current route inventory reports 179 manifest routes, all owned by Go. Node sidecar-era Express modules are historical context and should not be used as the default implementation model for new work.

## What This Means

- Add or change backend routes in Go.
- Keep the route manifest as the source of truth for route ownership, auth mode, match mode, and response mode.
- Use `node tools/backend-route-inventory.mjs` to inspect the active route surface.
- Use `npm run governance:check` to catch frontend route drift and retired route references.
- Use `npm run backend-go:test` for Go package tests.
- Use `npm run backend-go:smoke` only against a running Go backend, with `API_MONITOR_BASE_URL` set when it is not `http://127.0.0.1:3000`.

## Historical Notes

Older documents may mention Express routers, `modules/*-api`, or Node sidecar fallback. Those references describe migration history unless a current operational guide explicitly asks for a legacy mode.

Do not add new Express modules. Do not reintroduce Node sidecar ownership for active routes without an explicit product decision.

