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
const MAX_RETRIES = 2;

export async function callAIGateway(
  config: AiGatewayConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: { temperature?: number; maxOutputTokens?: number } = {},
): Promise<string> {
  const url = `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gateway}/compat/chat/completions`;
  const body = JSON.stringify({
    model: "dynamic/triage",
    messages,
    temperature: options.temperature ?? 0.1,
    max_tokens: options.maxOutputTokens ?? 4096,
  });

  let lastError = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${config.cfAigToken}`,
      },
      body,
    });

    const rawBody = await response.text();

    if (!response.ok) {
      lastError = `AI Gateway ${response.status}: ${rawBody.slice(0, 300)}`;
      console.warn(`[ai-gateway] Attempt ${attempt + 1} failed: ${lastError}`);
      continue;
    }

    let data: any;
    try {
      data = JSON.parse(rawBody);
    } catch {
      lastError = `Non-JSON response: ${rawBody.slice(0, 300)}`;
      console.warn(`[ai-gateway] Attempt ${attempt + 1}: ${lastError}`);
      continue;
    }

    if (data.error) {
      lastError = `Error: ${data.error?.message || JSON.stringify(data.error)}`;
      console.warn(`[ai-gateway] Attempt ${attempt + 1}: ${lastError}`);
      continue;
    }

    const text = data.choices?.[0]?.message?.content as string | undefined;
    if (!text) {
      lastError = `Empty content: ${rawBody.slice(0, 300)}`;
      console.warn(`[ai-gateway] Attempt ${attempt + 1}: ${lastError}`);
      continue;
    }

    return text;
  }

  throw new Error(`AI Gateway failed after ${MAX_RETRIES + 1} attempts: ${lastError}`);
}
