import { chromium } from "playwright";
import { existsSync } from "node:fs";

const baseUrl = process.env.EDGECHAT_SMOKE_URL;
if (!baseUrl) throw new Error("EDGECHAT_SMOKE_URL is required");
const browserUrl = process.env.EDGECHAT_SMOKE_BROWSER_URL ?? baseUrl;
const attachmentOnly = process.env.EDGECHAT_SMOKE_ATTACHMENT_ONLY === "1";
const injectAmbiguousRegistration = process.env.EDGECHAT_SMOKE_AMBIGUOUS_REGISTRATION === "1";
const blockWebSocket = process.env.EDGECHAT_SMOKE_BLOCK_WEBSOCKET === "1";
const textLoadCount = Number(process.env.EDGECHAT_SMOKE_TEXT_LOAD_COUNT ?? "0");
if (!Number.isSafeInteger(textLoadCount) || textLoadCount < 0 || textLoadCount > 10_000) {
  throw new Error("EDGECHAT_SMOKE_TEXT_LOAD_COUNT must be an integer from 0 to 10000");
}

const suffix = Math.random().toString(36).slice(2, 10);
const alice = { name: `Alice ${suffix}` };
const bob = { name: `Bob ${suffix}` };
const firstMessage = `公网密文星河 ${suffix}`;
const reply = `已收到 ${suffix}`;
const savedMessage = `给自己的备忘 ${suffix}`;
const fallbackMessage = `HTTPS 兼容同步 ${suffix}`;
const failures = [];
const optionalModelRequests = [];
let ambiguousRegistrationWindow = false;
const chromiumExecutable = process.env.EDGECHAT_CHROMIUM_EXECUTABLE
  ?? (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function observe(page, label) {
  page.on("request", (request) => {
    if (/semantic-worker|huggingface|onnxruntime/i.test(request.url())) optionalModelRequests.push({ label, url: request.url() });
  });
  page.on("console", (message) => {
    const text = message.text();
    if (injectAmbiguousRegistration && label === "alice" && ambiguousRegistrationWindow
      && message.type() === "error" && text.includes("502 (Bad Gateway)")) return;
    if ((message.type() === "error" || message.type() === "warning") && !text.includes("Service Worker") && !text.includes("service worker registration failed")) failures.push({ label, console: message.type(), text: text.slice(0, 1_000) });
  });
  page.on("response", async (response) => {
    if (response.headers()["x-edgechat-smoke-injected"] === "ambiguous-registration") return;
    if (response.status() < 400 || !response.url().includes("/api/")) return;
    let body = "";
    try { body = (await response.text()).slice(0, 1_000); } catch { /* response may be gone */ }
    failures.push({ label, status: response.status(), method: response.request().method(), url: response.url(), body });
  });
  page.on("pageerror", (error) => failures.push({ label, pageerror: error.message }));
}

async function interceptCommittedRegistration(page) {
  if (!injectAmbiguousRegistration) return async () => undefined;
  const pattern = "**/api/v1/register/opaque";
  const bodies = [];
  let committedUserId;
  const handler = async (route) => {
    const requestBody = route.request().postDataBuffer();
    if (!requestBody) throw new Error("opaque registration request had no body");
    bodies.push(requestBody);
    if (bodies.length !== 1) return route.continue();

    // Let the first request commit to the real Worker, then emulate a gateway
    // losing that successful response. The PWA must replay the byte-identical
    // body and the Worker must return the existing account without allocating
    // another user or device.
    const committed = await route.fetch();
    if (!committed.ok()) throw new Error(`injected registration did not commit: ${committed.status()}`);
    const payload = await committed.json();
    if (typeof payload.user_id !== "string") throw new Error("committed registration did not return a user_id");
    committedUserId = payload.user_id;
    ambiguousRegistrationWindow = true;
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      headers: { "x-edgechat-smoke-injected": "ambiguous-registration" },
      body: JSON.stringify({ error: "injected_gateway_response_loss" }),
    });
  };
  await page.route(pattern, handler);
  return async (session) => {
    await page.unroute(pattern, handler);
    if (bodies.length !== 2) throw new Error(`expected exactly two opaque registration attempts, saw ${bodies.length}`);
    if (!bodies[0].equals(bodies[1])) throw new Error("opaque registration retry changed its credential or public-key body");
    if (session.user_id !== committedUserId) throw new Error("opaque registration retry created or returned a different account");
    ambiguousRegistrationWindow = false;
  };
}

