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
  const status = await git.statusMatrix({ ...gitOptions(dir) });
  for (const [filepath, headStatus, workdirStatus] of status) {
    if (headStatus !== workdirStatus) {
      await git.add({ ...gitOptions(dir), filepath });
    }
  }

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

function loadDetector(defaultBranch, dir) {
  process.env.TARGET_BRANCH = defaultBranch;
  process.env.GITHUB_WORKSPACE = dir;
  const modulePath = require.resolve("../auto-unapprove.js");
  delete require.cache[modulePath];
  return require(modulePath).findCleanBaseBranchMerge;
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
  fs.writeFileSync(path.join(dir, "feature.txt"), "feature\n");
  await commit(dir, "feature change");

  await checkout(dir, "main");
  fs.writeFileSync(path.join(dir, "default.txt"), "default\n");
  await commit(dir, "default branch change");

  await checkout(dir, "feature");
  const cleanMerge = await git.merge({
    ...gitOptions(dir),
    ours: "feature",
    theirs: "main",
    fastForward: false,
    author: identity,
    committer: identity,
    message: "Clean default branch merge",
  });

  await checkout(dir, "main");
  fs.writeFileSync(path.join(dir, "file.txt"), "main conflict\n");
  const defaultTip = await commit(dir, "default branch conflict change");

  await checkout(dir, "feature");
  fs.writeFileSync(path.join(dir, "file.txt"), "feature conflict\n");
  const featureTip = await commit(dir, "feature conflict change");
  const featureCommit = await git.readCommit({
    ...gitOptions(dir),
    oid: featureTip,
  });
  const { tree: featureTree } = await git.readTree({
    ...gitOptions(dir),
    oid: featureCommit.commit.tree,
  });
  const resolvedBlob = await git.writeBlob({
    ...gitOptions(dir),
    blob: new Uint8Array(Buffer.from("manual resolution\n")),
  });
  const resolvedTree = featureTree.map((entry) =>
    entry.path === "file.txt" ? { ...entry, oid: resolvedBlob } : entry,
  );
  const resolvedTreeOid = await git.writeTree({
    ...gitOptions(dir),
    tree: resolvedTree,
  });
  const mergeOid = await git.writeCommit({
    ...gitOptions(dir),
    commit: {
      tree: resolvedTreeOid,
      parent: [featureTip, defaultTip],
      message: "Resolve merge conflict",
      author: {
        ...identity,
        timestamp: Math.floor(Date.now() / 1000),
        timezoneOffset: new Date().getTimezoneOffset(),
      },
      committer: {
        ...identity,
        timestamp: Math.floor(Date.now() / 1000),
        timezoneOffset: new Date().getTimezoneOffset(),
      },
    },
  });
  await git.writeRef({
    ...gitOptions(dir),
    ref: "refs/heads/feature",
    value: mergeOid,
    force: true,
  });

  return {
    ...repository,
    defaultTip,
    cleanMergeCommit: await apiCommit(dir, cleanMerge.oid),
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
  const defaultTip = await git.resolveRef({
    ...gitOptions(dir),
    ref: "main",
  });

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
    defaultTip,
    mergeCommit: await apiCommit(dir, merge.oid),
  };
}

async function run() {
  // A normal commit remains on the existing dismissal path.
  {
    const repository = await createRepository();
    fs.writeFileSync(path.join(repository.dir, "normal.txt"), "normal\n");
    const normalCommit = await commit(repository.dir, "normal change");
    const detect = loadDetector("main", repository.dir);
    assert.strictEqual(
      await detect(
        [await apiCommit(repository.dir, normalCommit)],
        "main",
        repository.base,
        normalCommit,
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
      await detect(
        [repository.mergeCommit],
        "main",
        repository.defaultTip,
        repository.mergeCommit.sha,
      ),
      true,
    );
  }

  // A manually resolved default-branch merge remains on the dismissal path.
  {
    const repository = await makeConflictResolutionMerge();
    const detect = loadDetector("main", repository.dir);
    assert.strictEqual(
      await detect(
        [
          {
            ...repository.cleanMergeCommit,
            commit: {
              committer: {
                date: new Date(Date.now() - 20_000).toISOString(),
              },
            },
          },
          {
            ...repository.mergeCommit,
            commit: {
              committer: {
                date: new Date(Date.now() - 10_000).toISOString(),
              },
            },
          },
        ],
        "main",
        repository.defaultTip,
        repository.mergeCommit.sha,
      ),
      false,
      "manual conflict resolutions must not suppress dismissal behavior",
    );
  }

  // A merge from another feature branch remains on the dismissal path.
  {
    const repository = await makeFeatureBranchMerge();
    const detect = loadDetector("main", repository.dir);
    assert.strictEqual(
      await detect(
        [repository.mergeCommit],
        "main",
        repository.defaultTip,
        repository.mergeCommit.sha,
      ),
      false,
      "feature-branch merges must not suppress dismissal behavior",
    );
  }

  // The configured default branch may be develop rather than main.
  {
    const repository = await makeCleanDefaultBranchMerge("develop");
    const detect = loadDetector("develop", repository.dir);
    assert.strictEqual(
      await detect(
        [repository.mergeCommit],
        "develop",
        repository.defaultTip,
        repository.mergeCommit.sha,
      ),
      true,
    );
  }

  console.log("✅ Merge detection tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
