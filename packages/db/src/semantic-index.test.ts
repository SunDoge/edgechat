import { describe, expect, it, vi } from "vitest";
import { LocalDatabase } from "./index";

function databaseWithQuerySpy() {
  const database = Object.create(LocalDatabase.prototype) as LocalDatabase;
  const query = vi.fn(async () => []);
  Object.defineProperty(database, "query", { value: query });
  return { database, query };
}

describe("local semantic image index lifecycle", () => {
  it("can remove every local image vector without touching message rows", async () => {
    const { database, query } = databaseWithQuerySpy();

    await database.clearImageEmbeddings();

    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith("DELETE FROM image_embeddings");
  });

  it("can remove only one versioned model index", async () => {
    const { database, query } = databaseWithQuerySpy();
    const model = { id: "clip", version: "q8-v1", preprocessing_version: "crop-v1" };

    await database.clearImageEmbeddings(model);

    expect(query).toHaveBeenCalledWith(
      "DELETE FROM image_embeddings WHERE model_id = $1 AND model_version = $2 AND preprocessing_version = $3",
      [model.id, model.version, model.preprocessing_version],
    );
  });
});
