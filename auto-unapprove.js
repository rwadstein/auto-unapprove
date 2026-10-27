#!/usr/bin/env node

/**
 * 🚫 Smart Review Dismissal Script
 *
 * Selectively dismisses PR reviews when codeowners' files were modified or
 * when a changed file has no codeowners.
 * Optimized for performance with GitHub API v2022-11-28.
 *
 * Usage:
 *   node auto-unapprove.js [options]
 *
 * Environment Variables:
 *   GITHUB_TOKEN      - GitHub API token (required)
 *   PR_NUMBER         - Pull request number (required)
 *   GITHUB_REPOSITORY - Repository in format owner/repo (required)
 *   TEAM_START_WITH   - Team prefix (default: @)
 *   DRY_RUN           - Set to 'false' for actual dismissals (default: true)
 *   CODEOWNERS_FILE   - Path to CODEOWNERS file (default: CODEOWNERS)
 *   CHANGED_FILES     - Newline-separated list of files (for webhook optimization)
 *   TARGET_BRANCH     - Target branch (default: main) (for CODEOWNERS file)
 *
 * Clean default-branch merge detection requires the repository and its
 * relevant history to be available locally (for example, checkout with
 * fetch-depth: 0 in GitHub Actions).
 */

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const [owner, repo] = repository?.split("/") || [];
const team_start_with = process.env.TEAM_START_WITH || "@";
const prNumber = process.env.PR_NUMBER;
const dryRun = process.env.DRY_RUN !== "false";
const codeownersFile = process.env.CODEOWNERS_FILE || "CODEOWNERS";
const targetBranch = process.env.TARGET_BRANCH || "main";

