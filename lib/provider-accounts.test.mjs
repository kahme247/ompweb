import assert from "node:assert/strict";
import test from "node:test";

const { summarizeProviderAccounts, planForStoredAccount } = await import("./provider-accounts.ts");

test("distinct accounts are listed once even when usage is split per model/tier", () => {
  const reports = [
    { provider: "anthropic", accountLabel: "a@x.test", plan: "max" },
    { provider: "anthropic", accountLabel: "a@x.test", modelId: "opus" },
    { provider: "anthropic", accountLabel: "b@x.test" },
    { provider: "openai", accountLabel: "other@x.test" },
  ];
  assert.deepEqual(
    summarizeProviderAccounts(reports, "anthropic").map((a) => [a.label, a.plan]),
    [["a@x.test", "max"], ["b@x.test", undefined]],
  );
});

test("accounts without a label are told apart by their position", () => {
  const reports = [
    { provider: "p", accountIndex: 1 },
    { provider: "p", accountIndex: 2, noLimits: true },
    { provider: "p", accountIndex: 1, modelId: "m" },
  ];
  assert.deepEqual(summarizeProviderAccounts(reports, "p").map((a) => a.index), [1, 2]);
  assert.deepEqual(summarizeProviderAccounts(reports, "none"), []);
});

test("a usage plan is shown only for the one stored account its email identifies", () => {
  const usage = [{ key: "a@x.test", label: "a@x.test", plan: "max" }, { key: "b@x.test", label: "b@x.test", plan: "pro" }];
  const single = ["a@x.test (Org A)", "b@x.test"];
  assert.equal(planForStoredAccount("a@x.test (Org A)", single, usage), "max");
  assert.equal(planForStoredAccount("b@x.test", single, usage), "pro");
  // One email in two orgs: the bare-email usage row cannot tell them apart.
  const shared = ["a@x.test (Org A)", "a@x.test (Org B)"];
  assert.equal(planForStoredAccount("a@x.test (Org A)", shared, usage), undefined);
  assert.equal(planForStoredAccount("a@x.test.evil", ["a@x.test.evil"], usage), undefined);
});
