export const DEFAULT_MODEL = "deepseek-ai/deepseek-v3.2";

const FALLBACK_CHAIN = [
  { provider: "custom-nvidia-nim", endpoint: "v1/chat/completions", model: "deepseek-ai/deepseek-v3.2" },
  { provider: "custom-nvidia-nim", endpoint: "v1/chat/completions", model: "deepseek-ai/deepseek-v3.1" },
  { provider: "custom-nvidia-nim", endpoint: "v1/chat/completions", model: "moonshotai/kimi-k2-instruct" },
  { provider: "custom-nvidia-nim", endpoint: "v1/chat/completions", model: "moonshotai/kimi-k2-instruct-0905" },
  { provider: "google-ai-studio", endpoint: "v1beta/openai/chat/completions", model: "gemini-2.5-flash" },
];

export interface AiGatewayConfig {
  baseUrl: string;
  cfAigToken: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export async function callAIGateway(
  config: AiGatewayConfig,
  _model: string,
  messages: Array<{ role: string; content: string }>,
  options: { temperature?: number; max_tokens?: number } = {},
): Promise<ChatCompletionResponse> {
  const errors: string[] = [];

  for (const step of FALLBACK_CHAIN) {
    const url = `${config.baseUrl}/${step.provider}/${step.endpoint}`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-aig-authorization": `Bearer ${config.cfAigToken}`,
        },
        body: JSON.stringify({
          model: step.model,
          messages,
          temperature: options.temperature ?? 0.1,
          max_tokens: options.max_tokens ?? 4096,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        errors.push(`${step.model}: ${response.status} ${body.slice(0, 100)}`);
        continue;
      }

      const data = (await response.json()) as ChatCompletionResponse;
      if (!data.choices?.[0]?.message?.content) {
        errors.push(`${step.model}: empty response`);
        continue;
      }

      if (step.model !== FALLBACK_CHAIN[0].model) {
        console.log(`Used fallback model: ${step.model}`);
      }
      return data;
    } catch (err) {
      errors.push(`${step.model}: ${err}`);
    }
  }

  throw new Error(`All models failed: ${errors.join(" | ")}`);
}

export function extractContent(response: ChatCompletionResponse): string {
  return response.choices?.[0]?.message?.content ?? "";
}
