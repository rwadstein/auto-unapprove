#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const git = require("isomorphic-git");

const identity = {
  name: "Merge Detection Test",
  email: "merge-detection@example.com",
};

function gitOptions(dir) {
  return { fs, dir };
}

async function commit(dir, message) {
  return git.commit({
    ...gitOptions(dir),
    message,
    author: identity,
    committer: identity,
  });
}

async function checkout(dir, ref) {
  await git.checkout({ ...gitOptions(dir), ref });
}

async function createRepository(defaultBranch = "main") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-unapprove-"));
  await git.init({ ...gitOptions(dir), defaultBranch });
  fs.writeFileSync(path.join(dir, "file.txt"), "base\n");
  const base = await commit(dir, "base");
  return { dir, defaultBranch, base };
}

async function apiCommit(dir, oid) {
  const result = await git.readCommit({ ...gitOptions(dir), oid });
  return {
    sha: oid,
    parents: result.commit.parent.map((sha) => ({ sha })),
    commit: {
      committer: {
        date: new Date(result.commit.committer.timestamp * 1000).toISOString(),
      },
    },
  };
}

function approvalsAt(date) {
  return [
    {
      state: "APPROVED",
      submitted_at: date,
      user: { login: "reviewer" },
    },
  ];
}

function loadDetector(defaultBranch, dir) {
  process.env.TARGET_BRANCH = defaultBranch;
  process.env.GITHUB_WORKSPACE = dir;
  const modulePath = require.resolve("../auto-unapprove.js");
  delete require.cache[modulePath];
  return require(modulePath).findCleanDefaultBranchMerge;
}

async function makeCleanDefaultBranchMerge(defaultBranch = "main") {
  const repository = await createRepository(defaultBranch);
  const { dir } = repository;

  await git.branch({ ...gitOptions(dir), ref: "feature" });
  await checkout(dir, defaultBranch);
  fs.writeFileSync(path.join(dir, "default.txt"), "default\n");
  await commit(dir, "default branch change");
  const defaultTip = await git.resolveRef({
    ...gitOptions(dir),
    ref: defaultBranch,
  });

  await checkout(dir, "feature");
  fs.writeFileSync(path.join(dir, "feature.txt"), "feature\n");
  await commit(dir, "feature change");
  const merge = await git.merge({
    ...gitOptions(dir),
    ours: "feature",
    theirs: defaultBranch,
    fastForward: false,
    author: identity,
    committer: identity,
    message: "Merge default branch",
  });

  return {
    ...repository,
    defaultTip,
    mergeCommit: await apiCommit(dir, merge.oid),
  };
}

async function makeConflictResolutionMerge() {
  const repository = await createRepository();
  const { dir } = repository;

  await git.branch({ ...gitOptions(dir), ref: "feature" });
  await checkout(dir, "feature");
  fs.writeFileSync(path.join(dir, "file.txt"), "feature\n");
  const featureTip = await commit(dir, "feature change");

  await checkout(dir, "main");
  fs.writeFileSync(path.join(dir, "file.txt"), "main\n");
  const defaultTip = await commit(dir, "default branch change");

  await checkout(dir, "feature");
  await git.merge({
    ...gitOptions(dir),
    ours: "feature",
    theirs: "main",
    fastForward: false,
    author: identity,
    committer: identity,
    abortOnConflict: false,
  });
  fs.writeFileSync(path.join(dir, "file.txt"), "manual resolution\n");
  await git.add({ ...gitOptions(dir), filepath: "file.txt" });
  const mergeOid = await commit(dir, "Resolve merge conflict");

  return {
    ...repository,
    featureTip,
    defaultTip,
    mergeCommit: await apiCommit(dir, mergeOid),
  };
}

async function makeFeatureBranchMerge() {
  const repository = await createRepository();
  const { dir } = repository;

  await git.branch({ ...gitOptions(dir), ref: "feature-one" });
  await git.branch({ ...gitOptions(dir), ref: "feature-two" });

  await checkout(dir, "feature-two");
  fs.writeFileSync(path.join(dir, "feature-two.txt"), "feature two\n");
  await commit(dir, "feature two change");

  await checkout(dir, "main");
  fs.writeFileSync(path.join(dir, "main.txt"), "main\n");
  await commit(dir, "default branch change");

  await checkout(dir, "feature-one");
  fs.writeFileSync(path.join(dir, "feature-one.txt"), "feature one\n");
  await commit(dir, "feature one change");
  const merge = await git.merge({
    ...gitOptions(dir),
    ours: "feature-one",
    theirs: "feature-two",
    fastForward: false,
    author: identity,
    committer: identity,
    message: "Merge feature branch",
  });

  return {
    ...repository,
    mergeCommit: await apiCommit(dir, merge.oid),
  };
}

async function run() {
  const approvalBefore = new Date(Date.now() - 60_000).toISOString();
  const approvalAfter = new Date(Date.now() + 60_000).toISOString();

  // A normal commit after approval remains on the existing dismissal path.
  {
    const repository = await createRepository();
    fs.writeFileSync(path.join(repository.dir, "normal.txt"), "normal\n");
    const normalCommit = await commit(repository.dir, "normal change");
    const detect = loadDetector("main", repository.dir);
    assert.strictEqual(
      await detect(
        [await apiCommit(repository.dir, normalCommit)],
        approvalsAt(approvalBefore),
      ),
      false,
      "normal commits must not suppress dismissal behavior",
    );
  }

  // A clean merge from the default branch preserves all reviews.
  {
    const repository = await makeCleanDefaultBranchMerge();
    const detect = loadDetector("main", repository.dir);
    assert.strictEqual(
      await detect([repository.mergeCommit], approvalsAt(approvalBefore)),
      true,
    );
  }

  // A manually resolved default-branch merge remains on the dismissal path.
  {
    const repository = await makeConflictResolutionMerge();
    const detect = loadDetector("main", repository.dir);
    assert.strictEqual(
      await detect([repository.mergeCommit], approvalsAt(approvalBefore)),
      false,
      "manual conflict resolutions must not suppress dismissal behavior",
    );
  }

  // A merge from another feature branch remains on the dismissal path.
  {
    const repository = await makeFeatureBranchMerge();
    const detect = loadDetector("main", repository.dir);
    assert.strictEqual(
      await detect([repository.mergeCommit], approvalsAt(approvalBefore)),
      false,
      "feature-branch merges must not suppress dismissal behavior",
    );
  }

  // The configured default branch may be develop rather than main.
  {
    const repository = await makeCleanDefaultBranchMerge("develop");
    const detect = loadDetector("develop", repository.dir);
    assert.strictEqual(
      await detect([repository.mergeCommit], approvalsAt(approvalBefore)),
      true,
    );
  }

  // A default-branch merge before approval must not suppress later dismissal.
  {
    const repository = await makeCleanDefaultBranchMerge();
    const detect = loadDetector("main", repository.dir);
    assert.strictEqual(
      await detect([repository.mergeCommit], approvalsAt(approvalAfter)),
      false,
      "pre-approval merges must not suppress dismissal behavior",
    );
  }

  console.log("✅ Merge detection tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
