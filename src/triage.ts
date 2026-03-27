import type { CleanedArticle } from "./cleaner";
import { callAIGateway, DEFAULT_MODEL, type AiGatewayConfig } from "./ai-gateway";

export interface TriageResult {
  url: string;
  title: string;
  status: "relevant" | "irrelevant";
  reason: string;
}

const TRIAGE_MODEL = DEFAULT_MODEL;

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

Your job: Given an article's title, URL, and cleaned markdown content, classify it.

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

Respond with ONLY a JSON object:
{"status": "relevant"|"irrelevant", "reason": "one-sentence explanation"}`;

const ARTICLE_CONTENT_LIMIT = 8000;

export async function triageArticle(
  article: CleanedArticle,
  cleanedContent: string,
  aiConfig: AiGatewayConfig,
): Promise<TriageResult> {
  const truncatedContent = cleanedContent.length > ARTICLE_CONTENT_LIMIT
    ? cleanedContent.slice(0, ARTICLE_CONTENT_LIMIT) + "\n\n[TRUNCATED]"
    : cleanedContent;

  const userMessage = `Title: ${article.title}\nURL: ${article.url}\n\n${truncatedContent}`;

  const data = await callAIGateway(aiConfig, TRIAGE_MODEL, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ]);

  const content = data.choices?.[0]?.message?.content ?? "";

  const jsonMatch = content.match(/\{[\s\S]*?"status"[\s\S]*?\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON in triage response: ${content.slice(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);
  if (!["relevant", "irrelevant"].includes(parsed.status)) {
    throw new Error(`Invalid triage status: ${parsed.status}`);
  }

  const result: TriageResult = {
    url: article.url,
    title: article.title,
    status: parsed.status,
    reason: parsed.reason ?? "",
  };

  console.log(`[TRIAGE] ${article.url} -> ${result.status}: ${result.reason}`);
  return result;
}
