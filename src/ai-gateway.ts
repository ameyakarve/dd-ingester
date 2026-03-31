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
  const url = `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gateway}/dynamic/triage`;

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

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`AI Gateway ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(`AI Gateway error: ${data.error.message}`);
  }

  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("AI Gateway returned empty response");
  }

  return text;
}
