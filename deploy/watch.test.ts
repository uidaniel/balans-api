/**
 * The thing that decides whether to deploy.
 *
 * Pushing and deploying used to be two separate manual acts, so the box ran
 * whatever commit somebody last remembered to ship — and nothing announced
 * the difference. `watch.sh` closes that by polling main once a minute.
 *
 * Which means it runs unattended, at three in the morning, against the
 * machine that takes people's money. The two things that matter are that a
 * bad commit cannot loop, and that a bad commit cannot leave the API down.
 * Both are branches nobody will ever exercise by hand.
 *
 * So this drives the real script against a scratch repository, with a fake
 * deploy.sh that can be told to fail. Nothing here builds a container: what
 * is under test is the decision, not the build.
 *
 * Skipped where bash is not available.
 */

import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HAS_BASH = spawnSync("bash", ["-c", "exit 0"]).status === 0;

const WATCH = fileURLToPath(new URL("./watch.sh", import.meta.url));
/**
 * Forward slashes, drive letter kept.
 *
 * Native git.exe does not understand an MSYS path like /c/Users, and bash
 * mangles the backslashes in a Windows one. C:/Users is the single spelling
 * both accept. On Linux this changes nothing.
 */
const posix = (p: string) => p.replace(/\\/g, "/");

describe("deciding whether to deploy", { skip: !HAS_BASH && "no bash" }, () => {
  let root: string;
  let origin: string;
  let app: string;
  let failed: string;
  /** Every deploy.sh invocation, so "did it deploy" is a fact not a guess. */
  let ran: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  before(() => {
    root = mkdtempSync(join(tmpdir(), "balans-watch-"));
    origin = join(root, "origin");
    app = join(root, "app");
    failed = join(root, "failed-deploy");
    ran = join(root, "ran.log");

    // A bare-ish origin with one commit on main.
    mkdirSync(origin);
    git(origin, "init", "--quiet", "--initial-branch=main");
    git(origin, "config", "user.email", "t@t.t");
    git(origin, "config", "user.name", "t");
    writeFileSync(join(origin, "app.txt"), "one\n");
    git(origin, "add", "-A");
    git(origin, "commit", "--quiet", "-m", "one");

    git(root, "clone", "--quiet", posix(origin), posix(app));
    git(app, "config", "user.email", "t@t.t");
    git(app, "config", "user.name", "t");

    mkdirSync(join(app, "deploy"));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  /**
   * A deploy.sh that records that it ran, honours DEPLOY_NO_FETCH the way the
   * real one does, and fails when told to.
   */
  const fakeDeploy = (opts: { failOn?: string } = {}) => {
    writeFileSync(
      join(app, "deploy", "deploy.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "\${DEPLOY_NO_FETCH:-}" != "1" ]; then
  git fetch --quiet origin main
  git reset --hard --quiet origin/main
fi
HEAD_SHA=$(git rev-parse HEAD)
echo "deploy \${HEAD_SHA} nofetch=\${DEPLOY_NO_FETCH:-0}" >> ${JSON.stringify(posix(ran))}
${opts.failOn ? `[ "$HEAD_SHA" = "${opts.failOn}" ] && exit 1` : ""}
exit 0
`,
      { mode: 0o755 },
    );
  };

  const run = () =>
    spawnSync("bash", [posix(WATCH)], {
      encoding: "utf8",
      env: { ...process.env, BALANS_APP: posix(app), BALANS_FAILED: posix(failed) },
    });

  const deploys = (): string[] =>
    existsSync(ran) ? readFileSync(ran, "utf8").trim().split("\n").filter(Boolean) : [];

  const push = (text: string): string => {
    writeFileSync(join(origin, "app.txt"), text);
    git(origin, "add", "-A");
    git(origin, "commit", "--quiet", "-m", text.trim());
    return git(origin, "rev-parse", "HEAD");
  };

  beforeEach(() => {
    rmSync(ran, { force: true });
    rmSync(failed, { force: true });
    fakeDeploy();
    // Back in step with origin, so each test starts from "nothing to do".
    git(app, "fetch", "--quiet", "origin", "main");
    git(app, "reset", "--hard", "--quiet", "origin/main");
  });

  it("does nothing when main has not moved", () => {
    const out = run();
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(deploys(), [], "it deployed when there was nothing to deploy");
  });

  it("deploys when main moves", () => {
    const sha = push("two\n");
    const out = run();

    assert.equal(out.status, 0, out.stderr);
    assert.equal(deploys().length, 1, "one deploy");
    assert.match(deploys()[0]!, new RegExp(sha), "and of the commit that was pushed");
  });

  it("says what moved, so the journal is readable", () => {
    push("three\n");
    const out = run();
    assert.match(out.stdout, /main moved: [0-9a-f]{7} -> [0-9a-f]{7}/);
  });

  it("does not deploy the same commit twice", () => {
    push("four\n");
    run();
    rmSync(ran, { force: true });

    const out = run();
    assert.equal(out.status, 0);
    assert.deepEqual(deploys(), [], "a second tick redeployed an unchanged main");
  });
});

describe("a commit that will not come up", { skip: !HAS_BASH && "no bash" }, () => {
  /*
   * The branch nobody exercises by hand, on the machine that takes money.
   *
   * A person running deploy.sh reads the failure and acts on it. A timer does
   * not, so a failed deploy has to put back what was working and then refuse
   * to try the same commit a minute later, for ever.
   */
  let root: string;
  let origin: string;
  let app: string;
  let failed: string;
  let ran: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  const posixp = posix;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "balans-watch-bad-"));
    origin = join(root, "origin");
    app = join(root, "app");
    failed = join(root, "failed-deploy");
    ran = join(root, "ran.log");

    mkdirSync(origin);
    git(origin, "init", "--quiet", "--initial-branch=main");
    git(origin, "config", "user.email", "t@t.t");
    git(origin, "config", "user.name", "t");
    writeFileSync(join(origin, "app.txt"), "good\n");
    git(origin, "add", "-A");
    git(origin, "commit", "--quiet", "-m", "good");

    git(root, "clone", "--quiet", posixp(origin), posixp(app));
    git(app, "config", "user.email", "t@t.t");
    git(app, "config", "user.name", "t");
    mkdirSync(join(app, "deploy"));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  const write = (failOn: string) =>
    writeFileSync(
      join(app, "deploy", "deploy.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "\${DEPLOY_NO_FETCH:-}" != "1" ]; then
  git fetch --quiet origin main
  git reset --hard --quiet origin/main
fi
HEAD_SHA=$(git rev-parse HEAD)
echo "deploy \${HEAD_SHA}" >> ${JSON.stringify(posixp(ran))}
[ "$HEAD_SHA" = "${failOn}" ] && exit 1
exit 0
`,
      { mode: 0o755 },
    );

  const run = () =>
    spawnSync("bash", [posixp(join(app, "..", "watch-copy.sh"))], {
      encoding: "utf8",
      env: { ...process.env, BALANS_APP: posixp(app), BALANS_FAILED: posixp(failed) },
    });

  it("rolls back to the commit that was working, and never tries the bad one again", () => {
    // watch.sh is copied rather than referenced so both suites can run at once.
    writeFileSync(join(root, "watch-copy.sh"), readFileSync(WATCH, "utf8"), { mode: 0o755 });

    const goodSha = git(app, "rev-parse", "HEAD");

    writeFileSync(join(origin, "app.txt"), "bad\n");
    git(origin, "add", "-A");
    git(origin, "commit", "--quiet", "-m", "bad");
    const badSha = git(origin, "rev-parse", "HEAD");

    write(badSha);

    const out = run();

    assert.equal(out.status, 1, "a failed deploy has to be a failed run");
    assert.match(out.stdout, /rolling back/i);

    assert.equal(
      git(app, "rev-parse", "HEAD"),
      goodSha,
      "the checkout was left on the commit that does not work",
    );

    const log = readFileSync(ran, "utf8").trim().split("\n");
    assert.equal(log.length, 2, "the bad build, then the rebuild of the good one");
    assert.match(log[0]!, new RegExp(badSha));
    assert.match(log[1]!, new RegExp(goodSha), "the rollback built the old commit, not main again");

    assert.equal(readFileSync(failed, "utf8").trim(), badSha, "and it recorded what failed");

    // The next tick, and the one after: main is still the bad commit.
    rmSync(ran, { force: true });
    const again = run();
    assert.equal(again.status, 0, "a known-bad commit is not an error every minute");
    assert.equal(existsSync(ran), false, "it tried the bad commit again");

    // Pushing anything clears it, because the sha stops matching.
    writeFileSync(join(origin, "app.txt"), "fixed\n");
    git(origin, "add", "-A");
    git(origin, "commit", "--quiet", "-m", "fixed");
    const fixedSha = git(origin, "rev-parse", "HEAD");

    const recovered = run();
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(readFileSync(ran, "utf8"), new RegExp(fixedSha), "the fix did not deploy");
    assert.equal(existsSync(failed), false, "the failure record outlived the failure");
  });
});
