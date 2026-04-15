import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  plugins: [solidPlugin(), tailwindcss()],
  server: {
    port: Number(process.env.WEB_PORT ?? 3000),
    proxy: {
      "/api": {
        target:
          process.env.BETTER_REVIEW_API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 3001}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "esnext",
  },
  // Ensure SPA routing works - all non-API routes serve index.html
  appType: "spa",
});