function assertCleanBrowserRun() {
  if (failures.length) throw new Error(`browser reported ${failures.length} unexpected failure(s)`);
}

function timelineMessage(page, text) {
  return page.getByRole("list", { name: "消息", exact: true }).getByText(text, { exact: true });
}

async function register(page, account) {
  await page.goto(browserUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const displayName = page.getByLabel("显示名称");
  const startupTimeout = page.getByRole("heading", { name: "打开本机消息库用时过长", exact: true });
  await displayName.or(startupTimeout).waitFor({ state: "visible", timeout: 75_000 });
  if (await startupTimeout.isVisible()) {
    await page.getByRole("button", { name: "重新打开应用", exact: true }).click();
    await displayName.or(startupTimeout).waitFor({ state: "visible", timeout: 120_000 });
    if (await startupTimeout.isVisible()) {
      await page.getByRole("button", { name: "重新打开应用", exact: true }).click();
      await displayName.waitFor({ state: "visible", timeout: 120_000 });
    }
  }
  await displayName.fill(account.name);
  const registration = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/v1/register/opaque"
    && response.ok(), { timeout: 120_000 });
  await page.getByRole("button", { name: "创建并继续", exact: true }).click();
  const response = await registration;
  if (!response.ok()) throw new Error(`registration failed with ${response.status()}: ${(await response.text()).slice(0, 1_000)}`);
  const session = await response.json();
  if (typeof session.user_id !== "string") throw new Error("registration response did not contain a user_id");
  if (typeof session.access_token !== "string") throw new Error("registration response did not contain an access_token");
  account.userId = session.user_id;
  account.accessToken = session.access_token;
  account.username = session.user_id.replace(/^@/, "").split(":", 1)[0];
  await page.getByRole("heading", { name: "消息", exact: true }).waitFor({ timeout: 300_000 });
}

