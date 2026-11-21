# AutoInc

A static Astro site with MDX posts and interactive database visualizations.

## Run locally

Requires Node.js 24 and a stable Rust toolchain.

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run dev
```

`npm run build` compiles Rust and builds the static site into `dist/`. Use `npm run preview` to serve that build.

## Edit the site

- Write Markdown or MDX in `src/content/posts/`. Each post has a title, summary, date, and topic.
- Edit the project list and external writing in `src/site.ts`.
- Import Astro components into an MDX post to add interactive figures. See the InnoDB post for an example.

## Vector search explorer

The article is at `/posts/vector-search-visualized/` when running `npm run dev`. The explorer runs HNSW in a Rust WASM worker. Run `npm run check:vector-search` to compare WASM with the native engine, tracing on and off, and an independent brute-force baseline.

The bundled Fashion-MNIST subset contains the first 600 training and 50 test images per class, each split in its original order. The pack contains gzip-compressed 28×28 pixels, class labels, and little-endian 16-bit PCA coordinates. PCA is fitted on the training images and used for the map. The engine searches the original pixels. The dataset’s MIT license is included alongside the pack.

## Publish

The workflow in `.github/workflows/pages.yml` publishes pushes to `main`. Choose **GitHub Actions** as the Pages source in the repository settings. The workflow sets the base path for project Pages automatically. For a different GitHub account or custom domain, set `site` in `astro.config.mjs`.