async function smartDismissReviews() {
  try {
    // Validate inputs
    if (!token) {
      throw new Error("GITHUB_TOKEN environment variable is required");
    }
    if (!prNumber) {
      throw new Error("PR_NUMBER environment variable is required");
    }
    if (!repository) {
      throw new Error("GITHUB_REPOSITORY environment variable is required");
    }
    if (!owner || !repo) {
      throw new Error('GITHUB_REPOSITORY must be in format "owner/repo"');
    }

    console.log(`🚀 Smart Review Dismissal`);
    console.log(`   Repository: ${owner}/${repo}`);
    console.log(`   PR: #${prNumber}`);
    console.log(`   Mode: ${dryRun ? "🧪 DRY RUN" : "⚡ LIVE"}`);
    console.log(`   Target branch: ${targetBranch}`);
    console.log(`   Team start with: ${team_start_with}`);
    console.log(`   Codeowners file: ${codeownersFile}`);
    console.log("");

    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "dismiss-reviews-action",
    };

    // Step 1: Get changed files (optimize for webhook payload if available)
    let changedFiles = [];

    if (process.env.CHANGED_FILES) {
      // Ultra-fast: Use webhook payload
      changedFiles = process.env.CHANGED_FILES.split("\n").filter((f) =>
        f.trim(),
      );
      console.log(`📁 Files from webhook payload (${changedFiles.length}):`);
    } else {
      // Fast: Get ALL files changed in the PR with pagination
      console.log(`📁 Fetching ALL changed files from PR (with pagination)...`);

      changedFiles = await getAllChangedFiles(headers);
      console.log(`📁 All changed files in PR (${changedFiles.length}):`);
    }

    if (changedFiles.length === 0) {
      console.log("   No files changed - nothing to analyze");
      return;
    }

    changedFiles.forEach((file) => {
      console.log(`   📝 ${file}`);
    });

    // Step 2: Get the PR base and head from the GitHub Actions event context.
    console.log(`\n👥 Fetching PR reviews, CODEOWNERS, and commit authors...`);

    const baseBranch = process.env.PR_BASE_BRANCH || targetBranch;
    const baseSha = process.env.PR_BASE_SHA;
    const commitSha = process.env.PR_AFTER_SHA || process.env.PR_HEAD_SHA;

    if (!baseSha || !commitSha) {
      throw new Error(
        "PR_BASE_SHA and PR_AFTER_SHA or PR_HEAD_SHA are required when running as a GitHub Action",
      );
    }

    console.log(`🎯 PR base branch: ${baseBranch}`);
    console.log(`🎯 PR base SHA: ${baseSha}`);
    console.log(`🎯 PR commit SHA: ${commitSha}`);

    const codeownersResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${codeownersFile}?ref=${baseBranch}`,
      { headers },
    );

    // Get all reviews and commits with pagination
    console.log(`📋 Fetching all reviews and commits...`);
    const reviews = await getAllReviews(headers);
    const commits = await getAllCommits(headers);
    const approvedReviews = reviews.filter(
      (review) => review.state === "APPROVED",
    );
    const approvedReviewers = [
      ...new Set(approvedReviews.map((review) => review.user.login)),
    ];

    // Get commit authors
    const commitAuthors = new Set(
      commits.map((commit) => commit.author?.login).filter(Boolean),
    );

    console.log(
      `✅ Found ${approvedReviews.length} approved reviews from ${approvedReviewers.length} reviewers`,
    );
    console.log(
      `📝 Found ${commits.length} commits from authors: ${Array.from(commitAuthors).join(", ")}`,
    );

    if (approvedReviewers.length === 0) {
      console.log("   No approved reviews to analyze");
      return;
    }

    const cleanBaseBranchMerge = await findCleanBaseBranchMerge(
      commits,
      baseBranch,
      baseSha,
      commitSha,
    );
    if (cleanBaseBranchMerge) {
      console.log(
        `✅ Clean merge from PR base branch ${baseBranch} detected after approval; preserving all reviews`,
      );
      return;
    }

    // Step 3: Parse CODEOWNERS
    let codeowners = [];
    if (codeownersResponse.ok) {
      const codeownersData = await codeownersResponse.json();
      if (codeownersData.content) {
        const decodedContent = Buffer.from(
          codeownersData.content,
          "base64",
        ).toString("utf8");
        codeowners = parseCodeowners(decodedContent);
        console.log(`👑 Parsed ${codeowners.length} CODEOWNERS rules`);
      }
    } else {
      console.log("⚠️  No CODEOWNERS file found - using default ownership");
    }

    // Step 4: Map changed files to code owners
    console.log(`\n🔍 Mapping files to code owners...`);
    const changedFileOwners = new Map();

    for (const file of changedFiles) {
      const owners = getFileOwnersHierarchical(file, codeowners);
      changedFileOwners.set(file, owners);

      if (owners.length > 0) {
        console.log(`   ${file} → ${owners.join(", ")}`);
      } else {
        console.log(`   ${file} → No specific owners`);
      }
    }
    const hasUnownedChangedFile = containsUnownedChangedFile(changedFileOwners);
    const nonCodeownedFiles = [...changedFileOwners.entries()]
      .filter(([, owners]) => owners.length === 0)
      .map(([file]) => file);
    if (hasUnownedChangedFile) {
      console.log(
        `⚠️  At least one changed file has no codeowners; non-owner approvals will be checked against those files`,
      );
    }

    // Step 5: Get teams referenced by CODEOWNERS so repository-wide ownership
    // can be checked for the unowned-file fallback.
    const relevantTeams = getRelevantTeams(codeowners);
    console.log(`\n🏢 Checking ${relevantTeams.length} relevant teams...`);

    // Step 6: Check team memberships for approved reviewers (only relevant teams)
    const teamMemberships = new Map();
    for (const reviewer of approvedReviewers) {
      teamMemberships.set(reviewer, new Map());
      for (const team of relevantTeams) {
        const isMember = await checkTeamMembership(reviewer, team, headers);
        teamMemberships.get(reviewer).set(team, isMember);
        if (isMember) {
          console.log(`   ✅ @${reviewer} ∈ ${team_start_with}${team}`);
        }
      }
    }

    // Step 7: STALE APPROVAL ANALYSIS
    console.log(`\n🎯 DISMISSAL ANALYSIS:`);
    const dismissalTargets = [];

    for (const reviewer of approvedReviewers) {
      const { isCodeowner, ownedFiles, viaTeams } = isUserCodeownerForFiles(
        reviewer,
        changedFileOwners,
        teamMemberships.get(reviewer),
      );
      const isRepositoryCodeowner = isUserCodeowner(
        reviewer,
        codeowners,
        teamMemberships.get(reviewer),
      );

      const isCommitAuthor = commitAuthors.has(reviewer);
      let hasStaleApproval = false;
      let staleReason = "";
      let commitsAfterApproval = [];
      let affectedFiles = [];

      // Get reviewer's approvals with timestamps
      const reviewerApprovals = approvedReviews.filter(
        (r) => r.user.login === reviewer,
      );

      const filesToCheck = isCodeowner ? ownedFiles : nonCodeownedFiles;
      const shouldCheckApprovalTimestamp =
        reviewerApprovals.length > 0 &&
        (isCodeowner || (hasUnownedChangedFile && !isRepositoryCodeowner));

      if (shouldCheckApprovalTimestamp) {
        // Check for commits after approval to the files relevant to this reviewer.
        const latestApproval = reviewerApprovals.sort(
          (a, b) => new Date(b.submitted_at) - new Date(a.submitted_at),
        )[0];
        const approvalTime = new Date(latestApproval.submitted_at);

        // Get commits after approval
        commitsAfterApproval = commits.filter((commit) => {
          const commitTime = new Date(commit.commit.committer.date);
          return commitTime > approvalTime;
        });

        if (commitsAfterApproval.length > 0) {
          console.log(
            `   🕐 Checking commits after ${reviewer}'s approval (${approvalTime.toISOString()})...`,
          );

          // Check if post-approval commits actually touched relevant files.
          affectedFiles = [];

          for (const commit of commitsAfterApproval) {
            console.log(
              `     📅 Commit ${commit.sha.substring(0, 7)} at ${commit.commit.committer.date}`,
            );

            // Get files changed in this commit
            try {
              const commitDetailsResponse = await fetch(
                `https://api.github.com/repos/${owner}/${repo}/commits/${commit.sha}`,
                { headers },
              );
              if (commitDetailsResponse.ok) {
                const commitDetails = await commitDetailsResponse.json();
                const commitFiles = commitDetails.files.map((f) => f.filename);

                // Check if any commit files are relevant to this reviewer.
                const intersection = commitFiles.filter((file) =>
                  filesToCheck.includes(file),
                );
                if (intersection.length > 0) {
                  affectedFiles.push(...intersection);
                  console.log(
                    `       🎯 Modified relevant files: ${intersection.join(", ")}`,
                  );
                }
              }
            } catch (error) {
              console.log(
                `       ⚠️ Could not fetch commit details: ${error.message}`,
              );
            }
          }

          if (affectedFiles.length > 0) {
            hasStaleApproval = true;
            staleReason = `Approval became stale - commits modified relevant files: ${[...new Set(affectedFiles)].join(", ")}`;
          } else {
            console.log(
              `     ✅ No relevant files modified - approval stays valid`,
            );
          }
        }
      }

      // Dismiss non-owners only when a post-approval commit modified an
      // unowned changed file. Otherwise, dismiss code owners who authored
      // commits or have stale approvals.
      const shouldDismissForUnownedFile =
        hasUnownedChangedFile && !isRepositoryCodeowner && hasStaleApproval;
      if (
        shouldDismissForUnownedFile ||
        (isCodeowner && (isCommitAuthor || hasStaleApproval))
      ) {
        const reviewIds = reviewerApprovals.map((r) => r.id);
        let reason;
        if (shouldDismissForUnownedFile) {
          reason = staleReason;
        } else if (isCommitAuthor) {
          reason = "Code owner who authored changes";
        } else {
          reason = staleReason;
        }

        dismissalTargets.push({
          reviewer,
          ownedFiles,
          viaTeams,
          reviewIds,
          reason,
          latestCommit:
            commitsAfterApproval.length > 0
              ? commitsAfterApproval[commitsAfterApproval.length - 1]
              : null,
          affectedFilesCount: hasStaleApproval
            ? [...new Set(affectedFiles)].length
            : 0,
        });
        console.log(`   `);
        console.log(`   🚫 DISMISS @${reviewer}`);
        console.log(`      📁 Files: ${ownedFiles.join(", ")}`);
        console.log(
          `      👑 Owner Via: ${viaTeams.join(", ") || "Direct ownership"}`,
        );
        console.log(`      🔢 Reviews: ${reviewIds.length}`);
        console.log(
          `      💡 Reason: ${reason}`,
        );
      } else {
        console.log(`   ✅ KEEP @${reviewer}`);
        if (viaTeams.length > 0) {
          console.log(`      👑 Owner Via: ${viaTeams.join(", ")}`);
        }
        if (!isCodeowner) {
          console.log(`      📄 Not owner of changed files`);
        } else if (!isCommitAuthor && !hasStaleApproval) {
          console.log(`      👤 Code owner with fresh approval`);
        }
      }
    }

    // Step 8: EXECUTION PLAN
    console.log(`\n📊 EXECUTION PLAN:`);
    console.log(`   • Changed files: ${changedFiles.length}`);
    console.log(`   • Total approvals: ${approvedReviews.length}`);
    console.log(`   • Dismissals needed: ${dismissalTargets.length}`);
    console.log(
      `   • Approvals preserved: ${approvedReviews.length - dismissalTargets.length}`,
    );

    // Step 9: Execute dismissals
    if (dismissalTargets.length > 0) {
      console.log(`\n${dryRun ? "🧪 WOULD DISMISS" : "🚫 DISMISSING"}:`);

      for (const target of dismissalTargets) {
        console.log(
          `   @${target.reviewer} (${target.reviewIds.length} reviews)`,
        );
        console.log(`     Reason: ${target.reason}`);
        console.log(`     Files: ${target.ownedFiles.length} changed file(s)`);
        console.log(
          `     Owner Via: ${target.viaTeams.join(", ") || "Direct ownership"}`,
        );

        if (!dryRun) {
          // Actually dismiss reviews
          for (const reviewId of target.reviewIds) {
            try {
              const dismissResponse = await fetch(
                `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/dismissals`,
                {
                  method: "PUT",
                  headers,
                  body: JSON.stringify({
                    message: target.latestCommit
                      ? `${target.affectedFilesCount} file(s) changed in commit [${target.latestCommit.sha.substring(0, 7)}](https://github.com/${owner}/${repo}/commit/${target.latestCommit.sha})`
                      : "Unapproved",
                  }),
                },
              );

              if (dismissResponse.ok) {
                console.log(`     ✅ Dismissed review ${reviewId}`);
              } else {
                console.log(
                  `     ❌ Failed to dismiss review ${reviewId}: ${dismissResponse.status}`,
                );
              }
            } catch (error) {
              console.log(
                `     ❌ Error dismissing review ${reviewId}: ${error.message}`,
              );
            }
          }
        }
      }
    } else {
      console.log(`\n✅ NO DISMISSALS NEEDED`);
      console.log(
        `   No reviewers both own changed files AND authored commits.`,
      );
    }

    console.log(`\n🎉 Analysis complete!`);
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

