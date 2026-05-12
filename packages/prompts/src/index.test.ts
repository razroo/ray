import test from "node:test";
import assert from "node:assert/strict";
import { getPromptTemplate, renderPromptTemplate, resolvePromptTemplateRequest } from "./index.js";

test("renderPromptTemplate renders catalog templates with metadata", () => {
  const rendered = renderPromptTemplate("email.cold_outreach.v1", {
    recipientRole: "VP Engineering",
    topic: "faster CI runs",
    valueProp: "cut flaky builds and idle time",
    companyContext: "40-person SaaS engineering team",
  });

  assert.match(rendered.input, /VP Engineering/);
  assert.equal(rendered.lane, "draft");
  assert.equal(rendered.metadata.promptFamily, "email.cold_outreach");
});

test("resolvePromptTemplateRequest returns canonical prompt metadata", () => {
  const resolved = resolvePromptTemplateRequest({
    templateId: "email.reply_classification.v1",
    templateVariables: {
      replyText: "Sounds useful, send pricing.",
    },
  });

  assert.equal(resolved.promptTemplateId, "email.reply_classification.v1");
  assert.equal(resolved.promptLane, "short");
  assert.equal(resolved.promptFamily, "email.reply_classification");
  assert.equal(resolved.responseFormat?.type, "json_object");
});

test("prompt template lookups snapshot returned definitions", () => {
  const template = getPromptTemplate("email.reply_classification.v1");
  const next = getPromptTemplate("email.reply_classification.v1");

  if (!template || !next) {
    throw new Error("Expected prompt template");
  }

  template.variables.push("mutated");

  assert.equal(next.variables.includes("mutated"), false);
});

test("renderPromptTemplate rejects malformed template variables", () => {
  assert.throws(
    () =>
      renderPromptTemplate(
        "email.reply_classification.v1",
        "not-an-object" as unknown as Parameters<typeof renderPromptTemplate>[1],
      ),
    /templateVariables must be an object/,
  );

  assert.throws(
    () =>
      renderPromptTemplate("email.reply_classification.v1", {
        replyText: {
          text: "Nested values should not be coerced",
        },
      } as unknown as Parameters<typeof renderPromptTemplate>[1]),
    /template variable values must be strings, numbers, or booleans/,
  );

  assert.throws(
    () =>
      renderPromptTemplate(
        "email.reply_classification.v1",
        Object.fromEntries(
          Array.from({ length: 33 }, (_value, index) => [`field${index}`, "value"]),
        ),
      ),
    /templateVariables must contain at most 32 entries/,
  );

  assert.throws(
    () =>
      renderPromptTemplate("email.reply_classification.v1", {
        replyText: "x".repeat(16_385),
      }),
    /templateVariables\.replyText must be at most 16384 characters/,
  );

  assert.throws(
    () => renderPromptTemplate("x".repeat(129), {}),
    /templateId must be at most 128 characters/,
  );

  assert.throws(
    () =>
      renderPromptTemplate("email.reply_classification.v1", {
        replyText: "Sounds useful.",
        unusedContext: "this value should not be retained",
      }),
    /templateVariables contains unsupported keys/,
  );
});

test("renderPromptTemplate rejects unsafe or unreadable direct variables", () => {
  assert.throws(
    () =>
      renderPromptTemplate(
        "email.reply_classification.v1",
        JSON.parse('{"__proto__":"polluted","replyText":"Sounds useful."}'),
      ),
    /templateVariables must not contain unsafe key "__proto__"/,
  );

  const variables = {};
  Object.defineProperty(variables, "replyText", {
    enumerable: true,
    get() {
      throw new Error("getter boom");
    },
  });

  assert.throws(
    () =>
      renderPromptTemplate(
        "email.reply_classification.v1",
        variables as Parameters<typeof renderPromptTemplate>[1],
      ),
    /templateVariables must not contain unreadable properties/,
  );
});

test("renderPromptTemplate rejects malformed direct template ids", () => {
  assert.throws(() => getPromptTemplate(null as unknown as string), /templateId must be a string/);

  assert.throws(
    () => renderPromptTemplate(null as unknown as string, {}),
    /templateId must be a string/,
  );
});

test("resolvePromptTemplateRequest rejects malformed direct requests", () => {
  assert.throws(
    () =>
      resolvePromptTemplateRequest(
        null as unknown as Parameters<typeof resolvePromptTemplateRequest>[0],
      ),
    /request must be an object/,
  );

  assert.throws(
    () =>
      resolvePromptTemplateRequest({
        input: { nested: "value" } as unknown as string,
      }),
    /input must be a string/,
  );

  assert.throws(
    () =>
      resolvePromptTemplateRequest({
        input: "hello",
        metadata: {
          count: 1,
        } as unknown as Record<string, string>,
      }),
    /metadata must be an object of string values/,
  );

  assert.throws(
    () =>
      resolvePromptTemplateRequest({
        input: "hello",
        metadata: JSON.parse('{"constructor":"polluted"}') as Record<string, string>,
      }),
    /metadata must not contain unsafe key "constructor"/,
  );

  assert.throws(
    () =>
      resolvePromptTemplateRequest({
        input: "hello",
        responseFormat: { type: "xml" } as never,
      }),
    /responseFormat\.type must be 'text' or 'json_object'/,
  );
});

test("resolvePromptTemplateRequest snapshots direct metadata and response format", () => {
  const request = {
    input: "hello",
    metadata: {
      tenant: "initial",
    },
    responseFormat: {
      type: "json_object" as "text" | "json_object",
    },
  };

  const resolved = resolvePromptTemplateRequest(request);

  request.metadata.tenant = "mutated";
  request.responseFormat.type = "text";

  assert.equal(resolved.metadata.tenant, "initial");
  assert.equal(resolved.responseFormat?.type, "json_object");
});
