import test from "node:test";
import assert from "node:assert/strict";
import { chooseProvider, eligible, isImageRequest, nextFailureState } from "../lib/router.js";
import { normalizeCookieInput, validateArenaCookieFormat } from "../lib/cookies.js";
import { resolveProjectPath } from "../lib/agent.js";

const provider = (id, priority, overrides = {}) => ({
  id, priority, enabled: true, endpoint_url: "https://example.invalid/v1/chat/completions",
  health_status: "healthy", failures: 0, quota_remaining: 100,
  capabilities: { chat: true, image: false }, ...overrides
});

test("router chooses the highest-priority healthy provider without an LLM call", () => {
  const result = chooseProvider([provider("b", 20), provider("a", 10)], null);
  assert.equal(result.provider.id, "a");
  assert.equal(result.reason, "primary");
});

test("router keeps a healthy sticky provider when the primary is unavailable and fails back when it recovers", () => {
  const b = provider("b", 20);
  const aDown = provider("a", 10, { health_status: "degraded" });
  assert.equal(chooseProvider([b, aDown], "b").provider.id, "b");
  assert.equal(chooseProvider([b, provider("a", 10)], "b").reason, "failback");
});

test("router excludes quota exhausted, quarantined, and image-incompatible providers", () => {
  assert.equal(eligible(provider("q", 1, { quota_remaining: 0 })), false);
  assert.equal(eligible(provider("f", 1, { failures: 5 })), false);
  assert.equal(eligible(provider("img", 1), true), false);
  assert.equal(isImageRequest({ messages: [{ content: [{ type: "image_url", image_url: { url: "x" } }] }] }), true);
});

test("provider is quarantined after the fifth consecutive failure", () => {
  assert.equal(nextFailureState({ failures: 4 }).quarantined, true);
});

test("Cookie-Editor JSON is normalized", () => {
  assert.equal(normalizeCookieInput(JSON.stringify([{ name: "a", value: "1" }, { name: "b", value: "two" }])), "a=1; b=two");
});

test("Arena cookie format rejects missing cookie and accepts a base64 payload", () => {
  assert.equal(validateArenaCookieFormat("other=1").valid, false);
  const payload = Buffer.from(JSON.stringify({ sub: "test" })).toString("base64");
  assert.equal(validateArenaCookieFormat("arena-auth-prod-v1.0=" + payload).valid, true);
});

test("project sandbox blocks traversal", () => {
  assert.throws(() => resolveProjectPath("/tmp/project", "../../etc/passwd"), /Path denied/);
  assert.equal(resolveProjectPath("/tmp/project", "src/index.js"), "/tmp/project/src/index.js");
});
