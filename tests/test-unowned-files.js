#!/usr/bin/env node

const assert = require("assert");
const { containsUnownedChangedFile } = require("../auto-unapprove.js");

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

console.log("✅ Unowned changed-file logic tests passed");
