import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Fixed port/host/base so the platform dev-server proxy and the installed
// static bundle both resolve correctly. usePolling is required: inotify support
// in the workspace runtime is unreliable, so file watching must poll or HMR
// will not fire.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    watch: { usePolling: true },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
