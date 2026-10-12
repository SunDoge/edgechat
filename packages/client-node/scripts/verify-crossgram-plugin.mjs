import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const crossgramRoot = resolve(process.env.CROSSGRAM_DIR ?? process.argv[2] ?? "");
if (!process.env.CROSSGRAM_DIR && !process.argv[2]) {
  console.error("Usage: CROSSGRAM_DIR=/path/to/crossgram pnpm test:crossgram:plugin");
  process.exit(2);
}

const edgechatRoot = resolve(import.meta.dirname, "../../..");
const manifest = JSON.parse(await readFile(resolve(crossgramRoot, "package.json"), "utf8"));
if (typeof manifest.packageManager !== "string" || !manifest.packageManager.startsWith("yarn@")) {
  throw new Error("CrossGram checkout does not declare its expected Yarn package manager");
}

const source = `
  const plugin = await import('@mtproto-relay/platform-edgechat');
  if (plugin.name !== 'im-platform-edgechat' || typeof plugin.apply !== 'function') throw new Error('invalid Cordis plugin exports');
  const modules = await plugin.loadEdgeChatModules(${JSON.stringify(edgechatRoot)});
  const result = {
    ok: true,
    plugin: plugin.name,
    client: typeof modules.clientModule.NodeEdgeChatClient,
    adapter: typeof modules.adapterModule.EdgeChatCrossgramPlatform,
    store: typeof modules.storeModule.JsonFileNodeClientStore,
  };
  if (result.client !== 'function' || result.adapter !== 'function' || result.store !== 'function') throw new Error('invalid EdgeChat gateway exports');
  console.log(JSON.stringify(result));
`;

const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
  cwd: crossgramRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--preserve-symlinks", "--import", "tsx", "--import", "@cordisjs/unyaml"].filter(Boolean).join(" "),
  },
});
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));
