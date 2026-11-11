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
  await bob.page.getByRole("button", { name: "接受", exact: true }).click();
  await bob.page.getByRole("button", { name: "接受", exact: true }).waitFor({ state: "detached", timeout: 15_000 });

  await bob.page.reload();
  await bob.page.locator('header p[title^="@"]').waitFor({ timeout: 30_000 });
  await bob.page.getByText(alice.displayName, { exact: true }).click();
  await bob.page.getByText(text, { exact: true }).waitFor({ timeout: 20_000 });

  await bob.page.getByRole("button", { name: "搜索当前对话" }).click();
  await bob.page.getByLabel("关键词").fill("E2EE smoke");
  await bob.page.getByRole("button", { name: new RegExp(text) }).click();
  await bob.page.getByText(text, { exact: true }).waitFor({ timeout: 10_000 });

  const chooserPromise = alice.page.waitForEvent("filechooser");
  await alice.page.getByRole("button", { name: "添加附件" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "encrypted-proof.txt", mimeType: "text/plain", buffer: Buffer.from("attachment ciphertext smoke") });
  await alice.page.getByRole("button", { name: "发送" }).click();
  await bob.page.getByText("encrypted-proof.txt", { exact: true }).waitFor({ timeout: 20_000 });

  await bob.page.getByRole("button", { name: "已保存消息" }).click();
  await bob.page.getByRole("heading", { name: "已保存消息" }).waitFor({ timeout: 20_000 });
  const savedText = `Saved locally ${Date.now()}`;
  await bob.page.getByLabel("消息输入").fill(savedText);
  await bob.page.getByRole("button", { name: "发送" }).click();
  await bob.page.getByText(savedText, { exact: true }).waitFor({ timeout: 15_000 });
  console.log(JSON.stringify({ ok: true, alice: alice.userId, bob: bob.userId, text }));
} catch (error) {
  for (const [index, context] of contexts.entries()) {
    const page = context.pages()[0];
    if (page) console.error(`[context-${index}] ${await page.locator("body").innerText().catch(() => "unavailable")}`);
  }
  throw error;
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
