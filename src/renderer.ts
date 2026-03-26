import type { FeedItem } from "./rss";

export interface RenderedArticle {
  url: string;
  title: string;
  published: string;
  feedUrl: string;
  r2Key: string;
}

const RENDER_TIMEOUT_MS = 30_000;

export async function renderArticle(
  item: FeedItem,
  browser: Fetcher,
  bucket: R2Bucket
): Promise<RenderedArticle> {
  const markdown = await fetchMarkdown(item.url, browser);
  const r2Key = buildR2Key(item);

  await bucket.put(r2Key, markdown, {
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
    r2Key,
  };
}

async function fetchMarkdown(url: string, browser: Fetcher): Promise<string> {
  const endpoint = `https://browser-rendering.cloudflare.com/markdown`;
  const response = await browser.fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      waitUntil: "domcontentloaded",
      timeout: RENDER_TIMEOUT_MS,
    }),
  });

  if (!response.ok) {
    throw new Error(`Browser rendering failed for ${url}: ${response.status} ${response.statusText}`);
  }

  const result = await response.text();
  return result;
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
  return `${date}/${hostname}/${slug}.md`;
}
