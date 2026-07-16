import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["GitHub token", /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/],
  ["Meta access token", /\bEAA[A-Za-z0-9]{40,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/]
];
const maximumFileBytes = 2_000_000;
const findings = new Set();

function scan(content, location) {
  if (content.length > maximumFileBytes || content.includes(0)) return;
  const text = content.toString("utf8");
  for (const [name, pattern] of patterns) {
    if (pattern.test(text)) findings.add(`${name} in ${location}`);
  }
}

const workingFiles = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"])
  .toString("utf8")
  .split("\u0000")
  .filter(Boolean);
for (const path of workingFiles) {
  if (path === "package-lock.json") continue;
  try {
    scan(readFileSync(path), `worktree:${path}`);
  } catch {
    // A concurrently removed or non-regular path is ignored.
  }
}

const commits = execFileSync("git", ["rev-list", "--all"]).toString("utf8").trim().split("\n").filter(Boolean);
for (const commit of commits) {
  const paths = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", commit])
    .toString("utf8")
    .split("\u0000")
    .filter(Boolean);
  for (const path of paths) {
    if (path === "package-lock.json") continue;
    try {
      scan(
        execFileSync("git", ["show", `${commit}:${path}`], { maxBuffer: maximumFileBytes + 1 }),
        `${commit.slice(0, 12)}:${path}`
      );
    } catch {
      // Oversized and non-blob entries are safely skipped.
    }
  }
}

if (findings.size > 0) {
  process.stderr.write(`Potential committed secrets detected:\n${[...findings].sort().join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Secret scan passed across ${commits.length} commit(s).\n`);
