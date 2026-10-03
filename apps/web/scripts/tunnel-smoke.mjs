import { chromium } from "playwright";

const baseUrl = process.env.EDGECHAT_SMOKE_URL;
if (!baseUrl) throw new Error("EDGECHAT_SMOKE_URL is required");

const suffix = Math.random().toString(36).slice(2, 10);
const alice = { name: `Alice ${suffix}` };
const bob = { name: `Bob ${suffix}` };
const firstMessage = `公网密文星河 ${suffix}`;
const reply = `已收到 ${suffix}`;
const savedMessage = `给自己的备忘 ${suffix}`;
const failures = [];
const optionalModelRequests = [];

function observe(page, label) {
  page.on("request", (request) => {
    if (/semantic-worker|huggingface|onnxruntime/i.test(request.url())) optionalModelRequests.push({ label, url: request.url() });
  });
  page.on("console", (message) => {
    const text = message.text();
    if ((message.type() === "error" || message.type() === "warning") && !text.includes("Service Worker") && !text.includes("service worker registration failed")) failures.push({ label, console: message.type(), text: text.slice(0, 1_000) });
  });
  page.on("response", async (response) => {
    if (response.status() < 400 || !response.url().includes("/api/")) return;
    let body = "";
    try { body = (await response.text()).slice(0, 1_000); } catch { /* response may be gone */ }
    failures.push({ label, status: response.status(), method: response.request().method(), url: response.url(), body });
  });
  page.on("pageerror", (error) => failures.push({ label, pageerror: error.message }));
}

async function register(page, account) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const displayName = page.getByLabel("显示名称");
  const startupTimeout = page.getByRole("heading", { name: "打开本机消息库用时过长", exact: true });
  await displayName.or(startupTimeout).waitFor({ state: "visible", timeout: 75_000 });
  if (await startupTimeout.isVisible()) {
    await page.getByRole("button", { name: "重新打开应用", exact: true }).click();
    await displayName.waitFor({ state: "visible", timeout: 75_000 });
  }
  await displayName.fill(account.name);
  const registration = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/register/opaque", { timeout: 120_000 });
  await page.getByRole("button", { name: "创建并继续", exact: true }).click();
  const response = await registration;
  if (!response.ok()) throw new Error(`registration failed with ${response.status()}: ${(await response.text()).slice(0, 1_000)}`);
  const session = await response.json();
  if (typeof session.user_id !== "string") throw new Error("registration response did not contain a user_id");
  account.username = session.user_id.replace(/^@/, "").split(":", 1)[0];
  await page.getByRole("heading", { name: "消息", exact: true }).waitFor({ timeout: 300_000 });
}

async function main() {
  // Treat each endpoint as a real device process so their browser storage,
  // Wasm runtime, crash lifecycle and resource limits remain independent.
  const [aliceBrowser, bobBrowser] = await Promise.all([
    chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true }),
    chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true }),
  ]);
  const aliceContext = await aliceBrowser.newContext({ serviceWorkers: "block" });
  const bobContext = await bobBrowser.newContext({ serviceWorkers: "block" });
  const alicePage = await aliceContext.newPage();
  const bobPage = await bobContext.newPage();
  observe(alicePage, "alice"); observe(bobPage, "bob");
  try {
    await register(alicePage, alice);
    await register(bobPage, bob);
    console.log(JSON.stringify({ step: "registered", alice: alice.username, bob: bob.username }));

    await alicePage.getByLabel("新建对话").click();
    await alicePage.getByLabel("搜索用户").fill(bob.username);
    await alicePage.getByRole("button", { name: new RegExp(bob.name) }).click();
    await alicePage.getByRole("button", { name: "开始对话", exact: true }).click();
    await alicePage.getByRole("dialog").waitFor({ state: "hidden", timeout: 120_000 });
    await alicePage.getByRole("textbox", { name: "消息", exact: true }).fill(firstMessage);
    await alicePage.getByRole("button", { name: "发送", exact: true }).click();
    await alicePage.getByText(firstMessage, { exact: true }).waitFor({ timeout: 120_000 });
    console.log(JSON.stringify({ step: "alice-sent" }));

    await bobPage.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
    await bobPage.getByText(alice.name, { exact: true }).first().click();
    // Pending requests intentionally hide the first plaintext until the
    // recipient accepts. Seeing the request after a reload proves durable
    // sync; accepting then projects/decrypts the event locally.
    await bobPage.getByText("接受后才能回复", { exact: true }).waitFor({ timeout: 120_000 });
    await bobPage.getByRole("button", { name: "接受", exact: true }).click();
    await bobPage.getByText(firstMessage, { exact: true }).waitFor({ timeout: 120_000 });
    console.log(JSON.stringify({ step: "bob-synced-and-decrypted" }));

    const bobComposer = bobPage.getByRole("textbox", { name: "消息", exact: true });
    await bobComposer.waitFor({ state: "visible", timeout: 120_000 });
    await bobComposer.fill(reply, { timeout: 120_000 });
    await bobPage.getByRole("button", { name: "发送", exact: true }).click();
    await bobPage.getByText(reply, { exact: true }).waitFor({ timeout: 120_000 });
    console.log(JSON.stringify({ step: "bob-replied" }));

    try { await alicePage.getByText(reply, { exact: true }).waitFor({ timeout: 15_000 }); }
    catch {
      await alicePage.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
      await alicePage.getByText(bob.name, { exact: true }).first().click();
      await alicePage.getByText(reply, { exact: true }).waitFor({ timeout: 120_000 });
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
    await savedEntry.click();
    await savedEntry.waitFor({ state: "hidden", timeout: 120_000 });
    await alicePage.getByText("仅你和你的设备可读", { exact: true }).first().waitFor({ timeout: 120_000 });
    const aliceComposer = alicePage.getByRole("textbox", { name: "消息", exact: true });
    await aliceComposer.fill(savedMessage, { timeout: 120_000 });
    await alicePage.getByRole("button", { name: "发送", exact: true }).click();
    await alicePage.getByText(savedMessage, { exact: true }).waitFor({ timeout: 120_000 });
    await alicePage.getByText(/· 已发送$/).waitFor({ timeout: 120_000 });
    console.log(JSON.stringify({ step: "saved-message-sent" }));
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
