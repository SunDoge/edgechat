import { describe, expect, it } from "vitest";
import { createAppStore } from "./app-store";

describe("React application store", () => {
  it("keeps transport state outside the component tree", () => {
    const store = createAppStore();
    store.getState().setLoadingRooms(true);
    store.getState().setError("offline");
    expect(store.getState()).toMatchObject({ loadingRooms: true, error: "offline" });
  });
});
