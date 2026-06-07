import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const appBasePath = normalizeBasePath(env.VITE_APP_BASE_PATH ?? "/");
  const proxyBase = appBasePath === "/" ? "" : appBasePath;

  return {
    base: `${appBasePath === "/" ? "" : appBasePath}/`,
    envDir: repoRoot,
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        [`${proxyBase}/api`]: "http://localhost:4000",
        [`${proxyBase}/mcp`]: "http://localhost:4000",
        [`${proxyBase}/.well-known`]: "http://localhost:4000",
      },
    },
  };
});

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/g, "") || "/";
}
