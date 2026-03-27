import type { FeedItem } from "./rss";
import { callAIGateway, DEFAULT_MODEL, type AiGatewayConfig } from "./ai-gateway";

export interface RenderedArticle {
  url: string;
  title: string;
  published: string;
  feedUrl: string;
  r2RawKey: string;
  renderRetry?: number;
}

const RENDER_TIMEOUT_MS = 30_000;
const MAX_RENDER_RETRIES = 5;
const RETRY_DELAY_MS = 3_000;
const CONTENT_CHECK_LIMIT = 500;

const CONTENT_CHECK_PROMPT = `You are a content validator. Given the first 500 characters of a rendered web page, determine if it contains actual article content or if it is a bot-protection page, captcha, error page, login wall, cookie consent wall, or any other non-article content.

Respond with ONLY a JSON object:
{"is_article": true|false, "reason": "one-sentence explanation"}`;

export async function renderArticle(
  item: FeedItem,
  accountId: string,
  apiToken: string,
  bucket: R2Bucket,
  aiConfig: AiGatewayConfig,
): Promise<RenderedArticle> {
  const markdown = await fetchMarkdownWithRetry(item.url, accountId, apiToken, aiConfig);
  const r2RawKey = buildR2Key(item);

  await bucket.put(r2RawKey, markdown, {
    customMetadata: {
      url: item.url,
      title: item.title,
      published: item.published,
      feedUrl: item.feedUrl,
    },
  });

  return {
    url: item.url,
    title: item.title,
    published: item.published,
    feedUrl: item.feedUrl,
    r2RawKey,
  };
}

export async function isArticleContent(markdown: string, aiConfig: AiGatewayConfig): Promise<boolean> {
  const snippet = markdown.slice(0, CONTENT_CHECK_LIMIT);
  const data = await callAIGateway(aiConfig, DEFAULT_MODEL, [
    { role: "system", content: CONTENT_CHECK_PROMPT },
    { role: "user", content: snippet },
  ], { max_tokens: 128 });

  const content = data.choices?.[0]?.message?.content ?? "";
  const jsonMatch = content.match(/\{[\s\S]*?"is_article"[\s\S]*?\}/);
  if (!jsonMatch) return true; // default to accepting if parsing fails

  const parsed = JSON.parse(jsonMatch[0]);
  return parsed.is_article === true;
}

async function fetchMarkdownWithRetry(
  url: string, accountId: string, apiToken: string, aiConfig: AiGatewayConfig
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RENDER_RETRIES; attempt++) {
    const markdown = await fetchMarkdown(url, accountId, apiToken);
    if (await isArticleContent(markdown, aiConfig)) {
      return markdown;
    }
    console.warn(`Non-article content detected for ${url} (attempt ${attempt}/${MAX_RENDER_RETRIES})`);
    if (attempt < MAX_RENDER_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
  }
  throw new Error(`Non-article content persisted after ${MAX_RENDER_RETRIES} retries for ${url}`);
}

async function fetchMarkdown(url: string, accountId: string, apiToken: string): Promise<string> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/markdown`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiToken}`,
    },
    body: JSON.stringify({
      url,
      gotoOptions: {
        waitUntil: "domcontentloaded",
        timeout: RENDER_TIMEOUT_MS,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Browser rendering failed for ${url}: ${response.status} ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as { success: boolean; result: string };
  if (!data.success) {
    throw new Error(`Browser rendering returned success=false for ${url}`);
  }

  return data.result;
}

function buildR2Key(item: FeedItem): string {
  const date = item.published.slice(0, 10); // YYYY-MM-DD
  const hostname = new URL(item.url).hostname.replace(/^www\./, "");
  const slug = item.url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
  return `raw/${date}/${hostname}/${slug}.md`;
}
