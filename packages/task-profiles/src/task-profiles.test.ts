import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskProfileDedupeKey,
  createDefaultTaskProfileCatalog,
  createTaskProfileCatalog,
  listTaskProfiles,
  requireTaskProfile,
  resolveTaskProfileRequest,
} from "./index.js";

test("default task profile catalog covers lean email AI task shapes", () => {
  const catalog = createDefaultTaskProfileCatalog();
  const profiles = listTaskProfiles(catalog);

  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["classify", "summarize", "draft", "revise", "extract-json"],
  );
  assert.equal(catalog.defaultProfileId, "draft");
  assert.equal(requireTaskProfile("extract-json", catalog).responseFormat?.type, "json_object");

  const firstProfile = profiles[0];
  if (firstProfile) {
    firstProfile.metadata.promptFamily = "mutated";
  }

  assert.equal(listTaskProfiles(catalog)[0]?.metadata.promptFamily, "task.classify");
});

test("resolveTaskProfileRequest applies classify caps, cache, lane, and JSON mode", () => {
  const resolved = resolveTaskProfileRequest({
    profileId: "classify",
    request: {
      input: "Yes, I am interested. Can you send pricing?",
    },
  });

  assert.equal(resolved.request.maxTokens, 64);
  assert.equal(resolved.request.temperature, 0);
  assert.equal(resolved.request.topP, 0.9);
  assert.equal(resolved.request.cache, true);
  assert.equal(resolved.request.responseFormat?.type, "json_object");
  assert.equal(resolved.request.metadata?.promptLane, "short");
  assert.equal(resolved.request.metadata?.rayTaskProfile, "classify");
  assert.equal(resolved.execution.timeoutMs, 12_000);
  assert.equal(resolved.execution.cachePolicy, "read-write");
  assert.ok(resolved.request.dedupeKey);
});

test("resolveTaskProfileRequest lets explicit request controls win in defaults mode", () => {
  const resolved = resolveTaskProfileRequest({
    profileId: "summarize",
    request: {
      input: "Summarize the thread.",
      maxTokens: 48,
      temperature: 0.7,
      cache: false,
      metadata: {
        source: "unit-test",
        promptLane: "short",
      },
    },
  });

  assert.equal(resolved.request.maxTokens, 48);
  assert.equal(resolved.request.temperature, 0.7);
  assert.equal(resolved.request.topP, 0.9);
  assert.equal(resolved.request.cache, false);
  assert.equal(resolved.request.metadata?.source, "unit-test");
  assert.equal(resolved.request.metadata?.promptLane, "short");
  assert.equal(resolved.request.metadata?.rayTaskCachePolicy, "bypass");
  assert.equal(resolved.execution.lane, "short");
  assert.equal(resolved.execution.cachePolicy, "bypass");
});

test("profile mode forces the profile execution shape", () => {
  const resolved = resolveTaskProfileRequest({
    profileId: "classify",
    mode: "profile",
    request: {
      input: "Classify this reply.",
      maxTokens: 12,
      temperature: 1.2,
      cache: false,
      metadata: {
        promptLane: "draft",
      },
      responseFormat: {
        type: "text",
      },
    },
  });

  assert.equal(resolved.request.maxTokens, 64);
  assert.equal(resolved.request.temperature, 0);
  assert.equal(resolved.request.cache, true);
  assert.equal(resolved.request.responseFormat?.type, "json_object");
  assert.equal(resolved.request.metadata?.promptLane, "short");
  assert.equal(resolved.execution.lane, "short");
});

test("custom task profile catalogs validate duplicate and unknown profiles", () => {
  const draft = requireTaskProfile("draft");
  const catalog = createTaskProfileCatalog(
    [
      {
        ...draft,
        id: "email-draft-short",
        maxTokens: 96,
      },
    ],
    {
      defaultProfileId: "email-draft-short",
    },
  );

  assert.equal(requireTaskProfile("email-draft-short", catalog).maxTokens, 96);
  assert.throws(() => createTaskProfileCatalog([draft, draft]), /duplicate profile "draft"/);
  assert.throws(() => requireTaskProfile("missing", catalog), /Unknown task profile "missing"/);
});

test("task profile dedupe keys are stable and profile-specific", () => {
  const classify = requireTaskProfile("classify");
  const draft = requireTaskProfile("draft");
  const request = {
    input: "Same exact prompt",
  };

  assert.equal(
    buildTaskProfileDedupeKey(classify, request),
    buildTaskProfileDedupeKey(classify, request),
  );
  assert.notEqual(
    buildTaskProfileDedupeKey(classify, request),
    buildTaskProfileDedupeKey(draft, request),
  );
});
