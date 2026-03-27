import { z } from "zod";
import type { CleanedArticle } from "./cleaner";
import { callAIGateway, extractContent, DEFAULT_MODEL, type AiGatewayConfig } from "./ai-gateway";

const TriageResponseSchema = z.object({
  status: z.enum(["relevant", "irrelevant"]),
  reason: z.string(),
});

export interface TriageResult {
  url: string;
  title: string;
  status: "relevant" | "irrelevant";
  reason: string;
}


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
- New or changed credit card transfer partners or ratios (globally applicable)
- Buy-points promotions, award sales, or status match opportunities (for programs Indians can access)
- Hotel program changes (points earning, redemption, elite tiers, promotions) — hotel loyalty programs (Marriott, Hyatt, Accor, IHG, Hilton, Wyndham, etc.) are GLOBAL programs, so promos at ANY destination are relevant as long as the program itself is globally accessible. A "Double Points in Greater China" promo from Accor is RELEVANT because any ALL member can book there.
- Alliance membership changes
- Bilt Rewards program-level changes (transfer partners, transfer bonuses, program rules) — Bilt is accessible to Indians via Rakuten transfers without a US card
- Free miles/points offers with no regional or card restriction — if anyone worldwide can earn free points (e.g., "click here for 300 free AAdvantage miles"), it's RELEVANT regardless of how small the amount

IRRELEVANT — includes:
- Trip reports, hotel/lounge reviews, personal travel stories — even if they mention award pricing or points redemption values
- Evergreen strategy guides or tips articles that are not about a specific program change or new promotion
- Credit card product reviews, new card launches, or card-specific feature updates for non-Indian markets (US, UK, Australian cards) — this includes Bilt card-only content (card features, app updates, card benefits)
- Promotions restricted to a credit card or banking product not available in India (e.g., "use your Citi ThankYou card", "Choice Privileges transfer bonus" where earning Choice points requires US presence)
- Programs not accessible from India: Citi ThankYou (exited India), Chase Ultimate Rewards, Capital One, US Bank — these are US-only credit card programs
- General travel tips, packing guides, destination tourism content
- New airline routes or schedule changes
- Sponsored content, affiliate roundups, "best of" listicles without new information
- News about airline operations (delays, strikes, IT outages)
- Restaurant, dining, or non-travel content
- Gift card deals, cashback portal promotions, or shopping portal updates

KEY DISTINCTION: A hotel review that mentions "I redeemed 40,000 points" is IRRELEVANT (it's a review). A news article announcing "Category changes mean this hotel now costs 40,000 points" is RELEVANT (it's a program change). Focus on whether the article reports a NEW change or promotion, not whether it contains loyalty program information.

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

  const data = await callAIGateway(aiConfig, DEFAULT_MODEL, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ]);

  const content = extractContent(data);

  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new Error(`Triage response is not valid JSON: ${content.slice(0, 200)}`);
  }
  const parsed = TriageResponseSchema.parse(json);

  const result: TriageResult = {
    url: article.url,
    title: article.title,
    status: parsed.status,
    reason: parsed.reason,
  };

  console.log(`[TRIAGE] ${article.url} -> ${result.status}: ${result.reason}`);
  return result;
}