// Helper functions
async function getAllChangedFiles(headers) {
  const allFiles = [];
  let page = 1;
  const perPage = 100; // Maximum allowed by GitHub API

  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?page=${page}&per_page=${perPage}`;
    console.log(`   📄 Fetching page ${page}...`);

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch PR files page ${page}: ${response.status}`);
    }

    const files = await response.json();
    if (files.length === 0) {
      break; // No more files
    }

    allFiles.push(...files.map((file) => file.filename));
    console.log(`   📄 Page ${page}: ${files.length} files`);

    // Check if we've reached the last page
    if (files.length < perPage) {
      break;
    }

    page++;
  }

  return allFiles;
}

async function getAllReviews(headers) {
  const allReviews = [];
  let page = 1;
  const perPage = 100; // Maximum allowed by GitHub API

  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews?page=${page}&per_page=${perPage}`;
    console.log(`   📋 Fetching reviews page ${page}...`);

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch reviews page ${page}: ${response.status}`);
    }

    const reviews = await response.json();
    if (reviews.length === 0) {
      break; // No more reviews
    }

    allReviews.push(...reviews);
    console.log(`   📋 Reviews page ${page}: ${reviews.length} reviews`);

    // Check if we've reached the last page
    if (reviews.length < perPage) {
      break;
    }

    page++;
  }

  return allReviews;
}

