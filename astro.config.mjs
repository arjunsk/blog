import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

export default defineConfig({
  site: 'https://arjunsk.github.io',
  base: process.env.SITE_BASE ?? '/',
  integrations: [mdx()],
  vite: { build: { license: { fileName: 'third-party-licenses.txt' } } },
  devToolbar: { enabled: false },
});
