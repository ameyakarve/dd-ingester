import type { FeedItem } from "./rss";
import { callAIGateway, extractContent, DEFAULT_MODEL, type AiGatewayConfig } from "./ai-gateway";

export interface RenderedArticle {
  url: string;
  title: string;
  published: string;
  feedUrl: string;
  r2RawKey: string;
}

const RENDER_TIMEOUT_MS = 30_000;
const CONTENT_CHECK_LIMIT = 2_000;
const MIN_ARTICLE_LENGTH = 100;

const CONTENT_CHECK_PROMPT = `You are a content validator. Given a rendered web page in markdown, determine if it contains actual article content or if it is a bot-protection page, captcha, error page, login wall, cookie consent wall, 404 page, or any other non-article content.

Respond with ONLY the word YES or NO.`;

export async function renderArticle(
  item: FeedItem,
  accountId: string,
  apiToken: string,
  bucket: R2Bucket,
): Promise<RenderedArticle> {
  const markdown = await fetchMarkdown(item.url, accountId, apiToken);
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
  if (markdown.length < MIN_ARTICLE_LENGTH) return false;

  const snippet = markdown.slice(0, CONTENT_CHECK_LIMIT);
  const data = await callAIGateway(aiConfig, DEFAULT_MODEL, [
    { role: "system", content: CONTENT_CHECK_PROMPT },
    { role: "user", content: snippet },
  ], { max_tokens: 8 });

  const answer = extractContent(data).trim().toUpperCase();
  return answer.startsWith("YES");
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
