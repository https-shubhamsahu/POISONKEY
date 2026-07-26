import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    // @stellar/stellar-sdk reaches for a Node-style global in a few code paths.
    global: 'globalThis',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
