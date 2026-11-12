# Icons

@omega.js/extension generates every extension icon size from ONE consumer-supplied source image — drop a single file, the build derives the rest.

## Layout

```
<consumer>/config/icon.svg        ← your ONE source icon (svg or png)
```

That's it. The `icons` gulp task takes ONE source through the order every target type shares (`resolveBrandImage` in `@omega.js/devkit/brand-image`):

1. `config/icon.svg`, then `config/icon.png`: the target's own icon always wins. A target with both ships `config/icon.svg`, and `config/icon.png` is not read.
2. `<brandRoot>/assets/logo/brandmark.svg`, when the target sits in a brand (`@omega.js/config`'s `findBrandRoot`). A framework used alone skips this step.

- With neither, the task makes no icons.
- The target's own icon is resized by width, as it is. The brandmark is first set in a square canvas that contains it on a clear ground, so every icon made from it is square, whatever the brandmark's shape.
- Whichever source wins, it generates the same names, into the build output only (nothing is written into `config/`):

```
dist/assets/images/icons/icon.png          (original, converted to png)
dist/assets/images/icons/icon-1024x.png
dist/assets/images/icons/icon-512x.png
dist/assets/images/icons/icon-256x.png
dist/assets/images/icons/icon-128x.png
dist/assets/images/icons/icon-64x.png
dist/assets/images/icons/icon-48x.png
dist/assets/images/icons/icon-32x.png
dist/assets/images/icons/icon-24x.png
dist/assets/images/icons/icon-16x.png
```

## Where the sizes are used

- **Manifest** — @omega.js/extension's manifest template wires the `icons` map to the generated paths (`assets/images/icons/icon-<size>x.png`), covering Chrome's required 16/32/48/128 plus the larger store sizes.
- **Store packaging** — the `package` task copies `icon-128x.png` into the store-assets directory for listing uploads.

## Sizes — ship ONE large source

Supply the source at the largest size you have (1024×1024 recommended) — generation resizes DOWN with quality 100 and strips metadata. Small sources are enlarged (`withoutEnlargement: false`), but upscaled icons look soft; start big.

## Watch behavior

In dev (`npm start`) the task watches `config/icon.svg` and `config/icon.png` always, plus the brand's brandmark when the target sits in a brand, and regenerates on any change: an own icon dropped in while the brandmark is the source takes over at once. In build mode the watcher is skipped: generation runs once in the pipeline.

## Source files

- [src/gulp/tasks/icons.js](../../packages/extension/src/gulp/tasks/icons.js) — generation task (gulp-responsive-modern)
- [src/config/manifest.json](../../packages/extension/src/config/manifest.json) — framework manifest wiring the `icons` map

## See also

- [build-system.md](build-system.md) — where the icons task runs in the pipeline
- [extension.md](extension.md) — cross-browser API + manifest reference
