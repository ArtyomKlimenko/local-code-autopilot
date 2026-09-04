import { defineConfig } from "vite";

export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  server: { proxy: { "/api": "http://127.0.0.1:8766" } },
  build: { sourcemap: false },
});
