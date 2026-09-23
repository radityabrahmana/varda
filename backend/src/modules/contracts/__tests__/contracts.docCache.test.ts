import { beforeEach, describe, expect, it, vi } from "vitest";

const lib = vi.hoisted(() => ({ extractTrackedChangeIds: vi.fn(async () => [{ kind: "ins" as const, w_id: "1" }]) }));
vi.mock("../../../lib/docxTrackedChanges", () => ({ extractTrackedChangeIds: lib.extractTrackedChangeIds }));

import { clearDocxCache, getCachedDocx, invalidateCachedDocx, putCachedDocx, trackedIdsFor } from "../contracts.docCache";

beforeEach(() => {
  clearDocxCache();
  lib.extractTrackedChangeIds.mockClear();
});

describe("contract DOCX cache", () => {
  it("returns what was put, replaces on put, and forgets on invalidate", () => {
    putCachedDocx("k", Buffer.from("v1"));
    putCachedDocx("k", Buffer.from("v2"));
    expect(getCachedDocx("k")?.toString()).toBe("v2");
    invalidateCachedDocx("k");
    expect(getCachedDocx("k")).toBeNull();
  });

  it("evicts the least recently used entry past 16 files", () => {
    for (let i = 0; i < 16; i++) putCachedDocx(`k${i}`, Buffer.from(String(i)));
    getCachedDocx("k0"); // k0 is now most recent; k1 is the oldest
    putCachedDocx("k16", Buffer.from("16"));
    expect(getCachedDocx("k0")).not.toBeNull();
    expect(getCachedDocx("k1")).toBeNull();
    expect(getCachedDocx("k16")).not.toBeNull();
  });

  it("parses tracked-change ids once per cached version", async () => {
    const v1 = Buffer.from("v1");
    putCachedDocx("k", v1);
    await trackedIdsFor("k", v1);
    await trackedIdsFor("k", v1);
    expect(lib.extractTrackedChangeIds).toHaveBeenCalledTimes(1);

    const v2 = Buffer.from("v2");
    putCachedDocx("k", v2);
    await trackedIdsFor("k", v2);
    expect(lib.extractTrackedChangeIds).toHaveBeenCalledTimes(2);
    // Bytes that are not the cached version are parsed but not memoised.
    await trackedIdsFor("k", Buffer.from("other"));
    await trackedIdsFor("k", Buffer.from("other"));
    expect(lib.extractTrackedChangeIds).toHaveBeenCalledTimes(4);
  });
});
