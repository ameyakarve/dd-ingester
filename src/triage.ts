import type { RenderedArticle } from "./renderer";

export interface TriageResult {
  url: string;
  title: string;
  model: string;
  status: "relevant" | "irrelevant" | "incomplete" | "error";
  reason: string;
}

const TRIAGE_MODELS = [
  "moonshotai/kimi-k2-thinking",
  "deepseek-ai/deepseek-v3.2",
  "mistralai/mistral-large-3-675b-instruct-2512",
] as const;

const SYSTEM_PROMPT = `You are a triage classifier for a travel rewards knowledge base focused on the Indian market.

The knowledge base covers:
- Airlines and airline alliances (Star Alliance, SkyTeam, Oneworld)
- Frequent flyer programmes (FFPs) — earning, redeeming, expiry rules, elite tiers, award booking
- Indian credit cards and their points transfer partners
- Hotel loyalty programs (Marriott Bonvoy, Hilton Honors, IHG, Accor, etc.)
- Award travel destination guides from India
- Points aggregators and transfer pipelines
- Offers: buy-points promotions, status matches, earning promos, award sales
- Car rental loyalty programs
- Travel portals (airline shopping portals for earning miles)

Your job: Given an article's title, URL, and markdown content, classify it.

RELEVANT — contains actionable information about:
- Changes to FFP rules (earning, redemption, expiry, elite status, award charts)
- New or changed credit card transfer partners or ratios
- Buy-points promotions, award sales, or status match opportunities
- Hotel program changes (points earning, redemption, elite tiers, promotions)
- Alliance membership changes
- Car rental program or travel portal updates

IRRELEVANT — includes:
- Trip reports, hotel/lounge reviews, personal travel stories
- Credit card reviews for non-Indian markets (US, UK, Australian cards)
- General travel tips, packing guides, destination tourism content
- New airline routes or schedule changes
- Sponsored content, affiliate roundups, "best of" listicles without new information
- News about airline operations (delays, strikes, IT outages)
- Restaurant, dining, or non-travel content

INCOMPLETE — the article content is too short, truncated, paywalled, or otherwise insufficient to make a determination.

ERROR — the content is not an article (e.g., error page, login wall, empty content).

Respond with ONLY a JSON object:
{"status": "relevant"|"irrelevant"|"incomplete"|"error", "reason": "one-sentence explanation"}`;

const ARTICLE_CONTENT_LIMIT = 8000; // Truncate long articles to stay within token limits

export async function triageArticle(
  article: RenderedArticle,
  markdown: string,
  gatewayBaseUrl: string,
  nvidiaApiKey: string,
  cfAigToken: string,
): Promise<TriageResult[]> {
  const truncatedContent = markdown.length > ARTICLE_CONTENT_LIMIT
    ? markdown.slice(0, ARTICLE_CONTENT_LIMIT) + "\n\n[TRUNCATED]"
    : markdown;

  const userMessage = `Title: ${article.title}\nURL: ${article.url}\n\n${truncatedContent}`;

  const results: TriageResult[] = [];

  for (const model of TRIAGE_MODELS) {
    try {
      const result = await callModel(model, userMessage, gatewayBaseUrl, nvidiaApiKey, cfAigToken);
      results.push({
        url: article.url,
        title: article.title,
        model,
        ...result,
      });
      console.log(`[${model}] ${article.url} -> ${result.status}: ${result.reason}`);
    } catch (err) {
      console.error(`[${model}] ${article.url} FAILED: ${err}`);
      results.push({
        url: article.url,
        title: article.title,
        model,
        status: "error",
        reason: `Model call failed: ${err}`,
      });
    }
  }

  // Log comparison against Kimi as ground truth
  const kimiResult = results.find((r) => r.model === "moonshotai/kimi-k2-thinking");
  if (kimiResult) {
    for (const r of results) {
      if (r.model === kimiResult.model) continue;
      const match = r.status === kimiResult.status;
      console.log(
        `[EVAL] ${article.url} | kimi=${kimiResult.status} | ${r.model}=${r.status} | ${match ? "MATCH" : "MISMATCH"}`
      );
    }
  }

  return results;
}

async function callModel(
  model: string,
  userMessage: string,
  gatewayBaseUrl: string,
  nvidiaApiKey: string,
  cfAigToken: string,
): Promise<{ status: "relevant" | "irrelevant" | "incomplete" | "error"; reason: string }> {
  const response = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${nvidiaApiKey}`,
      "cf-aig-authorization": `Bearer ${cfAigToken}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      temperature: 0.1,
      max_tokens: 256,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string; reasoning_content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content ?? "";

  // Extract JSON from response (handle models that wrap in markdown code blocks)
  const jsonMatch = content.match(/\{[\s\S]*?"status"[\s\S]*?\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON in response: ${content.slice(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);
  if (!["relevant", "irrelevant", "incomplete", "error"].includes(parsed.status)) {
    throw new Error(`Invalid status: ${parsed.status}`);
  }

  return { status: parsed.status, reason: parsed.reason ?? "" };
}

export function getTriageModels(): readonly string[] {
  return TRIAGE_MODELS;
}
