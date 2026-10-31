import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API_TARGET = process.env.HC_API ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The Node server runs the engine directly from TypeScript via type
  // stripping, so Vite must not try to bundle server code — it only ever
  // follows imports from `index.html`.
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    strictPort: true,
    // Vite blocks unknown Host headers by default, which made `npm run dev`
    // unusable behind any tunnel or hosted preview ("Blocked request. This host
    // is not allowed."). The dev server is a local tool, and the API proxy below
    // is the only backend it can reach, so allowing the host is safe here.
    allowedHosts: true,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
