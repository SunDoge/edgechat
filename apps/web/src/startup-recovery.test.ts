import { describe, expect, it } from "vitest";
import { describeStartupFailure, INTERRUPTED_RESTORE_FAILURE } from "./startup-recovery";
import { translate } from "./i18n";

describe("startup recovery classification", () => {
  it("requires an update instead of attempting to downgrade a newer local schema", () => {
    expect(describeStartupFailure(new Error("Local database schema 4 is newer than this client supports (3)"))).toEqual({
      kind: "newer-client-required",
      code: "LOCAL_SCHEMA_NEWER",
      titleKey: "startupRecovery.schema.title",
      summaryKey: "startupRecovery.schema.summary",
      primaryActionKey: "startupRecovery.action.update",
      primaryIntent: "retry",
    });
  });

  it("turns migration and browser-storage failures into a non-destructive local recovery state", () => {
    expect(describeStartupFailure(new Error("Local database migration 2 failed: relation missing")).kind).toBe("local-database");
    expect(describeStartupFailure(new Error("OPFS access denied")).code).toBe("LOCAL_DATABASE_UNAVAILABLE");
  });

  it("turns a stopped startup watchdog into a non-destructive retry path", () => {
    expect(describeStartupFailure(new Error("Local database startup timed out"))).toEqual({
      kind: "local-database",
      code: "LOCAL_DATABASE_STARTUP_TIMEOUT",
      titleKey: "startupRecovery.timeout.title",
      summaryKey: "startupRecovery.timeout.summary",
      primaryActionKey: "startupRecovery.action.reopen",
      primaryIntent: "retry",
    });
  });

  it("separates crypto and temporary service failures", () => {
    expect(describeStartupFailure(new Error("MLS snapshot could not be decoded")).kind).toBe("device-crypto");
    expect(describeStartupFailure(new TypeError("Failed to fetch")).kind).toBe("service-unavailable");
    expect(describeStartupFailure({ status: 503 }).kind).toBe("service-unavailable");
  });

  it("never copies an unknown raw error into user-facing recovery text", () => {
    const secret = "private-path/secret-token";
    const failure = describeStartupFailure(new Error(secret));
    expect(`${translate(failure.titleKey)} ${translate(failure.summaryKey)} ${translate(failure.primaryActionKey)}`).not.toContain(secret);
    expect(failure.code).toBe("STARTUP_UNEXPECTED_FAILURE");
  });

  it("requires the backup again after an interrupted local restore", () => {
    expect(INTERRUPTED_RESTORE_FAILURE).toMatchObject({
      code: "LOCAL_RESTORE_INTERRUPTED",
      primaryIntent: "restore",
      primaryActionKey: "startupRecovery.action.selectBackup",
    });
  });
});
