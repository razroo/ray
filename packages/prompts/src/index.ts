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

function normalizeTemplateVariables(
  variables: PromptTemplateVariables | undefined,
): Record<string, string> {
  if (!variables) {
    return {};
  }

  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(variables)) {
    if (!isNonEmptyString(key)) {
      throw new RayError("template variable keys must be non-empty strings", {
        code: "invalid_request",
        status: 400,
      });
    }

    normalized[key] = String(value);
  }

  return normalized;
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
  const template = promptTemplateMap.get(id);
  return template ? structuredClone(template) : undefined;
}

export function requirePromptTemplate(id: string): PromptTemplateDefinition {
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
  const template = requirePromptTemplate(id);
  const normalizedVariables = normalizeTemplateVariables(templateVariables);
  const metadata = {
    ...(template.defaultMetadata ?? {}),
    promptFamily: template.family,
    promptTemplateId: template.id,
    promptTemplateVersion: template.version,
    promptLane: template.lane,
  };

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
    ...(template.responseFormat ? { responseFormat: template.responseFormat } : {}),
    metadata,
    templateVariables: normalizedVariables,
  };
}

export function resolvePromptTemplateRequest(
  request: PromptTemplatedRequestLike,
): ResolvedPromptTemplateRequest {
  const metadata = structuredClone(request.metadata ?? {});

  if (!request.templateId) {
    return {
      ...(request.input !== undefined ? { input: request.input } : {}),
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
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
    ...((request.responseFormat ?? rendered.responseFormat)
      ? { responseFormat: request.responseFormat ?? rendered.responseFormat }
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
