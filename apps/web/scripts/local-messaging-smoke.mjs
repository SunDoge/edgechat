#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(webRoot, "../..");
const persistenceDirectory = await mkdtemp(join(tmpdir(), "edgechat-messaging-smoke-"));
const childEnvironment = { ...process.env, CI: "1", WRANGLER_HIDE_BANNER: "true", WRANGLER_SEND_METRICS: "false" };
const loadMode = process.argv.includes("--load");
const loadMessages = Number(process.env.EDGECHAT_LOAD_MESSAGES ?? (loadMode ? "100" : "0"));
if (!Number.isSafeInteger(loadMessages) || loadMessages < 0 || loadMessages > 10_000) {
  throw new Error("EDGECHAT_LOAD_MESSAGES must be an integer from 0 to 10000");
}
let worker;
let workerSpawnError;

function commandOutput(chunks) {
  return Buffer.concat(chunks).toString("utf8").slice(-20_000);
}

function run(command, args, options = {}) {
  const { quiet = false, ...spawnOptions } = options;
  return new Promise((resolveRun, rejectRun) => {
    const output = [];
    const child = spawn(command, args, { cwd: repositoryRoot, env: childEnvironment, stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit", ...spawnOptions });
    child.stdout?.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}${quiet ? `\n${commandOutput(output)}` : ""}`));
    });
  });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local messaging-smoke port");
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return address.port;
}

async function waitForWorker(baseUrl, output, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (workerSpawnError) throw new Error(`Local Worker could not start: ${workerSpawnError.message}\n${commandOutput(output)}`, { cause: workerSpawnError });
    if (worker.exitCode !== null || worker.signalCode !== null) {
      throw new Error(`Local Worker exited before readiness\n${commandOutput(output)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch { /* startup connection failures are expected */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Local Worker did not become ready within ${timeoutMs}ms\n${commandOutput(output)}`);
}

async function stopWorker() {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
  const exited = new Promise((resolveExit) => worker.once("exit", resolveExit));
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  try {
    if (process.platform === "win32") worker.kill("SIGTERM");
    else process.kill(-worker.pid, "SIGTERM");
  } catch { worker.kill("SIGTERM"); }
  const stopped = await Promise.race([exited.then(() => true), new Promise((resolveWait) => setTimeout(() => resolveWait(false), 5_000))]);
  if (stopped) return;
  try {
    if (process.platform === "win32") worker.kill("SIGKILL");
    else process.kill(-worker.pid, "SIGKILL");
  } catch { worker.kill("SIGKILL"); }
  await exited;
}

try {
  await run("pnpm", ["--filter", "@edgechat/worker", "exec", "wrangler", "d1", "migrations", "apply", "edgechat-db", "--local", "--persist-to", persistenceDirectory], { quiet: true });
  console.log(JSON.stringify({ step: "isolated-local-migrations-applied" }));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const workerOutput = [];
  worker = spawn("pnpm", ["--filter", "@edgechat/worker", "exec", "wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persistenceDirectory, "--show-interactive-dev-session", "false", "--log-level", "warn"], {
    cwd: repositoryRoot,
    env: childEnvironment,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout.on("data", (chunk) => workerOutput.push(Buffer.from(chunk)));
  worker.stderr.on("data", (chunk) => workerOutput.push(Buffer.from(chunk)));
  worker.once("error", (error) => { workerSpawnError = error; });
  await waitForWorker(baseUrl, workerOutput);
  try {
    await run("pnpm", ["--filter", "@edgechat/web", "smoke:tunnel"], {
      env: {
        ...childEnvironment,
        EDGECHAT_SMOKE_URL: baseUrl,
        EDGECHAT_SMOKE_BROWSER_URL: baseUrl,
        EDGECHAT_SMOKE_AMBIGUOUS_REGISTRATION: loadMessages ? "0" : "1",
        EDGECHAT_SMOKE_TEXT_LOAD_COUNT: String(loadMessages),
      },
    });
  } catch (cause) {
    throw new Error(`${cause instanceof Error ? cause.message : String(cause)}\nLocal Worker output:\n${commandOutput(workerOutput)}`, { cause });
  }
  console.log(JSON.stringify({ ok: true, isolated: true, loadMessages, remoteObjectRequests: 0 }));
} finally {
  await stopWorker();
  await rm(persistenceDirectory, { recursive: true, force: true });
}
