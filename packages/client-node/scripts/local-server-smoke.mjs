#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const persistenceDirectory = await mkdtemp(join(tmpdir(), "edgechat-node-smoke-"));
const environment = { ...process.env, CI: "1", WRANGLER_HIDE_BANNER: "true", WRANGLER_SEND_METRICS: "false" };
let worker;

function output(chunks) { return Buffer.concat(chunks).toString("utf8").slice(-20_000); }

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const chunks = [];
    const child = spawn(command, args, { cwd: repositoryRoot, env: environment, stdio: ["ignore", "pipe", "pipe"], ...options });
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0 ? resolveRun(output(chunks)) : rejectRun(new Error(output(chunks))));
  });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local port");
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return address.port;
}

async function waitForWorker(baseUrl, chunks) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`Worker exited before readiness\n${output(chunks)}`);
    try { const response = await fetch(`${baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(2_000) }); if (response.ok) return; }
    catch { /* startup connection failures are expected */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Worker did not become ready\n${output(chunks)}`);
}

async function stopWorker() {
  if (!worker || worker.exitCode !== null) return;
  const exited = new Promise((resolveExit) => worker.once("exit", resolveExit));
  try { process.kill(-worker.pid, "SIGTERM"); } catch { worker.kill("SIGTERM"); }
  if (await Promise.race([exited.then(() => true), new Promise((resolveWait) => setTimeout(() => resolveWait(false), 5_000))])) return;
  try { process.kill(-worker.pid, "SIGKILL"); } catch { worker.kill("SIGKILL"); }
  await exited;
}

try {
  await run("pnpm", ["--filter", "@edgechat/worker", "exec", "wrangler", "d1", "migrations", "apply", "edgechat-db", "--local", "--persist-to", persistenceDirectory]);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const chunks = [];
  worker = spawn("pnpm", ["--filter", "@edgechat/worker", "exec", "wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persistenceDirectory, "--show-interactive-dev-session", "false", "--log-level", "warn"], {
    cwd: repositoryRoot, env: environment, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  worker.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await waitForWorker(baseUrl, chunks);
  const result = await run("pnpm", ["--filter", "@edgechat/client-node", "test:live"], { env: { ...environment, EDGECHAT_SERVER_URL: baseUrl } });
  process.stdout.write(result);
  console.log(JSON.stringify({ ok: true, client: "node", transport: "https-sync", plaintext_on_worker: false }));
} finally {
  await stopWorker();
  await rm(persistenceDirectory, { recursive: true, force: true });
}
