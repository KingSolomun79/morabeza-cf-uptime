import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  build: {
    // Main bundle ~505 kB (145 kB gzip) with the full UI era landed; the
    // Recharts-heavy detail page is already a separate lazy chunk. The
    // default 500 kB warning is advisory — documented rather than muted.
    chunkSizeWarningLimit: 600,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