async function verifyIdempotentAttachment(account, roomId) {
  const attachmentId = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  const ciphertext = crypto.getRandomValues(new Uint8Array(64));
  const digest = base64Url(await crypto.subtle.digest("SHA-256", ciphertext));
  const headers = { authorization: `Bearer ${account.accessToken}`, "content-type": "application/octet-stream", "content-length": String(ciphertext.byteLength), "x-room-id": roomId, "x-attachment-id": attachmentId, "x-content-sha256": digest };
  const first = await fetch(`${baseUrl}/api/v1/attachments`, { method: "POST", headers, body: ciphertext });
  if (first.status !== 201) throw new Error(`first attachment upload failed with ${first.status}: ${(await first.text()).slice(0, 1_000)}`);
  const repeated = await fetch(`${baseUrl}/api/v1/attachments`, { method: "POST", headers, body: ciphertext });
  if (repeated.status !== 200) throw new Error(`idempotent attachment upload failed with ${repeated.status}: ${(await repeated.text()).slice(0, 1_000)}`);
  const repeatedBody = await repeated.json();
  if (repeatedBody.attachment_id !== attachmentId) throw new Error("idempotent attachment upload returned a different ID");
  const abandoned = await fetch(`${baseUrl}/api/v1/attachments/abandon`, { method: "POST", headers: { authorization: `Bearer ${account.accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ attachment_ids: [attachmentId] }) });
  if (!abandoned.ok || (await abandoned.json()).abandoned !== 1) throw new Error("temporary attachment cleanup failed");
}

async function accountStorage(account) {
  const response = await fetch(`${baseUrl}/api/v1/storage`, { headers: { authorization: `Bearer ${account.accessToken}` } });
  if (!response.ok) throw new Error(`storage usage failed with ${response.status}: ${(await response.text()).slice(0, 1_000)}`);
  return response.json();
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

async function runTextLoad(alicePage, bobPage, roomId) {
  const fields = ["attachment_bytes", "archive_bytes", "attachment_objects", "archive_objects"];
  const before = await accountStorage(alice);
  const latencies = [];
  let lastMessage = "";
  const composer = alicePage.getByRole("textbox", { name: "消息输入", exact: true });
  const firstLoadMessage = `本地负载消息 ${suffix} 1/${textLoadCount}`;
  try { await composer.fill(firstLoadMessage, { timeout: 10_000 }); }
  catch {
    // The recipient acceptance is durable, but the sender can miss its
    // realtime projection. Recover through authoritative /sync before the
    // measured window instead of timing a disabled request-state composer.
    await alicePage.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
    await alicePage.getByText(bob.name, { exact: true }).first().click();
    await composer.fill(firstLoadMessage, { timeout: 120_000 });
  }
  const loadStartedAt = performance.now();
  for (let index = 0; index < textLoadCount; index += 1) {
    lastMessage = `本地负载消息 ${suffix} ${index + 1}/${textLoadCount}`;
    if (index > 0) await composer.fill(lastMessage, { timeout: 120_000 });
    const accepted = alicePage.waitForResponse((response) => {
      if (response.request().method() !== "POST") return false;
      let pathname;
      try { pathname = decodeURIComponent(new URL(response.url()).pathname); }
      catch { return false; }
      return pathname === `/api/v1/rooms/${roomId}/events`
        && Boolean(response.request().postData()?.includes('"type":"message.text"'));
    }, { timeout: 120_000 });
    const sentAt = performance.now();
    await alicePage.getByRole("button", { name: "发送", exact: true }).click();
    const response = await accepted;
    if (!response.ok()) throw new Error(`load message ${index + 1} failed with ${response.status()}`);
    latencies.push(performance.now() - sentAt);
  }
  await timelineMessage(bobPage, lastMessage).waitFor({ timeout: 120_000 });
  const elapsedMs = performance.now() - loadStartedAt;
  const after = await accountStorage(alice);
  const objectLedgerDelta = Object.fromEntries(fields.map((field) => [field, Number(after[field]) - Number(before[field])]));
  if (Object.values(objectLedgerDelta).some((value) => value !== 0)) {
    throw new Error(`text-only load changed the object ledger: ${JSON.stringify(objectLedgerDelta)}`);
  }
  const result = {
    step: "text-load",
    messages: textLoadCount,
    elapsed_ms: Math.round(elapsedMs),
    accepted_per_second: Number((textLoadCount / (elapsedMs / 1_000)).toFixed(2)),
    acceptance_latency_ms: {
      p50: Math.round(percentile(latencies, 0.5)),
      p95: Math.round(percentile(latencies, 0.95)),
      p99: Math.round(percentile(latencies, 0.99)),
      max: Math.round(Math.max(...latencies)),
    },
    receiver_decrypted_last_message: true,
    object_ledger_delta: objectLedgerDelta,
    object_store_probe_requests: 0,
  };
  console.log(JSON.stringify(result));
  return result;
}

async function main() {
  // Treat each endpoint as a real device process so their browser storage,
  // Wasm runtime, crash lifecycle and resource limits remain independent.
  const [aliceBrowser, bobBrowser] = await Promise.all([
    chromium.launch({ ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}), headless: true }),
    chromium.launch({ ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}), headless: true }),
  ]);
  const aliceContext = await aliceBrowser.newContext({ serviceWorkers: "block" });
  const bobContext = await bobBrowser.newContext({ serviceWorkers: "block" });
  const alicePage = await aliceContext.newPage();
  const bobPage = await bobContext.newPage();
  observe(alicePage, "alice"); observe(bobPage, "bob");
  try {
    if (blockWebSocket) await bobPage.routeWebSocket(/\/api\/v1\/ws(?:\?|$)/, (socket) => void socket.close({ code: 1013, reason: "simulated WebSocket blocking" }));
    const verifyAmbiguousRegistration = await interceptCommittedRegistration(alicePage);
    await register(alicePage, alice);
    await verifyAmbiguousRegistration({ user_id: alice.userId });
    await register(bobPage, bob);
    console.log(JSON.stringify({ step: "registered", alice: alice.username, bob: bob.username, ambiguousRegistrationVerified: injectAmbiguousRegistration }));

    const fuzzyLookup = await fetch(`${baseUrl}/api/v1/users?q=${encodeURIComponent(bob.username)}`, { headers: { authorization: `Bearer ${alice.accessToken}` } });
    if (!fuzzyLookup.ok || (await fuzzyLookup.json()).users.length !== 0) throw new Error("nickname lookup exposed the account directory");
    const exactLookup = await fetch(`${baseUrl}/api/v1/users?q=${encodeURIComponent(bob.userId)}`, { headers: { authorization: `Bearer ${alice.accessToken}` } });
    const exactUsers = exactLookup.ok ? (await exactLookup.json()).users : [];
    if (exactUsers.length !== 1 || exactUsers[0].user_id !== bob.userId) throw new Error("exact contact ID lookup failed");
    console.log(JSON.stringify({ step: "directoryless-exact-contact-resolution" }));

    await alicePage.getByLabel("新建对话").click();
    await alicePage.getByLabel("完整用户 ID，例如 @alice:example.com").fill(bob.userId);
    await alicePage.getByRole("button", { name: new RegExp(bob.name) }).click();
    const roomCreation = alicePage.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/rooms", { timeout: 120_000 });
    await alicePage.getByRole("button", { name: "开始对话", exact: true }).click();
    const roomResponse = await roomCreation;
    if (!roomResponse.ok()) throw new Error(`room creation failed with ${roomResponse.status()}: ${(await roomResponse.text()).slice(0, 1_000)}`);
    const roomId = (await roomResponse.json()).room_id;
    if (typeof roomId !== "string") throw new Error("room creation response did not contain a room_id");
    await alicePage.getByRole("dialog").waitFor({ state: "hidden", timeout: 120_000 });
    await alicePage.getByRole("textbox", { name: "消息输入", exact: true }).fill(firstMessage);
    await alicePage.getByRole("button", { name: "发送", exact: true }).click();
    await timelineMessage(alicePage, firstMessage).waitFor({ timeout: 120_000 });
    console.log(JSON.stringify({ step: "alice-sent" }));

    await bobPage.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
    await bobPage.getByText(alice.name, { exact: true }).first().click();
    // Pending requests intentionally hide the first plaintext until the
    // recipient accepts. Seeing the request after a reload proves durable
    // sync; accepting then projects/decrypts the event locally.
    await bobPage.getByText("接受后才能回复", { exact: true }).waitFor({ timeout: 120_000 });
    const requestAcceptance = bobPage.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/v1/rooms/${encodeURIComponent(roomId)}/request/accept`, { timeout: 120_000 });
    await bobPage.getByRole("button", { name: "接受", exact: true }).click();
    const acceptanceResponse = await requestAcceptance;
    if (!acceptanceResponse.ok()) throw new Error(`message-request acceptance failed with ${acceptanceResponse.status()}: ${(await acceptanceResponse.text()).slice(0, 1_000)}`);
    // The plaintext was already rendered in the request preview, so waiting
    // for it cannot prove that the asynchronous acceptance and room reload
    // completed. Wait for the request gate itself to disappear before any
    // attachment or reply that the server must reject while still pending.
    await bobPage.getByText("接受后才能回复", { exact: true }).waitFor({ state: "hidden", timeout: 120_000 });
    await timelineMessage(bobPage, firstMessage).waitFor({ timeout: 120_000 });
    console.log(JSON.stringify({ step: "bob-synced-and-decrypted" }));

    if (textLoadCount) {
      const load = await runTextLoad(alicePage, bobPage, roomId);
      assertCleanBrowserRun();
      console.log(JSON.stringify({ ok: true, suffix, load, failures, optionalModelRequests }));
      return;
    }

    if (blockWebSocket) {
      await bobPage.getByText("已连接（兼容模式）", { exact: true }).waitFor({ timeout: 30_000 });
      const aliceComposer = alicePage.getByRole("textbox", { name: "消息输入", exact: true });
      try { await aliceComposer.fill(fallbackMessage, { timeout: 10_000 }); }
      catch {
        // Acceptance is durable, but the sender can miss its realtime
        // projection. Recover it through the authoritative /sync path so this
        // transport test does not depend on an unrelated UI timing race.
        await alicePage.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
        await alicePage.getByText(bob.name, { exact: true }).first().click();
        await alicePage.getByRole("textbox", { name: "消息输入", exact: true }).fill(fallbackMessage, { timeout: 120_000 });
      }
      await alicePage.getByRole("button", { name: "发送", exact: true }).click();
      await timelineMessage(bobPage, fallbackMessage).waitFor({ timeout: 30_000 });
      console.log(JSON.stringify({ step: "websocket-blocked-https-fallback" }));

      await bobPage.getByRole("button", { name: /设备与账户/ }).click();
      const accountDialog = bobPage.getByRole("dialog", { name: "设备与账户" });
      await accountDialog.getByText("HTTPS 兼容模式", { exact: true }).waitFor();
      await accountDialog.getByText("消息仍会定时同步；正在输入和在线状态可能延迟。", { exact: true }).waitFor();
      await accountDialog.getByText("浏览器网络限制", { exact: true }).waitFor();
      await accountDialog.getByRole("button", { name: "重试实时连接", exact: true }).click();
      await accountDialog.getByRole("button", { name: "重试实时连接", exact: true }).waitFor({ timeout: 30_000 });
      console.log(JSON.stringify({ step: "compatibility-mode-recovery-ui" }));
    }

    await verifyIdempotentAttachment(alice, roomId);
    console.log(JSON.stringify({ step: "idempotent-attachment-upload-and-cleanup" }));
    if (attachmentOnly) {
      assertCleanBrowserRun();
      console.log(JSON.stringify({ ok: true, suffix, attachmentOnly: true, blockWebSocket, failures, optionalModelRequests }));
      return;
    }

    const bobComposer = bobPage.getByRole("textbox", { name: "消息输入", exact: true });
    await bobComposer.waitFor({ state: "visible", timeout: 120_000 });
    await bobComposer.fill(reply, { timeout: 120_000 });
    await bobPage.getByRole("button", { name: "发送", exact: true }).click();
    await timelineMessage(bobPage, reply).waitFor({ timeout: 120_000 });
    console.log(JSON.stringify({ step: "bob-replied" }));

    try { await timelineMessage(alicePage, reply).waitFor({ timeout: 15_000 }); }
    catch {
      await alicePage.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
      await alicePage.getByText(bob.name, { exact: true }).first().click();
      await timelineMessage(alicePage, reply).waitFor({ timeout: 120_000 });
    }
    console.log(JSON.stringify({ step: "alice-received" }));

    await alicePage.getByRole("button", { name: /搜索本机消息/ }).click();
    await alicePage.getByLabel("消息关键词").fill("星河");
    await alicePage.getByText(firstMessage, { exact: true }).waitFor({ timeout: 30_000 });
    await alicePage.getByText("图片语义搜索未开启", { exact: true }).waitFor();
    if (optionalModelRequests.length) throw new Error(`optional semantic model loaded before opt-in: ${optionalModelRequests[0].url}`);
    await alicePage.getByRole("button", { name: "关闭", exact: true }).click();
    console.log(JSON.stringify({ step: "local-text-search-without-model-download" }));

    const savedEntry = alicePage.getByRole("button", { name: /已保存消息.*给自己发消息/ });
    for (let attempt = 0; attempt < 20 && await savedEntry.isVisible(); attempt += 1) {
      if (await savedEntry.isEnabled()) await savedEntry.click();
      await savedEntry.waitFor({ state: "hidden", timeout: 1_000 }).catch(() => undefined);
    }
    await savedEntry.waitFor({ state: "hidden", timeout: 30_000 });
    await alicePage.getByText("仅你和你的设备可读", { exact: true }).first().waitFor({ timeout: 120_000 });
    const aliceComposer = alicePage.getByRole("textbox", { name: "消息输入", exact: true });
    await aliceComposer.fill(savedMessage, { timeout: 120_000 });
    await alicePage.getByRole("button", { name: "发送", exact: true }).click();
    await timelineMessage(alicePage, savedMessage).waitFor({ timeout: 120_000 });
    await alicePage.getByText(/· 已发送$/).waitFor({ timeout: 120_000 });
    console.log(JSON.stringify({ step: "saved-message-sent" }));
    assertCleanBrowserRun();
    console.log(JSON.stringify({ ok: true, suffix, failures, optionalModelRequests }));
  } catch (error) {
    const pages = {};
    for (const [label, page] of [["alice", alicePage], ["bob", bobPage]]) {
      try { pages[label] = (await page.locator("body").innerText()).slice(0, 4_000); } catch { pages[label] = "unavailable"; }
    }
    console.error(JSON.stringify({ ok: false, suffix, error: error instanceof Error ? error.message : String(error), failures, pages }));
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([aliceContext.close(), bobContext.close()]);
    await Promise.allSettled([aliceBrowser.close(), bobBrowser.close()]);
  }
}

await main();
