import assert from "node:assert/strict";
import test from "node:test";
import {
  PromptScaffoldCache,
  buildPromptScaffoldCacheKey,
  createPromptScaffold,
  createSentinelTemplateVariables,
  renderPromptFromScaffold,
  renderPromptScaffoldTemplate,
} from "./index.js";

test("renderPromptScaffoldTemplate creates sentinel variables for Email AI templates", () => {
  const scaffoldTemplate = renderPromptScaffoldTemplate("email.cold_outreach.v1");

  assert.equal(scaffoldTemplate.rendered.id, "email.cold_outreach.v1");
  assert.deepEqual(scaffoldTemplate.variableOrder, [
    "recipientRole",
    "topic",
    "valueProp",
    "companyContext",
  ]);
  assert.equal(scaffoldTemplate.sentinelVariables.recipientRole, "__RAY_PROMPT_VAR_0__");
  assert.match(scaffoldTemplate.rendered.input, /__RAY_PROMPT_VAR_0__/);
});

test("createPromptScaffold rehydrates rendered prompts from cached segments", () => {
  const sentinelVariables = createSentinelTemplateVariables("email.reply_rewrite.v1");
  const prompt = [
    "System header ",
    sentinelVariables.replyText,
    " middle ",
    sentinelVariables.rewriteGoal,
    " suffix",
  ].join("");
  const scaffold = createPromptScaffold({
    prompt,
    variableOrder: ["replyText", "rewriteGoal"],
    sentinelVariables,
    templateId: "email.reply_rewrite.v1",
    templateVersion: "v1",
    family: "email.reply_rewrite",
  });

  assert.deepEqual(scaffold.segments, ["System header ", " middle ", " suffix"]);
  assert.equal(
    renderPromptFromScaffold(scaffold, {
      replyText: "Can you send details?",
      rewriteGoal: "sound concise",
    }),
    "System header Can you send details? middle sound concise suffix",
  );
});

test("PromptScaffoldCache stores bounded cloned scaffolds and tracks hit ratios", () => {
  const key = buildPromptScaffoldCacheKey({
    modelRef: "qwen2.5-0.6b-razroo-email-ai",
    templateId: "email.reply_classification.v1",
    responseFormatType: "json_object",
  });
  const cache = new PromptScaffoldCache({
    maxEntries: 2,
    ttlMs: 60_000,
    maxBytes: 16_384,
  });
  const scaffold = createPromptScaffold({
    prompt: "prefix __RAY_PROMPT_VAR_0__ suffix",
    variableOrder: ["replyText"],
    sentinelVariables: {
      replyText: "__RAY_PROMPT_VAR_0__",
    },
  });

  assert.equal(cache.get(key), undefined);
  cache.set(key, scaffold);
  const cached = cache.get(key);

  assert.ok(cached);
  cached.segments.push("mutated");
  assert.deepEqual(cache.get(key)?.segments, ["prefix ", " suffix"]);
  assert.equal(cache.snapshot().hits, 2);
  assert.equal(cache.snapshot().misses, 1);
});

test("prompt scaffold helpers reject missing markers and variables", () => {
  assert.throws(
    () =>
      createPromptScaffold({
        prompt: "no sentinel here",
        variableOrder: ["replyText"],
        sentinelVariables: {
          replyText: "__RAY_PROMPT_VAR_0__",
        },
      }),
    /Prompt scaffold marker "replyText" was not found/,
  );

  const scaffold = createPromptScaffold({
    prompt: "prefix __RAY_PROMPT_VAR_0__ suffix",
    variableOrder: ["replyText"],
    sentinelVariables: {
      replyText: "__RAY_PROMPT_VAR_0__",
    },
  });

  assert.throws(
    () => renderPromptFromScaffold(scaffold, {}),
    /Missing template variable "replyText"/,
  );
});
