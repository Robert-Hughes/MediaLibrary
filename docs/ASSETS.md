# Assets

The source of truth for the app mark is the SVG set in `public/`.

- `public/logo.svg`: monochrome mark using `currentColor`; use for favicon, inline UI, and monochrome contexts.
- `public/logo-color.svg`: color mark; use for app icon, splash, `WelcomeScreen`, and other color-brand contexts.

Direct SVG consumers:

- `index.html` favicon points at `/logo.svg`.
- `src/components/WelcomeScreen.tsx` uses `/logo-color.svg`.

## Generated Tauri Icons

Files under `src-tauri/icons/` are generated raster outputs for platform tooling. Tauri bundles them into `.exe`, `.app`, `.deb`, store assets, iOS assets, and Android assets. Do not hand-edit them.

After editing either source SVG, regenerate rasters from the repo root:

```sh
node scripts/build-icons.mjs
```

The script:

1. Rasterizes `public/logo-color.svg` to `src-tauri/icons/app-icon.png` at 1024 x 1024.
2. Runs `npx tauri icon src-tauri/icons/app-icon.png`.
3. Regenerates platform variants under `src-tauri/icons/`.

Review `git diff src-tauri/icons/` and commit the regenerated set with the SVG source change.

## Adding Assets

Prefer SVG for inline UI assets. Use rasters only when platform tooling requires them. If a raster output is added, document its source SVG and regeneration command next to the workflow that owns it.