async function getAllCommits(headers) {
  const allCommits = [];
  let page = 1;
  const perPage = 100; // Maximum allowed by GitHub API

  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/commits?page=${page}&per_page=${perPage}`;
    console.log(`   📝 Fetching commits page ${page}...`);

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch commits page ${page}: ${response.status}`);
    }

    const commits = await response.json();
    if (commits.length === 0) {
      break; // No more commits
    }

    allCommits.push(...commits);
    console.log(`   📝 Commits page ${page}: ${commits.length} commits`);

    // Check if we've reached the last page
    if (commits.length < perPage) {
      break;
    }

    page++;
  }

  return allCommits;
}

async function findCleanBaseBranchMerge(
  commits,
  baseBranch,
  baseSha,
  commitSha,
) {
  const headCommit = commits.find((commit) => commit.sha === commitSha);
  if (!headCommit) {
    console.log(
      `⚠️  Commit ${commitSha} could not be located. Ensure the repository is checked out with full history; using regular dismissal behavior`,
    );
    return false;
  }

  const headParentCount = headCommit.parents?.length || 0;

  // A commit with fewer than 2 parents is not a merge commit
  if (headParentCount < 2) {
    return false;
  }

  if (headParentCount > 2) {
    console.log(
      `⚠️  Octopus merge detected in PR commit ${commitSha}; using regular dismissal behavior`,
    );
    return false;
  }

  let git;
  try {
    git = require("isomorphic-git");
  } catch (error) {
    console.log(
      `⚠️  isomorphic-git unavailable; using regular dismissal behavior`,
    );
    return false;
  }

  const fs = require("fs");
  const repositoryPath = process.env.GITHUB_WORKSPACE || process.cwd();
  const gitOptions = { fs, dir: repositoryPath };

  if (!baseBranch || !baseSha) {
    console.log(
      `⚠️  PR base branch or SHA is unavailable; using regular dismissal behavior`,
    );
    return false;
  }

  try {
    const mergeCommit = await git.readCommit({
      ...gitOptions,
      oid: commitSha,
    });

    const [firstParent, secondParent] = mergeCommit.commit.parent;
    const parentIsDefaultBranch = await findDefaultBranchParent(
      git,
      gitOptions,
      [firstParent, secondParent],
      baseSha,
    );

    if (!parentIsDefaultBranch) {
      return false;
    }

    const otherParent =
      parentIsDefaultBranch === firstParent ? secondParent : firstParent;
    const mergeResult = await git.merge({
      ...gitOptions,
      ours: otherParent,
      theirs: parentIsDefaultBranch,
      fastForward: false,
      author: {
        name: "Auto Unapprove",
        email: "auto-unapprove@localhost",
      },
      committer: {
        name: "Auto Unapprove",
        email: "auto-unapprove@localhost",
      },
      noUpdateBranch: true,
      dryRun: true,
      abortOnConflict: true,
    });

    console.log(`🔀 Dry-run merge result for ${commitSha}:`);
    console.log(`   Ours: ${otherParent}`);
    console.log(`   Theirs: ${parentIsDefaultBranch}`);
    console.log(`   Actual merge tree: ${mergeCommit.commit.tree}`);
    console.log(`   Result: ${JSON.stringify(mergeResult)}`);

    return mergeResult.tree === mergeCommit.commit.tree;
  } catch (error) {
    if (
      error.code === "MergeConflictError" ||
      error.code === "MergeNotSupportedError" ||
      error.message.includes("Automatic merge failed with one or more merge conflicts")
    ) {
      console.log(
        `⚠️  Merge ${commitSha} required conflict resolution; using regular dismissal behavior`,
      );
      return false;
    }

    console.log(
      `⚠️  Could not verify merge ${commitSha.substring(0, 7)}; using regular dismissal behavior: ${error.message}`,
    );
    return false;
  }
}

