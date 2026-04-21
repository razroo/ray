import {
  sleep,
  type MockProviderConfig,
  type ModelConfig,
  type ModelProvider,
  type NormalizedInferenceRequest,
  type ProviderContext,
  type ProviderResult,
} from "@ray/core";

export class MockProvider implements ModelProvider {
  readonly kind = "mock";
  readonly modelId: string;
  readonly capabilities = {
    streaming: false,
    quantized: false,
    localBackend: true,
  } as const;

  constructor(
    private readonly model: ModelConfig,
    private readonly adapter: MockProviderConfig,
  ) {
    this.modelId = model.id;
  }

  async infer(
    request: NormalizedInferenceRequest,
    context: ProviderContext,
  ): Promise<ProviderResult> {
    await sleep(this.adapter.latencyMs);

    const systemPrefix = request.system ? `system=${request.system.slice(0, 72)}\n` : "";
    const body = request.input.slice(0, 320);
    const seed = this.adapter.seed ?? "ray";
    const output = `[ray:mock model=${this.model.id} profile=${context.config.profile} seed=${seed}]\n${systemPrefix}${body}`;
    const promptChars = request.input.length + (request.system?.length ?? 0);
    const completionChars = output.length;

    return {
      output,
      usage: {
        chars: {
          prompt: promptChars,
          completion: completionChars,
          total: promptChars + completionChars,
        },
      },
    };
  }
}
