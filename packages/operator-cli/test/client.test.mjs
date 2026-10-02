import assert from "node:assert/strict";
import test from "node:test";
import { OperatorClient } from "../src/client.mjs";
import { parseArguments, run } from "../src/cli.mjs";

test("parses finite and indefinite retention policies", () => {
  const env = { EDGECHAT_URL: "https://chat.example.com", EDGECHAT_OPERATOR_TOKEN: "secret" };
  assert.deepEqual(parseArguments(["retention", "!room:example.com", "--days", "30", "--minimum-device-copies", "2"], env), {
    command: "retention", baseUrl: env.EDGECHAT_URL, token: "secret", limit: 50, all: false,
    roomId: "!room:example.com", retentionDays: 30, minimumDeviceCopies: 2,
  });
  assert.equal(parseArguments(["retention", "!room:example.com", "--days", "indefinite"], env).retentionDays, null);
});

test("sends the operator token only as an authorization header", async () => {
  let captured;
  const client = new OperatorClient({
    baseUrl: "https://chat.example.com/", token: "operator-secret",
    fetchImpl: async (url, init) => { captured = { url, init }; return new Response(JSON.stringify({ rooms: [], next_cursor: null }), { headers: { "content-type": "application/json" } }); },
  });
  await client.rooms({ policy: "finite", limit: 10 });
  assert.equal(captured.url, "https://chat.example.com/api/v1/operator/rooms?limit=10&policy=finite");
  assert.equal(captured.init.headers.authorization, "Bearer operator-secret");
  assert.equal(captured.url.includes("operator-secret"), false);
});

test("fetches the D1-only readiness snapshot without pagination", async () => {
  const env = { EDGECHAT_URL: "https://chat.example.com", EDGECHAT_OPERATOR_TOKEN: "secret" };
  assert.deepEqual(parseArguments(["readiness"], env), {
    command: "readiness", baseUrl: env.EDGECHAT_URL, token: "secret", limit: 50, all: false,
  });
  assert.throws(() => parseArguments(["readiness", "--all"], env), /options are not valid/);
  let captured;
  const result = await run(parseArguments(["readiness"], env), async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ status: "healthy", storage_source: "d1_ledger" }));
  });
  assert.deepEqual(result, { status: "healthy", storage_source: "d1_ledger" });
  assert.equal(captured.url, "https://chat.example.com/api/v1/operator/readiness");
  assert.equal(captured.init.headers.authorization, "Bearer secret");
});

test("follows bounded room pagination when --all is requested", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const second = url.includes("cursor=");
    return new Response(JSON.stringify({ totals: { rooms: 2 }, rooms: [{ room_id: second ? "!b:test" : "!a:test" }], next_cursor: second ? null : "!a:test" }));
  };
  const report = await run({ command: "rooms", baseUrl: "https://chat.example.com", token: "secret", limit: 1, all: true, policy: "all" }, fetchImpl);
  assert.deepEqual(report.rooms.map((room) => room.room_id), ["!a:test", "!b:test"]);
  assert.equal(report.pages, 2);
  assert.equal(urls.length, 2);
});

test("rejects insecure remote operator URLs", () => {
  assert.throws(() => new OperatorClient({ baseUrl: "http://chat.example.com", token: "secret" }), /HTTPS/);
});

test("parses report review commands and rejects incomplete resolutions", () => {
  const env = { EDGECHAT_URL: "https://chat.example.com", EDGECHAT_OPERATOR_TOKEN: "secret" };
  assert.deepEqual(parseArguments(["reports", "--status", "open", "--all"], env), {
    command: "reports", baseUrl: env.EDGECHAT_URL, token: "secret", limit: 50, all: true, status: "open",
  });
  assert.deepEqual(parseArguments(["report", "report_0123456789", "--resolution", "dismissed", "--note", "insufficient evidence"], env), {
    command: "report", baseUrl: env.EDGECHAT_URL, token: "secret", limit: 50, all: false,
    reportId: "report_0123456789", resolution: "dismissed", note: "insufficient evidence",
  });
  assert.throws(() => parseArguments(["report", "report_0123456789"], env), /requires --resolution/);
});

test("paginates D1 reports and resolves one report without an R2 operation", async () => {
  const urls = []; const requests = [];
  const fetchImpl = async (url, init = {}) => {
    urls.push(url); requests.push(init);
    if (init.method === "PUT") return new Response(JSON.stringify({ report: { report_id: "report_b", status: "confirmed" } }));
    const second = url.includes("cursor=");
    return new Response(JSON.stringify({ reports: [{ report_id: second ? "report_b" : "report_a" }], next_cursor: second ? null : "report_a" }));
  };
  const listed = await run({ command: "reports", baseUrl: "https://chat.example.com", token: "secret", limit: 1, all: true, status: "open" }, fetchImpl);
  assert.deepEqual(listed.reports.map((report) => report.report_id), ["report_a", "report_b"]);
  assert.equal(urls.every((url) => url.includes("/api/v1/operator/reports")), true);
  const resolved = await run({ command: "report", reportId: "report_b", resolution: "confirmed", note: "repeat spam", baseUrl: "https://chat.example.com", token: "secret", limit: 50, all: false }, fetchImpl);
  assert.equal(resolved.report.status, "confirmed");
  assert.equal(requests.at(-1).method, "PUT");
  assert.deepEqual(JSON.parse(requests.at(-1).body), { resolution: "confirmed", note: "repeat spam" });
});

