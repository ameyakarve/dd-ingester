import type { RenderedArticle } from "./renderer";
import { callAIGateway, extractContent, DEFAULT_MODEL, type AiGatewayConfig } from "./ai-gateway";

export interface CleanedArticle {
  url: string;
  title: string;
  published: string;
  feedUrl: string;
  r2RawKey: string;
  r2CleanKey: string;
}

const SYSTEM_PROMPT = `You are a content extractor. Given a markdown document that was converted from a full web page, extract ONLY the main article content.

Remove all of the following:
- Navigation menus, sidebars, footers, headers
- Social media links and share buttons
- Cookie banners, login prompts, subscription CTAs
- Related article lists and "read more" sections
- Advertising and sponsored content blocks
- Comment sections
- Author bios and about sections (unless integral to the article)
- Breadcrumbs and category listings
- Search bars and site-wide UI elements

Keep:
- The article title/headline
- The full article body text
- Inline images with their captions/alt text
- Data tables, charts, or lists that are part of the article content
- Block quotes that are part of the article

Return ONLY the cleaned article content as markdown. Do not add any commentary or wrapper text.`;

const CONTENT_LIMIT = 30_000;

export async function cleanArticle(
  article: RenderedArticle,
  rawMarkdown: string,
  aiConfig: AiGatewayConfig,
  bucket: R2Bucket,
): Promise<CleanedArticle> {
  const truncatedInput = rawMarkdown.length > CONTENT_LIMIT
    ? rawMarkdown.slice(0, CONTENT_LIMIT) + "\n\n[TRUNCATED]"
    : rawMarkdown;

  const userMessage = `Title: ${article.title}\nURL: ${article.url}\n\n---\n\n${truncatedInput}`;

  const data = await callAIGateway(aiConfig, DEFAULT_MODEL, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ], { max_tokens: 8192 });

  const cleanedContent = extractContent(data);
  if (!cleanedContent) {
    throw new Error("Cleaner returned empty content");
  }

  const r2CleanKey = article.r2RawKey.startsWith("raw/")
    ? article.r2RawKey.replace(/^raw\//, "clean/")
    : `clean/${article.r2RawKey}`;
  await bucket.put(r2CleanKey, cleanedContent, {
    customMetadata: {
      url: article.url,
      title: article.title,
      published: article.published,
      feedUrl: article.feedUrl,
    },
  });

  return {
    url: article.url,
    title: article.title,
    published: article.published,
    feedUrl: article.feedUrl,
    r2RawKey: article.r2RawKey,
    r2CleanKey,
  };
}
