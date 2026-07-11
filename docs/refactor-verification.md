# Refactor Verification And UI Exceptions

Last updated: 2026-07-07

This file records allowed exceptions so future AI audits do not repeatedly flag intentional deviations from Kumo-only rules. New exceptions should be narrow, named, and removed when Kumo or project code provides the right replacement.

## Allowed UI Exceptions

| Area | Files | Reason | Follow-up rule |
|------|-------|--------|----------------|
| Brand colors | `src/js/components/ui/BrandIcon.jsx` | External brand identity colors cannot be represented by Kumo semantic tokens without losing meaning. | Keep limited to brand icon rendering. Do not reuse these colors for general UI chrome. |
| QR code colors | `src/js/pages/FileboxPage.jsx`, `src/js/pages/VoidRoomPage.jsx` | QR code dark/light colors and white QR backgrounds are functional contrast requirements. | Keep colors local to QR generation or QR image presentation. |
| Camera/QR scanner surface | `src/js/pages/TotpPage.jsx` | The scanner preview uses black as a content surface, not a theme color. | Do not extend this to surrounding UI. |
| Terminal colors | `src/css/app.css`, `src/js/pages/ServerPage.jsx` | xterm fallback colors are readability fallbacks when Kumo CSS variables are unavailable. | Prefer Kumo variables first; raw fallback values stay behind `getKumoToken` or CSS variable fallbacks. |
| Media preview surfaces | `src/js/pages/DnsPage.jsx` | Video previews and embedded document previews need black/white content backgrounds. | Keep these colors on media surfaces only. |
| Legacy ECharts colors | `src/js/pages/UptimePage.jsx` | Existing ECharts options contain raw theme colors. This is an accepted legacy exception for now. | When touching uptime charts, migrate toward Kumo `TimeseriesChart`, `Meter`, or `ChartPalette`. |
| Map status/bubble colors | `src/js/components/server/ServerLocationMap.jsx` | ECharts maps require hardcoded hex values for data points/bubbles representing statuses. | Keep colors localized to map rendering or legend. |
| Native file picker | Any page | Browser file selection can require a native hidden file input. | Keep the input hidden or screen-reader-only and trigger it from Kumo `Button` / `Input` UI. |

## Verification Checklist

- Run `npm run ui:governance` after UI-related changes.
- Run `npm run audit:fast` before broad AI handoff or larger pull requests.
- If a new hardcoded color is required, add it here with a narrow reason before updating the scanner allowlist.
- If a destructive delete flow is touched, prefer `dialog.deleteResource` / Kumo `DeleteResource`.
- If a giant page is touched, split only the related constants, hooks, dialogs, tables, or panels. Avoid whole-file rewrites.
