# Startup Performance

Investigation into a multi-second white screen at app launch, followed by a brief flash of the "Loading schema…" dialog before the home screen appears.

## TL;DR

- **`preload_schema` is innocent.** Schema cache load is ~400 ms and runs async — does not block first paint.
- **Dev white screen ≈ 3.9 s of WebView2 cold spawn + first HTTP request to Vite, then ≈ 1.2 s of bundle download / module-graph resolution.**
- **Production white screen is much shorter** (~1–2 s) because the bundle is served from inside the exe and is a single chunk.
- **Splash HTML painted by the webview only after it has parsed `index.html`**, so the first ~4 s in dev is unavoidably blank — the splash flash you see is the second 1.2 s window working as intended.
- Reducing the 3.9 s in dev is largely impossible (Windows WebView2 process spawn). Reducing the 1.2 s is doable — variable fonts + fewer eager imports + `optimizeDeps` / `warmup` all chip away at it.

## How we measured

Both ends instrumented with wall-clock timestamps (`Date.now()` in JS, `SystemTime::now()` in Rust). Logs all tagged `[startup]` and forwarded to Rust stdout via the existing `setupConsoleLogging` shim.

Backend ([src-tauri/src/lib.rs](../src-tauri/src/lib.rs)):

- `STARTUP_INSTANT` set at top of `run()`.
- Log on `run()` entry, on `tauri::Builder::setup()` callback fire, on `preload_schema` enter/exit.

Frontend ([src/main.tsx](../src/main.tsx), [src/App.tsx](../src/App.tsx), [index.html](../index.html)):

- `window.__htmlHeadT` — inline `<script>` in `<head>`, fires when HTML head parses.
- `window.__bodyParsedT` — inline `<script>` at end of `<body>`, fires when DOM is fully parsed.
- `window.__splashPaintedT` — `requestAnimationFrame` after body, ≈ first paint of splash.
- `window.__startupT0` — top of `main.tsx` module-eval (after `setupConsoleLogging` so the log actually reaches Rust).
- Logs in `App()` first render, post-mount effect (= first commit), first rAF after mount, `preload_schema` invoke / resolve.

> **Gotcha:** the first `console.log` in `main.tsx` must come _after_ `setupConsoleLogging()` is called. We initially logged before it, and those lines silently vanished from Rust stdout because `console.log` had not yet been wrapped to forward to the backend.

## Measured timeline (dev, cold start)

Anchored to `run()` entry = 0 ms.

| t (ms) | event                                    | gap       | meaning                                                                                             |
| ------ | ---------------------------------------- | --------- | --------------------------------------------------------------------------------------------------- |
| 0      | `run()` entered                          |           | Rust process started.                                                                               |
| ~450   | tauri `setup()` callback fired           | +450      | Tauri builder initialised, about to spawn webview.                                                  |
| ~4400  | `__htmlHeadT` (HTML head parsed)         | **+3950** | **WebView2 process spawn + HTTP request to Vite for index.html.** Pure white screen.                |
| ~4400  | `__bodyParsedT`                          | +0        | Body is tiny — instant.                                                                             |
| ~4400  | `__splashPaintedT` (rAF)                 | +0        | **Splash visible.**                                                                                 |
| ~5600  | `main.tsx` module-eval starts            | **+1200** | **Vite serves the module graph** (React, App, components, fontsource CSS, …). Splash still visible. |
| ~5630  | `App()` first render                     | +30       | Cheap.                                                                                              |
| ~5670  | First commit / first paint of React tree | +40       | Splash gets replaced by the real "Loading schema…" dialog.                                          |
| ~5670  | `preload_schema` invoke fires            |           |                                                                                                     |
| ~6070  | `preload_schema` resolves                | +400      | Cache hit on `tag_schema_<ver>.json`. Dialog dismisses.                                             |

Numbers vary ±300 ms run-to-run; structure is stable.

### Production cold start

Significantly faster — the webview still has to spawn but does not wait for Vite. Bundle is a single chunk served from inside the exe. The 1.2 s "splash visible" window collapses; the ~2 s "white before splash" window remains and is dominated by WebView2 cold spawn.

## Why preload_schema looked guilty but isn't

Two reasons it appears to cause the flash:

1. `preload_schema` is the only **named** thing happening at startup, so it's the natural suspect.
2. The "Loading schema…" dialog _does_ render briefly — but only because `schemaReady` defaults to `false` at [App.tsx](../src/App.tsx)'s first render, so the dialog appears the instant React commits, then disappears ~400 ms later when the cache load resolves.

Crucially, `preload_schema` runs in a Tauri worker thread (sync `#[tauri::command]`), so it does **not** block React's first render. The dialog flash is a symptom of the long pre-render window, not the cause.

## What we changed

### 1. Inline splash in index.html

