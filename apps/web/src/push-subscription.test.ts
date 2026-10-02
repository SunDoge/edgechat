import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { disablePush, pushConfig, reconcilePush, setActivePushProfile, suspendPush, type PushRenewalConfig } from "./push-subscription";

function setup(options: { stored?: PushRenewalConfig; permission?: NotificationPermission; endpoint?: string; serverEndpoint?: string | null; applicationKey?: Uint8Array }) {
  let stored = options.stored; const unsubscribe = vi.fn(async () => true);
  const subscription = { endpoint: options.endpoint ?? "https://push.example.test/device", options: { applicationServerKey: options.applicationKey?.buffer ?? new Uint8Array([1, 2, 3]).buffer }, unsubscribe, toJSON: () => ({}) } as unknown as PushSubscription;
  const subscribe = vi.fn(async () => subscription);
  const api = {
    subscribePush: vi.fn(async () => ({ renewal_token: "new-token" })),
    pushSubscription: vi.fn(async () => ({ subscribed: options.serverEndpoint !== null, endpoint: options.serverEndpoint ?? null })),
    unsubscribePush: vi.fn(async () => undefined),
  };
  const dependencies = {
    supported: () => true,
    permission: () => options.permission ?? "granted" as NotificationPermission,
    requestPermission: vi.fn(async () => "granted" as NotificationPermission),
    registration: vi.fn(async () => ({ pushManager: { getSubscription: vi.fn(async () => subscription), subscribe } } as unknown as ServiceWorkerRegistration)),
    config: { get: vi.fn(async () => stored), put: vi.fn(async (next: PushRenewalConfig) => { stored = next; return "active"; }), clear: vi.fn(async () => { stored = undefined; }) },
  };
  return { api, dependencies, subscription, subscribe, unsubscribe };
}

const stored = (overrides: Partial<PushRenewalConfig> = {}): PushRenewalConfig => ({ id: "active", enabled: true, renewal_token: "renew", vapid_public_key: "AQID", endpoint: "https://push.example.test/device", updated_at: 1, ...overrides });

describe("push subscription reconciliation", () => {
  it("keeps notification preferences isolated by local profile", async () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    await setActivePushProfile(first); await pushConfig.clear(); await pushConfig.put(stored({ endpoint: "https://push.example.test/first" }));
    await setActivePushProfile(second); await pushConfig.clear(); await pushConfig.put(stored({ endpoint: "https://push.example.test/second" }));
    expect((await pushConfig.get())?.endpoint).toBe("https://push.example.test/second");
    await setActivePushProfile(first); expect((await pushConfig.get())?.endpoint).toBe("https://push.example.test/first");
    await pushConfig.clear(); await setActivePushProfile(second); await pushConfig.clear();
  });

  it("does not prompt or subscribe until the user enables notifications", async () => {
    const fixture = setup({ permission: "default" });
    expect(await reconcilePush(fixture.api, "AQID", false, fixture.dependencies)).toBe("off");
    expect(fixture.dependencies.requestPermission).not.toHaveBeenCalled();
    expect(fixture.api.pushSubscription).not.toHaveBeenCalled();
  });

  it("keeps a matching browser and server subscription without churn", async () => {
    const fixture = setup({ stored: stored(), serverEndpoint: "https://push.example.test/device", applicationKey: new Uint8Array([1, 2, 3]) });
    expect(await reconcilePush(fixture.api, "AQID", false, fixture.dependencies)).toBe("on");
    expect(fixture.subscribe).not.toHaveBeenCalled(); expect(fixture.api.subscribePush).not.toHaveBeenCalled();
  });

  it("repairs a missing server subscription and rotates a changed VAPID key", async () => {
    const fixture = setup({ stored: stored(), serverEndpoint: null, applicationKey: new Uint8Array([9]) });
    expect(await reconcilePush(fixture.api, "AQID", false, fixture.dependencies)).toBe("on");
    expect(fixture.unsubscribe).toHaveBeenCalledOnce(); expect(fixture.subscribe).toHaveBeenCalledOnce(); expect(fixture.api.subscribePush).toHaveBeenCalledOnce();
  });

  it("unsubscribes both sides and clears local renewal state", async () => {
    const fixture = setup({ stored: stored() });
    await disablePush(fixture.api, fixture.dependencies);
    expect(fixture.unsubscribe).toHaveBeenCalledOnce(); expect(fixture.api.unsubscribePush).toHaveBeenCalledOnce(); expect(fixture.dependencies.config.clear).toHaveBeenCalledOnce();
  });

  it("detaches an inactive profile but preserves its notification preference", async () => {
    const fixture = setup({ stored: stored() });
    await suspendPush(fixture.api, fixture.dependencies);
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    expect(fixture.api.unsubscribePush).toHaveBeenCalledOnce();
    expect(fixture.dependencies.config.clear).not.toHaveBeenCalled();
    expect(fixture.dependencies.config.put).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, endpoint: null, renewal_token: null }));
  });
});
