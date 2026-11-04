import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireWeb = createRequire(new URL("../packages/web/package.json", import.meta.url));
const { default: solid } = await import(requireWeb.resolve("vite-plugin-solid"));
const { default: tailwind } = await import(requireWeb.resolve("@tailwindcss/vite"));

// Vite replaces optimized chunks when config changes. Sharing its default cache
// with dev (or another test run) leaves live diff workers importing missing files.
const cacheRoot = fileURLToPath(new URL("../node_modules/.cache/", import.meta.url));
mkdirSync(cacheRoot, { recursive: true });
const cacheDir = mkdtempSync(`${cacheRoot}better-review-browser-vite-`);
process.once("exit", () => rmSync(cacheDir, { recursive: true, force: true }));

// Deliberately do not extend the development config: no token file, env files or API proxy.
export default {
  root: fileURLToPath(new URL("../packages/web", import.meta.url)),
  cacheDir,
  envDir: false,
  optimizeDeps: { include: ["@pierre/diffs/worker/worker.js"] },
  plugins: [
    solid(),
    tailwind(),
    {
      name: "offline-browser-fonts",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith("/src/index.css"))
          return code.replace(/@import url\("https:\/\/fonts\.googleapis\.com[^"]+"\);/, "");
      },
    },
  ],
  define: {
    "import.meta.env.VITE_BETTER_REVIEW_API_TOKEN": JSON.stringify(""),
    "import.meta.env.VITE_TRPC_URL": JSON.stringify("/api/trpc"),
  },
  server: { host: "127.0.0.1", port: 0, watch: null, ws: false },
};
