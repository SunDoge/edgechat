import type { Context } from "cordis";
import type { IMPlatform } from "@mtproto-relay/bridge";
import { resolvePlatformPluginId } from "@mtproto-relay/bridge";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import z from "schemastery";

export interface Config {
  edgechatRoot: string;
  baseUrl: string;
  statePath?: string;
  displayName?: string;
  deviceName?: string;
  pollIntervalMs?: number;
}

export const Config = z.object({
  edgechatRoot: z.string().required().description("Absolute path to the EdgeChat checkout"),
  baseUrl: z.string().required().role("link").description("EdgeChat Worker HTTPS origin"),
  statePath: z.string().default("./data/edgechat-gateway.json").description("Owner-only gateway device state"),
  displayName: z.string().default("CrossGram Gateway"),
  deviceName: z.string().default("CrossGram gateway"),
  pollIntervalMs: z.natural().min(250).default(1_000),
});

export const name = "im-platform-edgechat";
export const inject = ["imPlatform"];

export async function loadEdgeChatModules(edgechatRoot: string) {
  const source = (relative: string) => pathToFileURL(resolve(edgechatRoot, relative)).href;
  const [clientModule, adapterModule, storeModule] = await Promise.all([
    import(source("packages/client-node/src/index.ts")),
    import(source("packages/client-node/src/crossgram.ts")),
    import(source("packages/client-node/src/file-store.ts")),
  ]);
  if (typeof clientModule.NodeEdgeChatClient !== "function"
    || typeof adapterModule.EdgeChatCrossgramPlatform !== "function"
    || typeof storeModule.JsonFileNodeClientStore !== "function") {
    throw new Error("EdgeChat checkout does not expose the required gateway modules");
  }
  return { clientModule, adapterModule, storeModule };
}

/**
 * Development/self-hosting Cordis entrypoint. It is deliberately outside the
 * pnpm workspace: CrossGram owns its Yarn workspace and private bridge types,
 * while the imported EdgeChat source resolves dependencies from this checkout.
 */
export function apply(ctx: Context, config: Config): void {
  const registrationId = resolvePlatformPluginId(ctx, "edgechat");
  const logger = ctx.logger("platform-edgechat");
  ctx.effect(async () => {
    const { clientModule, adapterModule, storeModule } = await loadEdgeChatModules(config.edgechatRoot);
    const { NodeEdgeChatClient } = clientModule;
    const { EdgeChatCrossgramPlatform } = adapterModule;
    const { JsonFileNodeClientStore } = storeModule;
    const store = new JsonFileNodeClientStore(config.statePath ?? "./data/edgechat-gateway.json");
    const saved = await store.load();
    const client = saved
      ? await NodeEdgeChatClient.restore(saved, { store })
      : await NodeEdgeChatClient.register({
          baseUrl: config.baseUrl,
          displayName: config.displayName ?? "CrossGram Gateway",
          deviceName: config.deviceName ?? "CrossGram gateway",
          store,
        });
    const platform = new EdgeChatCrossgramPlatform(client, {
      pollIntervalMs: config.pollIntervalMs,
      onPollError(error: unknown) { logger.warn("poll failed; durable deliveries will be retried: %o", error); },
    }) as IMPlatform & { close(): void };
    const contract: IMPlatform = platform;
    const unregister = ctx.imPlatform.register(contract, registrationId);
    return async () => {
      await unregister();
      platform.close();
      client.close();
    };
  }, "platform-edgechat.lifecycle");
}
