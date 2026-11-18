import { chromium } from "playwright";
import assert from "node:assert/strict";

const baseUrl = process.env.EDGECHAT_WEB_URL ?? "http://localhost:5174";
const browser = await chromium.launch({ headless: true });
const contexts = [];

function observe(page, label) {
  page.on("response", async (response) => {
    if (response.status() >= 400 && new URL(response.url()).pathname.startsWith("/api/v1/device-links/")) {
      const body = await response.json().catch(() => ({}));
      console.error(`[${label}:pairing] ${response.status()} ${body.code ?? ""} ${body.message ?? ""}`);
    }
  });
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
  const inputBox = await alice.page.getByLabel("消息输入").boundingBox();
  const sendBox = await alice.page.getByRole("button", { name: "发送", exact: true }).boundingBox();
  assert.ok(inputBox && sendBox);
  assert.equal(inputBox.height, sendBox.height);
  assert.equal(inputBox.y, sendBox.y);
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

  const linkedContext = await browser.newContext();
  contexts.push(linkedContext);
  const linked = await linkedContext.newPage();
  observe(linked, "linked");
  await linked.goto(baseUrl);
  await linked.getByRole("button", { name: "添加这台设备到已有账户" }).click();
  const createdLink = linked.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/device-links");
  await linked.getByRole("button", { name: "生成配对二维码" }).click();
  const qr = linked.getByRole("img", { name: "设备配对二维码" });
  await qr.waitFor();
  await qr.evaluate((image) => image.decode());
  const { link_id: linkId } = await (await createdLink).json();
  const code = await linked.locator("code").first().textContent({ timeout: 30_000 });
  assert.match(code ?? "", /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  await bob.page.evaluate((id) => { location.hash = `pair-device=${id}`; }, linkId);
  const pairingInput = bob.page.getByLabel("新设备配对码");
  await pairingInput.waitFor();
  assert.equal(await pairingInput.inputValue(), linkId);
  await pairingInput.fill(code.toLowerCase());
  await bob.page.getByRole("button", { name: "查看配对请求" }).click();
  await bob.page.getByRole("button", { name: "指纹一致，批准设备" }).click();
  await bob.page.getByText(/设备已批准/).waitFor({ timeout: 30_000 });
  await bob.page.getByRole("button", { name: "关闭设置" }).click();
  await linked.reload();
  await linked.getByRole("button", { name: "添加这台设备到已有账户" }).click();
  assert.equal(await linked.locator("code").first().textContent(), code);
  await linked.getByRole("button", { name: "检查配对进度" }).click();
  const linkedIdentity = linked.locator('header p[title^="@"]');
  await linkedIdentity.waitFor({ timeout: 30_000 });
  assert.equal(await linkedIdentity.getAttribute("title"), bob.userId);
  await linked.getByRole("button", { name: "已保存消息", exact: true }).first().click();
  await linked.getByText(savedText, { exact: true }).waitFor({ timeout: 20_000 });
  const linkedText = `Linked device ${Date.now()}`;
  await linked.getByLabel("消息输入").fill(linkedText);
  await linked.getByRole("button", { name: "发送" }).click();
  await bob.page.getByText(linkedText, { exact: true }).waitFor({ timeout: 20_000 });
  const followup = `Original device ${Date.now()}`;
  await bob.page.getByLabel("消息输入").fill(followup);
  await bob.page.getByRole("button", { name: "发送" }).click();
  await linked.getByText(followup, { exact: true }).waitFor({ timeout: 20_000 });

  // Compact layout regression: the account identifier must not expand the
  // list header over its actions, and the composer must grow before scrolling.
  await bob.page.setViewportSize({ width: 320, height: 568 });
  await bob.page.getByRole("button", { name: "返回对话列表" }).click();
  const compactList = await bob.page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    visibleActions: [...document.querySelectorAll("header button")]
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => ({ label: element.getAttribute("aria-label"), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })),
  }));
  assert.equal(compactList.scrollWidth, compactList.innerWidth);
  assert.deepEqual(compactList.visibleActions.map((action) => action.label), ["搜索所有消息", "新建对话", "更多操作"]);
  assert.ok(compactList.visibleActions.every((action) => action.width >= 44 && action.height >= 44));
  await bob.page.getByRole("button", { name: "更多操作" }).click();
  await bob.page.getByRole("menuitem", { name: "已保存消息" }).click();
  const longDraft = "移动端输入框应该随多行文字增长。".repeat(8);
  await bob.page.getByLabel("消息输入").fill(longDraft);
  const compactChat = await bob.page.evaluate(() => {
    const composer = document.querySelector("textarea")?.getBoundingClientRect();
    return {
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      composerHeight: composer?.height ?? 0,
      viewportHeight: getComputedStyle(document.documentElement).getPropertyValue("--edgechat-viewport-height").trim(),
    };
  });
  assert.equal(compactChat.scrollWidth, compactChat.innerWidth);
  assert.ok(compactChat.composerHeight > 44 && compactChat.composerHeight <= 128);
  assert.equal(compactChat.viewportHeight, "568px");
  await bob.page.setViewportSize({ width: 568, height: 320 });
  await bob.page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--edgechat-viewport-height").trim() === "320px");
  const landscapeChat = await bob.page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    conversationHeight: document.querySelector('section[aria-label="当前对话"]')?.getBoundingClientRect().height ?? 0,
  }));
  assert.equal(landscapeChat.scrollWidth, landscapeChat.innerWidth);
  assert.equal(landscapeChat.conversationHeight, 320);

  await bob.page.setViewportSize({ width: 390, height: 844 });
  await bob.page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
  const longMessage = `移动端展开与复制-${Date.now()} ${"完整的消息内容。".repeat(50)}`;
  await bob.page.getByLabel("消息输入").fill(longMessage);
  await bob.page.getByRole("button", { name: "发送", exact: true }).click();
  const longBubble = bob.page.getByRole("article").filter({ hasText: longMessage.slice(0, 50) });
  await longBubble.getByRole("button", { name: "消息操作" }).click();
  await bob.page.getByRole("menuitem", { name: "展开全文" }).click();
  await longBubble.getByText(longMessage, { exact: true }).waitFor();
  await longBubble.getByRole("button", { name: "消息操作" }).click();
  await bob.page.getByRole("menuitem", { name: "收起全文" }).click();
  await longBubble.getByRole("button", { name: "消息操作" }).click();
  await bob.page.getByRole("menuitem", { name: "复制消息" }).click();
  await bob.page.waitForFunction((expected) => navigator.clipboard.readText().then((value) => value === expected), longMessage);

  const secondTab = await bob.page.context().newPage();
  await secondTab.goto(baseUrl);
  await secondTab.getByRole("heading", { name: "EdgeChat 已在另一个标签页打开" }).waitFor();
  await bob.page.close();
  const resumedIdentity = secondTab.locator('header p[title^="@"]');
  await resumedIdentity.waitFor({ timeout: 30_000 });
  assert.equal(await resumedIdentity.getAttribute("title"), bob.userId);
  await secondTab.getByRole("button", { name: "已保存消息", exact: true }).first().click();
  await secondTab.getByText(linkedText, { exact: true }).waitFor();
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
