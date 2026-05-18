import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

const webPort = Number(process.env.WEB_PORT ?? 3000);
const apiPort = Number(process.env.API_PORT ?? 3001);
const apiTarget = process.env.BETTER_REVIEW_API_URL ?? `http://127.0.0.1:${apiPort}`;

if (!process.env.BETTER_REVIEW_API_URL && webPort === apiPort) {
  throw new Error("WEB_PORT and API_PORT must be different for the Vite dev proxy.");
}

export default defineConfig({
  plugins: [solidPlugin(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("error", (error) => {
            console.error(`[vite proxy] Could not reach API at ${apiTarget}: ${error.message}`);
          });
        },
      },
    },
  },
  build: {
    target: "esnext",
  },
  // Ensure SPA routing works - all non-API routes serve index.html
  appType: "spa",
});
