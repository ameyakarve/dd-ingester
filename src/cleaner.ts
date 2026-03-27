import type { RenderedArticle } from "./renderer";

export interface CleanedArticle {
  url: string;
  title: string;
  published: string;
  feedUrl: string;
  r2RawKey: string;
  r2CleanKey: string;
}

const CLEAN_MODEL = "deepseek-ai/deepseek-v3.2";

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

const CONTENT_LIMIT = 30_000; // Allow more input for cleaning since we want full page

export async function cleanArticle(
  article: RenderedArticle,
  rawMarkdown: string,
  gatewayBaseUrl: string,
  nvidiaApiKey: string,
  cfAigToken: string,
  bucket: R2Bucket,
): Promise<{ cleaned: CleanedArticle; content: string }> {
  const truncatedInput = rawMarkdown.length > CONTENT_LIMIT
    ? rawMarkdown.slice(0, CONTENT_LIMIT) + "\n\n[TRUNCATED]"
    : rawMarkdown;

  const userMessage = `Title: ${article.title}\nURL: ${article.url}\n\n---\n\n${truncatedInput}`;

  const response = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${nvidiaApiKey}`,
      "cf-aig-authorization": `Bearer ${cfAigToken}`,
    },
    body: JSON.stringify({
      model: CLEAN_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      temperature: 0.1,
      max_tokens: 8192,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cleaner ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const cleanedContent = data.choices?.[0]?.message?.content || "";
  if (!cleanedContent) {
    throw new Error("Cleaner returned empty content");
  }

  // Store cleaned markdown in R2 under clean/ prefix
  const r2CleanKey = `clean/${article.r2Key}`;
  await bucket.put(r2CleanKey, cleanedContent, {
    customMetadata: {
      url: article.url,
      title: article.title,
      published: article.published,
      feedUrl: article.feedUrl,
    },
  });

  const cleaned: CleanedArticle = {
    url: article.url,
    title: article.title,
    published: article.published,
    feedUrl: article.feedUrl,
    r2RawKey: article.r2Key,
    r2CleanKey,
  };

  return { cleaned, content: cleanedContent };
}
