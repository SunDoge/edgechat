/// <reference lib="webworker" />

type DatabaseWorkerRequest = MessageEvent<unknown>;
type DatabaseWorkerHandler = (this: DedicatedWorkerGlobalScope, event: DatabaseWorkerRequest) => unknown;

const scope = self as DedicatedWorkerGlobalScope;
const queued: DatabaseWorkerRequest[] = [];

scope.onmessage = (event) => { queued.push(event); };
scope.postMessage({ id: 0, startup: "runtime-loading" });

// Loading PGlite pulls a sizeable Wasm binary and bootstrap data. A tiny
// loader can report that network progress is still alive before those static
// imports have evaluated, so the page does not confuse a slow first download
// with a wedged local database.
const heartbeat = setInterval(() => {
  scope.postMessage({ id: 0, startup: "runtime-loading" });
}, 10_000);

void import("./db-worker").then(() => {
  clearInterval(heartbeat);
  const handler = scope.onmessage as DatabaseWorkerHandler | null;
  if (!handler) throw new Error("Local database runtime did not install a request handler");
  scope.postMessage({ id: 0, startup: "runtime-ready" });
  for (const event of queued.splice(0)) handler.call(scope, event);
}).catch((cause) => {
  clearInterval(heartbeat);
  scope.postMessage({
    id: 0,
    startupError: cause instanceof Error ? cause.message : String(cause),
  });
  scope.close();
});
