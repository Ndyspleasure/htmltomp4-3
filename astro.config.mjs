// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Static output only: all conversion work runs in the visitor's browser (see arsitektur.md §3).
export default defineConfig({
  output: 'static',
  build: {
    // Keep styles external so the CSP in vercel.json does not need 'unsafe-inline' for styles.
    inlineStylesheets: 'never',
  },
  vite: {
    plugins: [tailwindcss()],
    build: {
      // Never inline assets/scripts as data: URLs; keeps the CSP strict and output predictable.
      assetsInlineLimit: 0,
    },
    worker: {
      format: 'es',
    },
  },
  devToolbar: { enabled: false },
});
