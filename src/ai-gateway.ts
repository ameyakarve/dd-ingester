export const DEFAULT_MODEL = "dynamic/triage";

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
  model: string,
  messages: Array<{ role: string; content: string }>,
  options: { temperature?: number; max_tokens?: number } = {},
): Promise<ChatCompletionResponse> {
  const response = await fetch(`${config.baseUrl}/compat/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "cf-aig-authorization": `Bearer ${config.cfAigToken}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.max_tokens ?? 4096,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI Gateway ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  if (!data.choices?.[0]?.message?.content) {
    throw new Error("AI Gateway returned empty response");
  }

  return data;
}

export function extractContent(response: ChatCompletionResponse): string {
  return response.choices?.[0]?.message?.content ?? "";
}
