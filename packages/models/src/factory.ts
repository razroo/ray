import { RayError, type ModelConfig, type ModelProvider } from "@ray/core";
import { MockProvider } from "./providers/mock.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";

export function createModelProvider(model: ModelConfig): ModelProvider {
  switch (model.adapter.kind) {
    case "mock":
      return new MockProvider(model, model.adapter);
    case "openai-compatible":
      return new OpenAICompatibleProvider(model, model.adapter);
    default:
      throw new RayError(`Unsupported model adapter`, {
        code: "provider_unsupported",
        status: 500,
        details: model.adapter,
      });
  }
}

