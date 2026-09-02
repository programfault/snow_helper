import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

// Vite config for the SRE Helper Chrome extension.
// - @crxjs/vite-plugin compiles the MV3 manifest and hot-reloads content
//   scripts and the service worker during development.
// - Output is written to ./dist and can be loaded as an unpacked extension.
export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome110',
    rollupOptions: {
      // CRXJS auto-processes HTML referenced from manifest fields
      // (action/options/background). The panel iframe is referenced only
      // from web_accessible_resources, so it must be declared as an
      // explicit Rollup input to get its <script src="./panel.ts">
      // bundled into hashed JS assets.
      input: {
        panel: 'src/panel/index.html',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
});
