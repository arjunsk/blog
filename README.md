# Arjun's portfolio and blog

A static Astro site with MDX posts and an interactive B+ tree visualization. TypeScript manages playback and the diagram, while a small Rust/WebAssembly module inserts keys and determines the split.

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
- Import Astro components into an MDX post to add interactive figures. See the B+ tree post for an example.

## Publish

The workflow in `.github/workflows/pages.yml` publishes pushes to `main`. Choose **GitHub Actions** as the Pages source in the repository settings. The workflow sets the base path for project Pages automatically. For a different GitHub account or custom domain, set `site` in `astro.config.mjs`.
