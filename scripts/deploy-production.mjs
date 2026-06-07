import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

loadDotEnv();

const frontendBuildDir = resolve(repoRoot, "apps/frontend/dist");
const frontendDeployDir = resolveDeployDirectory();
const pm2AppName = (process.env.PM2_APP_NAME ?? "budget-backend").trim();
const skipPm2Restart = process.env.DEPLOY_SKIP_PM2_RESTART === "true";

await run();

async function run() {
  runCommand("pnpm", ["build"]);
  await replaceDirectoryContents(frontendBuildDir, frontendDeployDir);
  if (!skipPm2Restart) {
    runCommand("pm2", ["restart", pm2AppName]);
  }
  console.log(`Deployment finished. Frontend synced to ${frontendDeployDir}${skipPm2Restart ? "" : ` and pm2 restarted ${pm2AppName}`}.`);
}

function runCommand(command, args) {
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
}

function resolveDeployDirectory() {
  const configuredPath = process.env.FRONTEND_DIST?.trim();
  if (!configuredPath) {
    throw new Error("FRONTEND_DIST is required in the environment or .env file.");
  }
  const absolutePath = isAbsolute(configuredPath) ? configuredPath : resolve(repoRoot, configuredPath);
  if (absolutePath === "/") {
    throw new Error("FRONTEND_DIST cannot be /.");
  }
  return absolutePath;
}

async function replaceDirectoryContents(sourceDir, targetDir) {
  if (!existsSync(sourceDir)) {
    throw new Error(`Frontend build output not found at ${sourceDir}.`);
  }

  await mkdir(targetDir, { recursive: true });
  const existingEntries = await readdir(targetDir);
  await Promise.all(existingEntries.map((entry) => rm(resolve(targetDir, entry), { force: true, recursive: true })));

  const sourceEntries = await readdir(sourceDir);
  await Promise.all(sourceEntries.map((entry) => cp(resolve(sourceDir, entry), resolve(targetDir, entry), { recursive: true })));
}

function loadDotEnv() {
  const envFile = process.env.ENV_FILE ?? ".env";
  const envPath = resolve(repoRoot, envFile);
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(rawValue);
  }
}

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
