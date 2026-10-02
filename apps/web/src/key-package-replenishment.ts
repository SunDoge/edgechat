import type { OpenMlsMessagingCore } from "@edgechat/messaging-core";
import type { MlsKeyPackageStatus } from "@edgechat/sync";

type KeyPackageApi = {
  mlsKeyPackageStatus(): Promise<MlsKeyPackageStatus>;
  uploadMlsKeyPackages(packages: string[]): Promise<MlsKeyPackageStatus & { uploaded: number }>;
};

export async function replenishMlsKeyPackages(options: {
  api: KeyPackageApi;
  mls: Pick<OpenMlsMessagingCore, "generateKeyPackages">;
  persist: () => Promise<void>;
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
}): Promise<number> {
  const status = await options.api.mlsKeyPackageStatus();
  if (status.available >= status.low_water) return 0;
  const capacity = status.active_limit - status.active;
  if (capacity < 1) return 0;
  const count = Math.max(1, Math.min(50, status.target - status.available, capacity));
  const packages = await options.exclusive(async () => {
    const generated = options.mls.generateKeyPackages(count);
    // Persist private KeyPackage material before its public half can become claimable.
    await options.persist();
    return generated;
  });
  return (await options.api.uploadMlsKeyPackages(packages)).uploaded;
}
