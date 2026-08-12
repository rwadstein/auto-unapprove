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

    // Step 2: Get PR reviews, CODEOWNERS, and commit authors in parallel
    console.log(`\n👥 Fetching PR reviews, CODEOWNERS, and commit authors...`);

    console.log(`🎯 Target branch: ${targetBranch}`);

    const [codeownersResponse] = await Promise.all([
      fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${codeownersFile}?ref=${targetBranch}`,
        { headers },
      ),
    ]);

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
    if (hasUnownedChangedFile) {
      console.log(
        `⚠️  At least one changed file has no codeowners; non-owner approvals will be dismissed`,
      );
    }

    // Step 5: Get relevant teams (only for changed files)
    const relevantTeams = getRelevantTeams(changedFileOwners);
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

      const isCommitAuthor = commitAuthors.has(reviewer);
      const shouldDismissForUnownedFile =
        hasUnownedChangedFile && !isCodeowner;
      let hasStaleApproval = false;
      let staleReason = "";
      let commitsAfterApproval = [];
      let affectedOwnedFiles = [];

      // Get reviewer's approvals with timestamps
      const reviewerApprovals = approvedReviews.filter(
        (r) => r.user.login === reviewer,
      );

      if (isCodeowner && reviewerApprovals.length > 0) {
        // Check for commits after approval to owned files
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

          // Check if post-approval commits actually touched owned files
          affectedOwnedFiles = [];

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

                // Check if any commit files are owned by this reviewer
                const intersection = commitFiles.filter((file) =>
                  ownedFiles.includes(file),
                );
                if (intersection.length > 0) {
                  affectedOwnedFiles.push(...intersection);
                  console.log(
                    `       🎯 Modified owned files: ${intersection.join(", ")}`,
                  );
                }
              }
            } catch (error) {
              console.log(
                `       ⚠️ Could not fetch commit details: ${error.message}`,
              );
            }
          }

          if (affectedOwnedFiles.length > 0) {
            hasStaleApproval = true;
            staleReason = `Approval became stale - commits modified owned files: ${[...new Set(affectedOwnedFiles)].join(", ")}`;
          } else {
            console.log(
              `     ✅ No owned files modified - approval stays valid`,
            );
          }
        }
      }

      // Dismiss non-owners when any changed file has no owners. Otherwise,
      // dismiss code owners who authored commits or have stale approvals.
      if (
        shouldDismissForUnownedFile ||
        (isCodeowner && (isCommitAuthor || hasStaleApproval))
      ) {
        const reviewIds = reviewerApprovals.map((r) => r.id);
        let reason;
        if (shouldDismissForUnownedFile) {
          reason = "Reviewer is not a codeowner for any changed file";
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
            ? [...new Set(affectedOwnedFiles)].length
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

  for (const [filename, owners] of fileOwnersMap) {
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
};
