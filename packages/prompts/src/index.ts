import {
  RayError,
  isNonEmptyString,
  type InferenceResponseFormat,
  type PromptTemplateVariables,
  type ScheduleLane,
} from "@razroo/ray-core";

export interface PromptTemplateDefinition {
  id: string;
  version: string;
  family: string;
  lane: ScheduleLane;
  variables: string[];
  inputTemplate: string;
  systemTemplate?: string;
  defaultMaxTokens?: number;
  responseFormat?: InferenceResponseFormat;
  defaultMetadata?: Record<string, string>;
}

export interface RenderedPromptTemplate {
  id: string;
  version: string;
  family: string;
  lane: ScheduleLane;
  input: string;
  system?: string;
  maxTokens?: number;
  responseFormat?: InferenceResponseFormat;
  metadata: Record<string, string>;
  templateVariables: Record<string, string>;
}

export interface PromptTemplatedRequestLike {
  input?: string;
  system?: string;
  maxTokens?: number;
  responseFormat?: InferenceResponseFormat;
  metadata?: Record<string, string>;
  templateId?: string;
  templateVariables?: PromptTemplateVariables;
}

export interface ResolvedPromptTemplateRequest {
  input?: string;
  system?: string;
  maxTokens?: number;
  responseFormat?: InferenceResponseFormat;
  metadata: Record<string, string>;
  promptTemplateId?: string;
  templateVariables?: Record<string, string>;
  promptLane?: ScheduleLane;
  promptFamily?: string;
}

const promptTemplates: PromptTemplateDefinition[] = [
  {
    id: "email.cold_outreach.v1",
    version: "v1",
    family: "email.cold_outreach",
    lane: "draft",
    variables: ["recipientRole", "topic", "valueProp", "companyContext"],
    systemTemplate:
      "You are an email writing assistant. Write only the email body. Keep it concise, specific, practical, and grounded in the prompt.",
    inputTemplate: `Draft a short cold outreach email body.
Recipient role: {{recipientRole}}
Topic: {{topic}}
Value proposition: {{valueProp}}
Company context: {{companyContext}}`,
    defaultMaxTokens: 140,
  },
  {
    id: "email.follow_up.v1",
    version: "v1",
    family: "email.follow_up",
    lane: "draft",
    variables: ["previousTopic", "recipientRole", "reasonToReply"],
    systemTemplate:
      "You are an email writing assistant. Write only the email body. Keep it concise, polite, and direct.",
    inputTemplate: `Draft a short follow-up email body.
Recipient role: {{recipientRole}}
Previous outreach topic: {{previousTopic}}
Reason they should reply now: {{reasonToReply}}`,
    defaultMaxTokens: 120,
  },
  {
    id: "email.reply_classification.v1",
    version: "v1",
    family: "email.reply_classification",
    lane: "short",
    variables: ["replyText"],
    systemTemplate:
      "You classify inbound email replies. Return only compact JSON with keys sentiment, intent, and urgency.",
    inputTemplate: `Classify this reply: "{{replyText}}"`,
    defaultMaxTokens: 80,
    responseFormat: {
      type: "json_object",
    },
  },
  {
    id: "email.reply_rewrite.v1",
    version: "v1",
    family: "email.reply_rewrite",
    lane: "short",
    variables: ["replyText", "rewriteGoal"],
    systemTemplate:
      "You rewrite email replies. Write only the email body in plain text. Keep it warm, direct, and concise.",
    inputTemplate: `Rewrite this reply.
Goal: {{rewriteGoal}}
Original reply: "{{replyText}}"`,
    defaultMaxTokens: 120,
  },
];

const promptTemplateMap = new Map(promptTemplates.map((template) => [template.id, template]));
const MAX_TEMPLATE_ID_CHARS = 128;
const MAX_TEMPLATE_VARIABLES = 32;
const MAX_TEMPLATE_VARIABLE_KEY_CHARS = 128;
const MAX_TEMPLATE_VARIABLE_VALUE_CHARS = 16_384;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_KEY_CHARS = 128;
const MAX_METADATA_VALUE_CHARS = 1_024;
const unsafeObjectKeys = new Set(["__proto__", "constructor", "prototype"]);

function assertStringLength(value: string, label: string, maxChars: number): void {
  if (value.length > maxChars) {
    throw new RayError(`${label} must be at most ${maxChars} characters`, {
      code: "invalid_request",
      status: 400,
      details: {
        maxChars,
        actualChars: value.length,
      },
    });
  }
}