async function findDefaultBranchParent(git, gitOptions, parents, descendant) {
  const matches = [];

  for (const parent of parents) {
    try {
      const isDescendant =
        descendant === parent ||
        (await git.isDescendent({
          ...gitOptions,
          oid: descendant,
          ancestor: parent,
          depth: -1,
        }));
      if (isDescendant) {
        matches.push(parent);
      }
    } catch {
      // Missing objects or unrelated histories are not a match.
    }
  }

  return matches.length === 1 ? matches[0] : null;
}

function parseCodeowners(content) {
  const lines = content.split("\n");
  const owners = [];

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        const path = parts[0];
        const ownersList = parts.slice(1);
        owners.push({ path, owners: ownersList });
      }
    }
  });

  return owners;
}

function getFileOwnersHierarchical(filename, codeowners) {
  const normalizedFile = filename.startsWith("/") ? filename : "/" + filename;

  let bestMatch = null;
  let bestMatchLength = -1;

  codeowners.forEach((entry) => {
    if (pathMatches(normalizedFile, entry.path)) {
      const pathLength = entry.path.length;
      if (pathLength > bestMatchLength) {
        bestMatch = entry;
        bestMatchLength = pathLength;
      }
    }
  });

  return bestMatch ? bestMatch.owners : [];
}

