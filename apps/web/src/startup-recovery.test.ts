import { describe, expect, it } from "vitest";
import { describeStartupFailure, INTERRUPTED_RESTORE_FAILURE } from "./startup-recovery";

describe("startup recovery classification", () => {
  it("requires an update instead of attempting to downgrade a newer local schema", () => {
    expect(describeStartupFailure(new Error("Local database schema 4 is newer than this client supports (3)"))).toEqual({
      kind: "newer-client-required",
      code: "LOCAL_SCHEMA_NEWER",
      title: "需要更新 EdgeChat",
      summary: "这份本机记录由更新版本的应用写入。当前版本没有尝试降级或修改它，请更新后重新打开。",
      primaryAction: "检查更新并重试",
      primaryIntent: "retry",
    });
  });

  it("turns migration and browser-storage failures into a non-destructive local recovery state", () => {
    expect(describeStartupFailure(new Error("Local database migration 2 failed: relation missing")).kind).toBe("local-database");
    expect(describeStartupFailure(new Error("OPFS access denied")).code).toBe("LOCAL_DATABASE_UNAVAILABLE");
  });

  it("separates crypto and temporary service failures", () => {
    expect(describeStartupFailure(new Error("MLS snapshot could not be decoded")).kind).toBe("device-crypto");
    expect(describeStartupFailure(new TypeError("Failed to fetch")).kind).toBe("service-unavailable");
    expect(describeStartupFailure({ status: 503 }).kind).toBe("service-unavailable");
  });

  it("never copies an unknown raw error into user-facing recovery text", () => {
    const secret = "private-path/secret-token";
    const failure = describeStartupFailure(new Error(secret));
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(failure.code).toBe("STARTUP_UNEXPECTED_FAILURE");
  });

  it("requires the backup again after an interrupted local restore", () => {
    expect(INTERRUPTED_RESTORE_FAILURE).toMatchObject({
      code: "LOCAL_RESTORE_INTERRUPTED",
      primaryIntent: "restore",
      primaryAction: "重新选择备份",
    });
  });
});
