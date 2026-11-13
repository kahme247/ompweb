import assert from "node:assert/strict";
import test from "node:test";

const { GhError, GhUnavailableError, checkGh, formatTarget, parseGithubTarget } = await import("./gh.ts");

const NOT_INSTALLED = "`gh` (GitHub CLI) is not installed on the omp-web server machine. Ask the user to install it and run `gh auth login` there.";
const NOT_LOGGED_IN = "`gh` is not logged in on the omp-web server machine. Ask the user to run `gh auth login` there.";

test("checkGh maps a missing binary and a logged-out gh to the spec's messages", async () => {
  const missing = async () => {
    throw new GhError("spawn gh ENOENT", "", "ENOENT");
  };
  await assert.rejects(checkGh(missing, () => 0), (error) => {
    assert.ok(error instanceof GhUnavailableError);
    assert.equal(error.message, NOT_INSTALLED);
    return true;
  });

  const loggedOut = async () => {
    throw new GhError("gh api user failed", "To get started with GitHub CLI, please run:  gh auth login", 4);
  };
  await assert.rejects(checkGh(loggedOut, () => 0), (error) => {
    assert.ok(error instanceof GhUnavailableError);
    assert.equal(error.message, NOT_LOGGED_IN);
    return true;
  });

  const http401 = async () => {
    throw new GhError("gh api user failed", "HTTP 401: Bad credentials", 1);
  };
  await assert.rejects(checkGh(http401, () => 0), { message: NOT_LOGGED_IN });

  // Any other failure is not "gh unavailable"; the real error reaches the caller.
  const network = async () => {
    throw new GhError("gh api user failed", "dial tcp: i/o timeout", 1);
  };
  await assert.rejects(checkGh(network, () => 0), (error) => {
    assert.ok(error instanceof GhError);
    assert.ok(!(error instanceof GhUnavailableError));
    return true;
  });
});

test("checkGh caches a success for 60 s", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return "octocat\n";
  };
  assert.deepEqual(await checkGh(run, () => 1_000), { login: "octocat" });
  assert.deepEqual(calls, [["api", "user", "--jq", ".login"]]);

  assert.deepEqual(await checkGh(run, () => 60_999), { login: "octocat" });
  assert.equal(calls.length, 1);

  assert.deepEqual(await checkGh(run, () => 61_000), { login: "octocat" });
  assert.equal(calls.length, 2);
});

test("parseGithubTarget accepts both forms and refuses others", () => {
  const expected = { owner: "octo-cat", repo: "hello.world", number: 12 };
  assert.deepEqual(parseGithubTarget("octo-cat/hello.world#12"), expected);
  assert.deepEqual(parseGithubTarget("https://github.com/octo-cat/hello.world/pull/12"), expected);
  assert.deepEqual(parseGithubTarget("https://github.com/octo-cat/hello.world/issues/12"), expected);
  assert.deepEqual(parseGithubTarget("https://github.com/octo-cat/hello.world/pull/12/files?w=1#diff-x"), expected);
  assert.deepEqual(parseGithubTarget("https://github.com/octo-cat/hello.world/issues/12/"), expected);
  assert.equal(formatTarget(expected), "octo-cat/hello.world#12");

  const refused = [
    "owner/repo",
    "owner/repo#0",
    "owner/repo#12abc",
    "owner/repo#",
    "owner/../repo#1",
    "https://gitlab.com/owner/repo/pull/12",
    "https://github.com/owner/repo/commit/12",
    "https://github.com/owner/repo/pull/0",
    "http://github.com/owner/repo/pull/12",
    "",
  ];
  for (const value of refused) {
    assert.throws(
      () => parseGithubTarget(value),
      { message: 'Agent tool argument "target" must be OWNER/REPO#N or a GitHub pull request or issue URL.' },
      value,
    );
  }
});
