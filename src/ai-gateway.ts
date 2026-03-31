export interface AiGatewayConfig {
  accountId: string;
  gateway: string;
  cfAigToken: string;
}

/**
 * Call the AI Gateway directly via fetch — bypasses the Vercel AI SDK
 * to avoid "Invalid JSON response" errors when the provider returns
 * slightly non-standard OpenAI-compatible responses.
 */
export async function callAIGateway(
  config: AiGatewayConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: { temperature?: number; maxOutputTokens?: number } = {},
): Promise<string> {
  const url = `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gateway}/dynamic/triage/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "cf-aig-authorization": `Bearer ${config.cfAigToken}`,
    },
    body: JSON.stringify({
      messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxOutputTokens ?? 4096,
    }),
  });

  const rawBody = await response.text();

  if (!response.ok) {
    throw new Error(`AI Gateway ${response.status}: ${rawBody.slice(0, 300)}`);
  }

  // Parse response — handle malformed JSON gracefully
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(`AI Gateway returned non-JSON: ${rawBody.slice(0, 300)}`);
  }

  if ((data as any).error) {
    throw new Error(`AI Gateway error: ${(data as any).error?.message || JSON.stringify(data.error)}`);
  }

  const text = (data as any).choices?.[0]?.message?.content as string | undefined;
  if (!text) {
    throw new Error(`AI Gateway returned no content: ${rawBody.slice(0, 300)}`);
  }

  return text;
}
