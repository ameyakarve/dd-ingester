export const DEFAULT_MODEL = "deepseek-ai/deepseek-v3.2";

const NVIDIA_MODELS = [
  "deepseek-ai/deepseek-v3.2",
  "deepseek-ai/deepseek-v3.1",
  "moonshotai/kimi-k2-instruct",
  "moonshotai/kimi-k2-instruct-0905",
];

const GEMINI_MODEL = "gemini-2.5-flash";

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
  const query = {
    messages,
    temperature: options.temperature ?? 0.1,
    max_tokens: options.max_tokens ?? 4096,
  };

  const fallbackArray = [
    ...NVIDIA_MODELS.map((model) => ({
      provider: "custom-nvidia-nim",
      endpoint: "v1/chat/completions",
      headers: { "Content-Type": "application/json" },
      query: { ...query, model },
    })),
    {
      provider: "google-ai-studio",
      endpoint: "v1beta/openai/chat/completions",
      headers: { "Content-Type": "application/json" },
      query: { ...query, model: GEMINI_MODEL },
    },
  ];

  const response = await fetch(config.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "cf-aig-authorization": `Bearer ${config.cfAigToken}`,
    },
    body: JSON.stringify(fallbackArray),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI Gateway ${response.status}: ${body.slice(0, 200)}`);
  }

  const step = response.headers.get("cf-aig-step");
  if (step && step !== "0") {
    console.log(`AI Gateway used fallback step ${step}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  if (!data.choices?.[0]?.message?.content) {
    throw new Error("AI Gateway returned empty response from all models");
  }

  return data;
}

export function extractContent(response: ChatCompletionResponse): string {
  return response.choices?.[0]?.message?.content ?? "";
}
