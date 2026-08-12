#!/usr/bin/env node

const assert = require("assert");
const {
  containsUnownedChangedFile,
  isUserCodeowner,
} = require("../auto-unapprove.js");

assert.strictEqual(
  containsUnownedChangedFile(
    new Map([
      ["src/owned.js", ["@alice"]],
      ["src/unowned.js", []],
    ]),
  ),
  true,
);

assert.strictEqual(
  containsUnownedChangedFile(
    new Map([["src/owned.js", ["@alice", "@bob"]]]),
  ),
  false,
);

assert.strictEqual(
  isUserCodeowner(
    "alice",
    [{ path: "/src/other.js", owners: ["@alice"] }],
    new Map(),
  ),
  true,
);

assert.strictEqual(
  isUserCodeowner(
    "bob",
    [{ path: "/src/other.js", owners: ["@alice"] }],
    new Map(),
  ),
  false,
);

console.log("✅ Unowned changed-file logic tests passed");
