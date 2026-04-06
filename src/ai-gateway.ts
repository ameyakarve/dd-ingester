export interface AiGatewayConfig {
  accountId: string;
  gateway: string;
  cfAigToken: string;
  fetcher: Fetcher;
}

/**
 * Call the model router via service binding.
 * The router handles fallback chains, circuit breaking, and empty response detection.
 */
export async function callAIGateway(
  config: AiGatewayConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: { temperature?: number; maxOutputTokens?: number; model?: string } = {},
): Promise<string> {
  const body = JSON.stringify({
    model: options.model ?? "dynamic/triage",
    messages,
    temperature: options.temperature ?? 0.1,
    max_tokens: options.maxOutputTokens ?? 4096,
  });

  const response = await config.fetcher.fetch("https://router/compat/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  const rawBody = await response.text();

  if (!response.ok) {
    throw new Error(`Model router ${response.status}: ${rawBody.slice(0, 300)}`);
  }

  let data: any;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(`Non-JSON response from model router: ${rawBody.slice(0, 300)}`);
  }

  const text = data.choices?.[0]?.message?.content as string | undefined;
  if (!text) {
    throw new Error(`Empty content from model router: ${rawBody.slice(0, 300)}`);
  }

  return text;
}
