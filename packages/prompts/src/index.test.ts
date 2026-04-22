import test from "node:test";
import assert from "node:assert/strict";
import { renderPromptTemplate, resolvePromptTemplateRequest } from "./index.js";

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
