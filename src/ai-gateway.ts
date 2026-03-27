export const DEFAULT_MODEL = "deepseek-ai/deepseek-v3.2";

const FALLBACK_MODELS = [
  { provider: "nvidia", model: "deepseek-ai/deepseek-v3.2" },
  { provider: "nvidia", model: "deepseek-ai/deepseek-v3.1" },
  { provider: "nvidia", model: "kimi-ai/kimi-k2-instruct" },
  { provider: "gemini", model: "google-ai-studio/gemini-2.5-flash" },
];

export interface AiGatewayConfig {
  gatewayBaseUrl: string;
  nvidiaApiKey: string;
  googleAiStudioKey: string;
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

  for (const fallback of FALLBACK_MODELS) {
    const { url, authHeader } = resolveProvider(config, fallback);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": authHeader,
          "cf-aig-authorization": `Bearer ${config.cfAigToken}`,
        },
        body: JSON.stringify({
          model: fallback.model,
          messages,
          temperature: options.temperature ?? 0.1,
          max_tokens: options.max_tokens ?? 4096,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        errors.push(`${fallback.model}: ${response.status} ${body.slice(0, 100)}`);
        continue;
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        errors.push(`${fallback.model}: empty response`);
        continue;
      }

      if (fallback.model !== FALLBACK_MODELS[0].model) {
        console.log(`Used fallback model: ${fallback.model}`);
      }
      return data;
    } catch (err) {
      errors.push(`${fallback.model}: ${err}`);
    }
  }

  throw new Error(`All models failed: ${errors.join(" | ")}`);
}

function resolveProvider(
  config: AiGatewayConfig,
  fallback: { provider: string; model: string },
): { url: string; authHeader: string } {
  if (fallback.provider === "nvidia") {
    return {
      url: `${config.gatewayBaseUrl}/custom-nvidia-nim/v1/chat/completions`,
      authHeader: `Bearer ${config.nvidiaApiKey}`,
    };
  }
  return {
    url: `${config.gatewayBaseUrl}/compat/chat/completions`,
    authHeader: `Bearer ${config.googleAiStudioKey}`,
  };
}

export function extractContent(response: ChatCompletionResponse): string {
  return response.choices?.[0]?.message?.content ?? "";
}