function pathMatches(filename, pattern) {
  const normalizedFile = filename.startsWith("/") ? filename : "/" + filename;
  const normalizedPattern = pattern.startsWith("/") ? pattern : "/" + pattern;

  if (pattern === "*") return true;
  if (normalizedPattern === normalizedFile) return true;

  // Handle directory patterns (ending with /)
  if (pattern.endsWith("/")) {
    const dirPattern = pattern.startsWith("/") ? pattern : "/" + pattern;
    return normalizedFile.startsWith(dirPattern);
  }

  // Handle wildcard patterns
  if (pattern.includes("*")) {
    const regex = normalizedPattern.replace(/\*/g, ".*").replace(/\//g, "\\/");
    return new RegExp(`^${regex}$`).test(normalizedFile);
  }

  // Handle file/directory without trailing slash
  const filePattern = normalizedPattern.endsWith("/")
    ? normalizedPattern
    : normalizedPattern + "/";
  return (
    normalizedFile.startsWith(filePattern) ||
    normalizedFile === normalizedPattern
  );
}

function getRelevantTeams(fileOwnersMap) {
  const teams = new Set();

  for (const [filename, owners] of fileOwnersMap instanceof Map
    ? fileOwnersMap
    : fileOwnersMap.map((entry) => [entry.path, entry.owners])) {
    owners.forEach((owner) => {
      if (owner.startsWith(`${team_start_with}`)) {
        const teamName = owner.replace(`${team_start_with}`, "");
        teams.add(teamName);
      }
    });
    console.log(`filename: ${filename}`);
    console.log(`owners: ${owners}`);
  }

  return Array.from(teams);
}

function isUserCodeowner(username, codeowners, userTeamMemberships) {
  return codeowners.some((entry) =>
    entry.owners.some((owner) => {
      if (owner === `@${username}`) {
        return true;
      }

      if (owner.startsWith(`${team_start_with}`)) {
        const teamName = owner.replace(`${team_start_with}`, "");
        return userTeamMemberships?.get(teamName) === true;
      }

      return false;
    }),
  );
}

function containsUnownedChangedFile(fileOwnersMap) {
  return Array.from(fileOwnersMap.values()).some(
    (owners) => owners.length === 0,
  );
}

async function checkTeamMembership(username, teamSlug, headers) {
  try {
    const response = await fetch(
      `https://api.github.com/orgs/${owner}/teams/${teamSlug}/members/${username}`,
      { headers },
    );
    return response.status === 204;
  } catch (error) {
    console.log(`error: ${error}`);
    return false;
  }
}

function isUserCodeownerForFiles(username, fileOwnersMap, userTeamMemberships) {
  let isCodeowner = false;
  const ownedFiles = [];
  const viaTeams = new Set();

  for (const [filename, fileOwners] of fileOwnersMap) {
    for (const owner of fileOwners) {
      // Direct ownership
      if (owner === `@${username}`) {
        isCodeowner = true;
        ownedFiles.push(filename);
        break;
      }

      // Team ownership
      if (owner.startsWith(`${team_start_with}`)) {
        const teamName = owner.replace(`${team_start_with}`, "");
        if (userTeamMemberships && userTeamMemberships.get(teamName)) {
          isCodeowner = true;
          ownedFiles.push(filename);
          viaTeams.add(`${team_start_with}${teamName}`);
          break;
        }
      }
    }
  }

  return {
    isCodeowner,
    ownedFiles: [...new Set(ownedFiles)],
    viaTeams: Array.from(viaTeams),
  };
}

// Run if called directly
if (require.main === module) {
  smartDismissReviews();
}

module.exports = {
  smartDismissReviews,
  getAllChangedFiles,
  getAllReviews,
  getAllCommits,
  containsUnownedChangedFile,
  isUserCodeowner,
  findCleanBaseBranchMerge,
};
