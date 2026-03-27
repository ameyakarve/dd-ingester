import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";
import { generateText } from "ai";

export interface AiGatewayConfig {
  accountId: string;
  gateway: string;
  cfAigToken: string;
}

let cachedModel: ReturnType<typeof createUnified> extends (...args: any[]) => infer R ? R : never;
let cachedConfigKey: string;

export function createGatewayModel(config: AiGatewayConfig, model = "dynamic/triage") {
  const key = `${config.accountId}:${config.gateway}:${model}`;
  if (cachedModel && cachedConfigKey === key) return cachedModel;

  const aigateway = createAiGateway({
    accountId: config.accountId,
    gateway: config.gateway,
    apiKey: config.cfAigToken,
  });
  const unified = createUnified();
  cachedModel = aigateway(unified(model));
  cachedConfigKey = key;
  return cachedModel;
}

export async function callAIGateway(
  config: AiGatewayConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: { temperature?: number; maxOutputTokens?: number } = {},
): Promise<string> {
  const model = createGatewayModel(config);
  const { text } = await generateText({
    model,
    messages,
    temperature: options.temperature ?? 0.1,
    maxOutputTokens: options.maxOutputTokens ?? 4096,
  });

  if (!text) {
    throw new Error("AI Gateway returned empty response");
  }

  return text;
}