function assertTemplateId(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new RayError("templateId must be a string", {
      code: "invalid_request",
      status: 400,
      details: { value },
    });
  }

  assertStringLength(value, "templateId", MAX_TEMPLATE_ID_CHARS);
}

function assertPromptRequest(value: unknown): asserts value is PromptTemplatedRequestLike {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RayError("request must be an object", {
      code: "invalid_request",
      status: 400,
      details: { value },
    });
  }
}

function assertOptionalString(value: unknown, label: string): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new RayError(`${label} must be a string when provided`, {
      code: "invalid_request",
      status: 400,
      details: { value },
    });
  }
}

function assertSafeObjectKey(key: string, label: string): void {
  if (unsafeObjectKeys.has(key)) {
    throw new RayError(`${label} must not contain unsafe key "${key}"`, {
      code: "invalid_request",
      status: 400,
      details: { key },
    });
  }
}

function objectEntries(value: object, label: string): Array<[string, unknown]> {
  try {
    return Object.entries(value);
  } catch (error) {
    throw new RayError(`${label} must not contain unreadable properties`, {
      code: "invalid_request",
      status: 400,
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

function normalizeTemplateVariables(
  variables: PromptTemplateVariables | undefined,
): Record<string, string> {
  if (variables === undefined) {
    return {};
  }

  if (variables === null || typeof variables !== "object" || Array.isArray(variables)) {
    throw new RayError("templateVariables must be an object when provided", {
      code: "invalid_request",
      status: 400,
      details: { value: variables },
    });
  }

  const normalized = Object.create(null) as Record<string, string>;
  const entries = objectEntries(variables, "templateVariables");

  if (entries.length > MAX_TEMPLATE_VARIABLES) {
    throw new RayError(`templateVariables must contain at most ${MAX_TEMPLATE_VARIABLES} entries`, {
      code: "invalid_request",
      status: 400,
      details: {
        maxEntries: MAX_TEMPLATE_VARIABLES,
        actualEntries: entries.length,
      },
    });
  }

  for (const [key, value] of entries) {
    assertSafeObjectKey(key, "templateVariables");

    if (!isNonEmptyString(key)) {
      throw new RayError("template variable keys must be non-empty strings", {
        code: "invalid_request",
        status: 400,
      });
    }

    assertStringLength(key, "template variable keys", MAX_TEMPLATE_VARIABLE_KEY_CHARS);

    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new RayError("template variable values must be strings, numbers, or booleans", {
        code: "invalid_request",
        status: 400,
        details: { key, value },
      });
    }

    const normalizedValue = String(value);
    assertStringLength(
      normalizedValue,
      `templateVariables.${key}`,
      MAX_TEMPLATE_VARIABLE_VALUE_CHARS,
    );

    normalized[key] = normalizedValue;
  }

  return normalized;
}

function normalizeMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  if (metadata === undefined) {
    return {};
  }

  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new RayError("metadata must be an object of string values when provided", {
      code: "invalid_request",
      status: 400,
      details: { value: metadata },
    });
  }

  const normalized = Object.create(null) as Record<string, string>;
  const entries = objectEntries(metadata, "metadata");

  if (entries.length > MAX_METADATA_ENTRIES) {
    throw new RayError(`metadata must contain at most ${MAX_METADATA_ENTRIES} entries`, {
      code: "invalid_request",
      status: 400,
      details: {
        maxEntries: MAX_METADATA_ENTRIES,
        actualEntries: entries.length,
      },
    });
  }

  for (const [key, value] of entries) {
    assertSafeObjectKey(key, "metadata");

    if (!isNonEmptyString(key) || typeof value !== "string") {
      throw new RayError("metadata must be an object of string values when provided", {
        code: "invalid_request",
        status: 400,
        details: { key },
      });
    }

    assertStringLength(key, "metadata keys", MAX_METADATA_KEY_CHARS);
    assertStringLength(value, `metadata.${key}`, MAX_METADATA_VALUE_CHARS);

    normalized[key] = value;
  }

  return normalized;
}

function normalizeResponseFormat(
  responseFormat: InferenceResponseFormat | undefined,
): InferenceResponseFormat | undefined {
  if (responseFormat === undefined) {
    return undefined;
  }

  if (
    responseFormat === null ||
    typeof responseFormat !== "object" ||
    (responseFormat.type !== "text" && responseFormat.type !== "json_object")
  ) {
    throw new RayError("responseFormat.type must be 'text' or 'json_object' when provided", {
      code: "invalid_request",
      status: 400,
    });
  }

  return { type: responseFormat.type };
}

function renderStringTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, variableName: string) => {
    const value = variables[variableName];

    if (!isNonEmptyString(value) && value !== "") {
      throw new RayError(`Missing template variable "${variableName}"`, {
        code: "invalid_request",
        status: 400,
      });
    }

    return value;
  });
}

