# MediaLibrary

Desktop media-library application built with Tauri, Rust, React, and
TypeScript.

Run commands from the repository root in PowerShell 7 (`pwsh`).

## Development

Install frontend dependencies from a clean lockfile:

```powershell
npm ci
```

Run the Tauri application in normal development mode:

```powershell
npm run tauri -- dev
```

This starts the Vite development server and builds an unoptimised Rust debug
executable under `src-tauri\target\debug`. Rust and frontend changes are
watched and rebuilt automatically.

The older command form below is equivalent, but the form above makes npm's
argument boundary explicit:

```powershell
npm run tauri dev --
```

## Release-optimised development mode

To retain the Vite development server and hot reload while compiling Rust in
release mode:

```powershell
npm run tauri -- dev --release
```

This writes `src-tauri\target\release\medialibrary-tauri.exe`, but it is still
a development-mode run that expects the Vite server. Do not use this command
when the resulting executable needs to run independently.

On the current development machine, the Start Menu shortcut points directly
to that release path. Therefore, `dev --release` can temporarily replace the
shortcut's standalone production executable with one intended for a
development session. Use a production build afterward to restore it.

## Production build

Build the optimised, standalone production executable without packaging
installers:

```powershell
npm run tauri -- build --no-bundle
```

The executable is written to:

```text
src-tauri\target\release\medialibrary-tauri.exe
```

Run it directly:

```powershell
.\src-tauri\target\release\medialibrary-tauri.exe
```

On the current development machine, the existing Start Menu shortcut launches
this same executable.

Build the production executable and also generate MSI and NSIS installers:

```powershell
npm run tauri -- build
```

The historical command form used to create the existing release artifacts is
equivalent:

```powershell
npm run tauri build
```

Installer artifacts are written below:

```text
src-tauri\target\release\bundle\
```

## Checks

Run the complete frontend check:

```powershell
npm run check
```

Run the Rust formatting, lint, and default test checks:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Run the ExifTool-backed Rust integration tier:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --features integration
```

The integration tier requires `exiftool` on `PATH`.

## Runtime logs

MediaLibrary runtime logs are stored at:

```text
%LOCALAPPDATA%\com.xman2.medialibrary\logs\medialibrary.log
```

AI Describe activity is identified by `[describe]`. Describe logs include
millisecond timestamps and per-image stages for local preprocessing, API
dispatch, and API completion.

The AI Describe audit log is stored separately at:

```text
%APPDATA%\com.xman2.medialibrary\describe_log.jsonl
```

## Performance tuning

The app Settings dialog exposes concurrency controls for AI Describe,
metadata scanning, and thumbnail generation. Values range from 1–16 and apply
to the next Describe run or folder scan without restarting the app.

The runtime log records the effective values at operation start:

```text
[describe] starting describe ... concurrency=12
[scan] starting ... metadata_concurrency=4 thumbnail_concurrency=8
```