test("lists and clears login locks through explicit D1-only commands", async () => {
  const env = { EDGECHAT_URL: "https://chat.example.com", EDGECHAT_OPERATOR_TOKEN: "secret" };
  assert.deepEqual(parseArguments(["login-locks", "--status", "active", "--all"], env), {
    command: "login-locks", baseUrl: env.EDGECHAT_URL, token: "secret", limit: 50, all: true, status: "active",
  });
  assert.deepEqual(parseArguments(["login-unlock", "@alice:example.com", "--note", "verified owner"], env), {
    command: "login-unlock", baseUrl: env.EDGECHAT_URL, token: "secret", limit: 50, all: false,
    userId: "@alice:example.com", note: "verified owner",
  });
  assert.throws(() => parseArguments(["login-unlock", "@alice:example.com", "--all"], env), /pagination options/);
  assert.throws(() => parseArguments(["login-unlock"], env), /requires USER_ID/);

  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (init.method === "POST") return new Response(JSON.stringify({ user_id: "@alice:example.com", unlocked: true }));
    const second = url.includes("cursor=");
    return new Response(JSON.stringify({ locks: [{ user_id: second ? "@b:test" : "@a:test" }], next_cursor: second ? null : "@a:test" }));
  };
  const listed = await run({ command: "login-locks", baseUrl: env.EDGECHAT_URL, token: "secret", limit: 1, all: true, status: "active" }, fetchImpl);
  assert.deepEqual(listed.locks.map((lock) => lock.user_id), ["@a:test", "@b:test"]);
  const unlocked = await run({ command: "login-unlock", userId: "@alice:example.com", note: "verified owner", baseUrl: env.EDGECHAT_URL, token: "secret", limit: 50, all: false }, fetchImpl);
  assert.equal(unlocked.unlocked, true);
  assert.equal(requests.at(-1).url, "https://chat.example.com/api/v1/operator/users/%40alice%3Aexample.com/login-unlock");
  assert.deepEqual(JSON.parse(requests.at(-1).init.body), { note: "verified owner" });
});

test("paginates appeals and resolves an approved login-lock appeal", async () => {
  const env = { EDGECHAT_URL: "https://chat.example.com", EDGECHAT_OPERATOR_TOKEN: "secret" };
  assert.deepEqual(parseArguments(["appeals", "--status", "pending", "--all"], env), {
    command: "appeals", baseUrl: env.EDGECHAT_URL, token: "secret", limit: 50, all: true, status: "pending",
  });
  assert.deepEqual(parseArguments(["appeal", "appeal_0123456789abcdef", "--resolution", "approved", "--unlock-login", "--note", "verified"], env), {
    command: "appeal", baseUrl: env.EDGECHAT_URL, token: "secret", limit: 50, all: false,
    appealId: "appeal_0123456789abcdef", resolution: "approved", unlockLogin: true, note: "verified",
  });
  assert.throws(() => parseArguments(["appeal", "appeal_0123456789abcdef", "--resolution", "denied", "--unlock-login"], env), /approved appeal/);

  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (init.method === "PUT") return new Response(JSON.stringify({ appeal: { appeal_id: "appeal_b", status: "approved" } }));
    const second = url.includes("cursor=");
    return new Response(JSON.stringify({ appeals: [{ appeal_id: second ? "appeal_b" : "appeal_a" }], next_cursor: second ? null : "appeal_a" }));
  };
  const listed = await run({ command: "appeals", baseUrl: env.EDGECHAT_URL, token: "secret", limit: 1, all: true, status: "pending" }, fetchImpl);
  assert.deepEqual(listed.appeals.map((appeal) => appeal.appeal_id), ["appeal_a", "appeal_b"]);
  const resolved = await run({ command: "appeal", appealId: "appeal_b", resolution: "approved", unlockLogin: true, note: "verified", baseUrl: env.EDGECHAT_URL, token: "secret", limit: 50, all: false }, fetchImpl);
  assert.equal(resolved.appeal.status, "approved");
  assert.equal(requests.at(-1).url, "https://chat.example.com/api/v1/operator/appeals/appeal_b");
  assert.deepEqual(JSON.parse(requests.at(-1).init.body), { resolution: "approved", unlock_login: true, note: "verified" });
});
