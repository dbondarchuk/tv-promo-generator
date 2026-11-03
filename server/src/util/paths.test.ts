import assert from "node:assert/strict";
import test from "node:test";
import { rewritePath } from "./paths.js";

test("rewritePath swaps prefix", () => {
  assert.equal(
    rewritePath("/mnt/media/Shows/foo.mkv", "/mnt/media", "/library").replace(
      /\\/g,
      "/",
    ),
    "/library/Shows/foo.mkv",
  );
});

test("rewritePath leaves unmatched paths", () => {
  assert.equal(
    rewritePath("/other/foo.mkv", "/mnt/media", "/library").replace(/\\/g, "/"),
    "/other/foo.mkv",
  );
});
