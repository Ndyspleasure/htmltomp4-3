import { defineConfig } from 'vite';

/**
 * Builds the sandbox loader (src/sandbox/loader.ts) as a single classic script. It must be a classic
 * script because the sandbox page runs in an opaque origin, where module scripts would need CORS.
 * Output is generated (git-ignored) and copied by Astro from public/ into the final build.
 */
export default defineConfig({
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir: 'public/generated',
    emptyOutDir: true,
    target: 'es2020',
    minify: true,
    sourcemap: false,
    lib: {
      entry: 'src/sandbox/loader.ts',
      formats: ['iife'],
      name: 'H2MSandboxLoader',
      fileName: () => 'sandbox-loader.js',
    },
  },
});
