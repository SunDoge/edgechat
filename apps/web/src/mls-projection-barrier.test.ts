import { describe, expect, it, vi } from "vitest";
import { LocalProjectionPersistenceError } from "@edgechat/sync";
import { MlsProjectionBarrier, MlsProjectionBarrierError } from "./mls-projection-barrier";

describe("MlsProjectionBarrier", () => {
  it("blocks unrelated MLS mutations until the staged event settles", () => {
    const barrier = new MlsProjectionBarrier();
    barrier.add("$staged:example.com");

    expect(() => barrier.assertWritable()).toThrow(MlsProjectionBarrierError);
    try { barrier.assertWritable(); } catch (error) { expect(error).toBeInstanceOf(LocalProjectionPersistenceError); }
    expect(() => barrier.assertWritable("$other:example.com")).toThrow(MlsProjectionBarrierError);
    expect(() => barrier.assertWritable("$staged:example.com")).not.toThrow();

    barrier.settle("$staged:example.com");
    expect(() => barrier.assertWritable()).not.toThrow();
  });

  it("restores the fail-closed barrier from durable staging after reload", () => {
    const barrier = new MlsProjectionBarrier();
    barrier.replace(["$first:example.com", "$second:example.com"]);
    const operation = vi.fn();

    expect(() => { barrier.assertWritable("$first:example.com"); operation(); }).toThrow(MlsProjectionBarrierError);
    expect(operation).not.toHaveBeenCalled();

    barrier.settle("$second:example.com");
    expect(() => barrier.assertWritable("$first:example.com")).not.toThrow();
  });
});