Added a CSS-only spinner + "Media Library — Loading…" panel directly in `index.html`. Hidden via the selector `#root:not(:empty) + #splash { display: none; }` — disappears the moment React commits any content into `#root`.

Does not help during the pre-HTML-parse window (~3.9 s in dev, ~1–2 s in prod) but covers everything after the webview has parsed the document.

### 2. Vite `optimizeDeps` + `server.warmup`

In [vite.config.ts](../vite.config.ts):

```ts
optimizeDeps: {
  include: [
    "react", "react-dom", "react-dom/client", "react/jsx-runtime",
    "@tauri-apps/api/core", "@tauri-apps/api/event",
  ],
},
server: {
  warmup: { clientFiles: ["./src/main.tsx", "./src/App.tsx"] },
},
```

`optimizeDeps.include` pre-bundles the listed deps with esbuild into single cached chunks under `node_modules/.vite`. Avoids the first-request, on-demand esbuild pass for each dep. `server.warmup` pre-transforms `main.tsx` + `App.tsx` when the dev server boots so the first webview request hits warm cache.

> **CSS does not belong in `optimizeDeps.include`.** Vite warns `Cannot optimize dependency: …css` because esbuild's dep optimiser only handles JS. Our first attempt listed `@fontsource/*` CSS — removed.

Caveat: marginal in practice. Most of the dev white screen is webview spawn, not dep optimisation. Kept anyway — no downside and shaves a little.

### 3. Variable Geist font, drop Geist Mono

Before: 5 separate `@fontsource/geist-sans/{400,500,600}.css` + `@fontsource/geist-mono/{400,500}.css` imports in [main.tsx](../src/main.tsx). Each is a separate Vite module fetch in dev.

After: one `@fontsource-variable/geist/wght.css` import. Single variable font, all weights via the `wght` axis.

`@fontsource-variable/geist` registers the family as `"Geist Variable"` — different from the static face name `"Geist Sans"`. We added `"Geist Variable"` to the front of the font-family stack in [App.css](../src/App.css):

```css
font-family: "Geist Variable", "Geist", "Geist Sans", system-ui, …;
```

**Geist Mono was completely unused.** No CSS rule referenced `"Geist Mono"` anywhere; all monospace uses were either `monospace` or `ui-monospace, SFMono-Regular, Menlo, monospace`. Both Geist Mono CSS imports were loading a font no element rendered with — pure dead weight. Removed.

Package changes:

- `+ @fontsource-variable/geist`
- `- @fontsource/geist-sans`
- `- @fontsource/geist-mono`
- `- @fontsource-variable/geist-mono` (briefly installed before realising mono is unused; uninstalled).

Notes:

- `wght.css` (upright weights only, no italic axis) is smaller than the default `index.css`. Geist has no italic in the design anyway.
- Variable font WOFF2 is larger than a single static weight but smaller than the sum of 5 static weights — net byte savings, plus way fewer module fetches in dev.
- WebView2 is Chromium-based — full variable-font support.

## What we left alone (but listed as future work)

In rough order of expected impact on the 1.2 s splash-visible window:

1. **Lazy-load progress dialogs and Settings.** [App.tsx](../src/App.tsx) imports `DescribeProgressDialog`, `GeocodeProgressDialog`, `NormaliseProgressDialog`, `SettingsDialog`, `ColumnSelectionDialog`, `ApplyProgressDialog`, `TargetVerifyOutcomeDialog`, and the search worker module at the top level. All are modal / non-critical for first paint. `React.lazy()` + `Suspense` would shrink the critical module graph.
2. **Drop `React.StrictMode` in dev launch path.** Double-invokes render and effects — confirmed in logs (every `preload_schema` invoke and post-mount effect fires twice). Keep it for tests; remove for the dev binary if iteration speed matters.
3. **Defer `setupConsoleLogging()` until after first commit.** It wraps every `console.*` call into a Tauri `invoke()` — fine in steady state, extra work during the first burst of startup logging.
4. **Disable source maps in dev launch profile** if not actively debugging — Vite's transform step is cheaper.
5. **Pre-warm Vite externally.** A `curl localhost:1420` from `BeforeDevCommand` before the exe spawns would force the first transform pass to happen before WebView2 navigates.

## What we can't fix

The ~2–3 s of "WebView2 cold spawn" on Windows is a kernel-level process creation cost. Tauri controls neither the spawn timing nor the navigation. The inline splash is the right mitigation: nothing we do shrinks the white window itself, but the splash makes the _perceived_ delay shorter because content appears the instant the webview can render.

## Logs left in place

The `[startup]` timing logs (backend `STARTUP_INSTANT` + `since_startup_ms` helpers; frontend `__startupT0` / `__htmlHeadT` / `__bodyParsedT` / `__splashPaintedT` markers) are kept in tree. They are cheap (a handful of `log::info!` and `console.log` calls per launch) and invaluable for re-measuring next time someone touches the boot path. Grep stdout for `[startup]` to get the timeline.
