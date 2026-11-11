import { chromium } from "playwright";

const baseUrl = process.env.EDGECHAT_WEB_URL ?? "http://localhost:5174";
const browser = await chromium.launch({ headless: true });
const contexts = [];

function observe(page, label) {
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`[${label}:console] ${message.text()}`);
  });
  page.on("pageerror", (error) => console.error(`[${label}:page] ${error.stack ?? error.message}`));
}

async function register(displayName) {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  observe(page, displayName);
  await page.goto(baseUrl);
  await page.getByLabel("显示名称").fill(displayName);
  await page.getByRole("button", { name: "创建账户" }).click();
  const identity = page.locator('header p[title^="@"]');
  await identity.waitFor({ state: "visible", timeout: 30_000 });
  return { page, userId: await identity.getAttribute("title"), displayName };
}

try {
  const alice = await register(`Alice-${Date.now()}`);
  const bob = await register(`Bob-${Date.now()}`);
  if (!alice.userId || !bob.userId) throw new Error("Registration did not expose account identifiers");

  await alice.page.getByRole("button", { name: "新建对话" }).click();
  await alice.page.getByLabel("查找用户").fill(bob.userId);
  await alice.page.getByText(bob.userId, { exact: true }).waitFor({ timeout: 15_000 });
  await alice.page.getByRole("button", { name: /添加$/ }).click();
  await alice.page.getByRole("button", { name: "开始聊天" }).click();

  const text = `React E2EE smoke ${Date.now()}`;
  await alice.page.getByLabel("消息输入").fill(text);
  await alice.page.getByRole("button", { name: "发送" }).click();
  await alice.page.getByText(text, { exact: true }).waitFor({ timeout: 15_000 });

  await bob.page.getByText(alice.displayName, { exact: true }).waitFor({ timeout: 20_000 });
  await bob.page.getByText(alice.displayName, { exact: true }).click();
  await bob.page.getByText(text, { exact: true }).waitFor({ timeout: 20_000 });

  await bob.page.reload();
  await bob.page.locator('header p[title^="@"]').waitFor({ timeout: 30_000 });
  await bob.page.getByText(alice.displayName, { exact: true }).click();
  await bob.page.getByText(text, { exact: true }).waitFor({ timeout: 20_000 });
  console.log(JSON.stringify({ ok: true, alice: alice.userId, bob: bob.userId, text }));
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