export function listPromptTemplates(): PromptTemplateDefinition[] {
  return promptTemplates.map((template) => structuredClone(template));
}

export function getPromptTemplate(id: string): PromptTemplateDefinition | undefined {
  assertTemplateId(id);

  const template = promptTemplateMap.get(id);
  return template ? structuredClone(template) : undefined;
}

export function requirePromptTemplate(id: string): PromptTemplateDefinition {
  assertTemplateId(id);

  const template = getPromptTemplate(id);

  if (!template) {
    throw new RayError(`Unknown prompt template "${id}"`, {
      code: "invalid_request",
      status: 400,
    });
  }

  return template;
}

export function renderPromptTemplate(
  id: string,
  templateVariables: PromptTemplateVariables | undefined,
): RenderedPromptTemplate {
  assertTemplateId(id);

  const template = requirePromptTemplate(id);
  const normalizedVariables = normalizeTemplateVariables(templateVariables);
  const supportedVariables = new Set(template.variables);
  const unsupportedVariables = Object.keys(normalizedVariables).filter(
    (key) => !supportedVariables.has(key),
  );

  if (unsupportedVariables.length > 0) {
    throw new RayError(`templateVariables contains unsupported keys for template "${id}"`, {
      code: "invalid_request",
      status: 400,
      details: {
        templateId: id,
        unsupportedKeys: unsupportedVariables,
        supportedKeys: template.variables,
      },
    });
  }

  const metadata = {
    ...(template.defaultMetadata ?? {}),
    promptFamily: template.family,
    promptTemplateId: template.id,
    promptTemplateVersion: template.version,
    promptLane: template.lane,
  };
  const responseFormat = normalizeResponseFormat(template.responseFormat);

  return {
    id: template.id,
    version: template.version,
    family: template.family,
    lane: template.lane,
    input: renderStringTemplate(template.inputTemplate, normalizedVariables),
    ...(template.systemTemplate
      ? {
          system: renderStringTemplate(template.systemTemplate, normalizedVariables),
        }
      : {}),
    ...(template.defaultMaxTokens !== undefined ? { maxTokens: template.defaultMaxTokens } : {}),
    ...(responseFormat ? { responseFormat } : {}),
    metadata,
    templateVariables: normalizedVariables,
  };
}

export function resolvePromptTemplateRequest(
  request: PromptTemplatedRequestLike,
): ResolvedPromptTemplateRequest {
  assertPromptRequest(request);
  assertOptionalString(request.input, "input");
  assertOptionalString(request.system, "system");
  assertOptionalString(request.templateId, "templateId");

  const metadata = normalizeMetadata(request.metadata);
  const responseFormat = normalizeResponseFormat(request.responseFormat);

  if (!request.templateId) {
    return {
      ...(request.input !== undefined ? { input: request.input } : {}),
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      ...(responseFormat ? { responseFormat } : {}),
      metadata,
    };
  }

  if (request.input !== undefined || request.system !== undefined) {
    throw new RayError("templateId requests must not also provide raw input or system fields", {
      code: "invalid_request",
      status: 400,
    });
  }

  const rendered = renderPromptTemplate(request.templateId, request.templateVariables);

  return {
    input: rendered.input,
    ...(rendered.system ? { system: rendered.system } : {}),
    ...((request.maxTokens ?? rendered.maxTokens)
      ? { maxTokens: request.maxTokens ?? rendered.maxTokens }
      : {}),
    ...((responseFormat ?? rendered.responseFormat)
      ? { responseFormat: responseFormat ?? rendered.responseFormat }
      : {}),
    metadata: {
      ...metadata,
      ...rendered.metadata,
    },
    promptTemplateId: rendered.id,
    templateVariables: rendered.templateVariables,
    promptLane: rendered.lane,
    promptFamily: rendered.family,
  };
}
