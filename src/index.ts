import { RSS_FEEDS } from "./feeds";
import { parseFeed, type FeedItem } from "./rss";
import { renderArticle, type RenderedArticle } from "./renderer";
import { triageArticle } from "./triage";

export interface Env {
  SEEN_URLS: KVNamespace;
  RSS_QUEUE: Queue<FeedItem>;
  BROWSER: Fetcher;
  ARTICLES_BUCKET: R2Bucket;
  RENDERED_QUEUE: Queue<RenderedArticle>;
  AI_GATEWAY_URL: string;
  NVIDIA_API_KEY: string;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const KV_TTL_SECONDS = 14 * 24 * 60 * 60; // Keep seen URLs for 14 days, then auto-expire
const FEED_FETCH_TIMEOUT_MS = 10_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET /replay-triage — list R2 objects and enqueue them for triage
    if (url.pathname === "/replay-triage") {
      try {
        const listed = await env.ARTICLES_BUCKET.list();
        const enqueued: string[] = [];
        const errors: string[] = [];

        for (const obj of listed.objects) {
          try {
            const head = await env.ARTICLES_BUCKET.head(obj.key);
            if (!head?.customMetadata?.url) {
              errors.push(`${obj.key}: no metadata`);
              continue;
            }

            const article: RenderedArticle = {
              url: head.customMetadata.url,
              title: head.customMetadata.title ?? "",
              published: head.customMetadata.published ?? "",
              feedUrl: head.customMetadata.feedUrl ?? "",
              r2Key: obj.key,
            };
            await env.RENDERED_QUEUE.send(article);
            enqueued.push(obj.key);
          } catch (err) {
            errors.push(`${obj.key}: ${err}`);
          }
        }

        return Response.json({ enqueued: enqueued.length, keys: enqueued, errors });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    // GET /test-queue — send a test message to rss-articles and check if consumer fires
    if (url.pathname === "/test-queue") {
      const testItem: FeedItem = {
        url: "https://example.com/test-article",
        title: "Test Article",
        published: new Date().toISOString(),
        feedUrl: "https://example.com/feed",
      };
      await env.RSS_QUEUE.send(testItem);
      return Response.json({ sent: true, item: testItem });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cutoffDate = new Date(Date.now() - SEVEN_DAYS_MS);
    console.log(`RSS poll starting. Cutoff: ${cutoffDate.toISOString()}`);

    // Fetch all feeds concurrently
    const results = await Promise.allSettled(
      RSS_FEEDS.map((feedUrl) => fetchFeed(feedUrl, cutoffDate))
    );

    // Collect all items, dedup by URL
    const seen = new Set<string>();
    const allItems: FeedItem[] = [];
    let feedErrors = 0;

    for (const result of results) {
      if (result.status === "rejected") {
        feedErrors++;
        continue;
      }
      for (const item of result.value) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          allItems.push(item);
        }
      }
    }

    console.log(`Parsed ${allItems.length} unique items from ${RSS_FEEDS.length - feedErrors}/${RSS_FEEDS.length} feeds`);

    // Filter out URLs we've already seen (KV lookup)
    const newItems = await filterNewUrls(allItems, env.SEEN_URLS);
    console.log(`${newItems.length} new items after dedup against KV`);

    if (newItems.length === 0) return;

    // Push new items to queue in batches of 100 (Queue.sendBatch limit)
    for (let i = 0; i < newItems.length; i += 100) {
      const batch = newItems.slice(i, i + 100).map((item) => ({ body: item }));
      await env.RSS_QUEUE.sendBatch(batch);
    }

    // Mark all new URLs as seen in KV
    ctx.waitUntil(markUrlsSeen(newItems, env.SEEN_URLS));

    console.log(`Enqueued ${newItems.length} new articles`);
  },

  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Queue handler invoked. Queue: ${batch.queue}, messages: ${batch.messages.length}`);

    if (batch.queue === "rss-articles") {
      for (const message of batch.messages) {
        try {
          const item = message.body as FeedItem;
          console.log(`Rendering: ${item.url}`);

          const rendered = await renderArticle(item, env.BROWSER, env.ARTICLES_BUCKET);
          await env.RENDERED_QUEUE.send(rendered);

          message.ack();
          console.log(`Rendered and enqueued: ${item.url} -> ${rendered.r2Key}`);
        } catch (err) {
          const item = message.body as FeedItem;
          console.error(`Failed to render ${item.url}: ${err}`);
          message.retry();
        }
      }
    } else if (batch.queue === "rss-articles-rendered") {
      for (const message of batch.messages) {
        try {
          const article = message.body as RenderedArticle;
          console.log(`Triaging: ${article.url}`);

          // Fetch markdown from R2
          const obj = await env.ARTICLES_BUCKET.get(article.r2Key);
          if (!obj) {
            console.error(`R2 object not found: ${article.r2Key}`);
            message.ack(); // Don't retry if content is missing
            continue;
          }
          const markdown = await obj.text();

          // Call all models and log results
          await triageArticle(article, markdown, env.AI_GATEWAY_URL, env.NVIDIA_API_KEY);

          // 5s delay between articles to avoid rate limits
          await new Promise((resolve) => setTimeout(resolve, 5000));

          message.ack();
        } catch (err) {
          const article = message.body as RenderedArticle;
          console.error(`Failed to triage ${article.url}: ${err}`);
          message.retry();
        }
      }
    }
  },
} satisfies ExportedHandler<Env>;

async function fetchFeed(feedUrl: string, cutoffDate: Date): Promise<FeedItem[]> {
  const response = await fetch(feedUrl, {
    signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "DoubleDip-Ingester/1.0" },
  });

  if (!response.ok) {
    console.warn(`Feed ${feedUrl} returned ${response.status}`);
    return [];
  }

  const xml = await response.text();
  return parseFeed(xml, feedUrl, cutoffDate);
}

async function filterNewUrls(items: FeedItem[], kv: KVNamespace): Promise<FeedItem[]> {
  // Check KV in batches to avoid hitting subrequest limits
  const batchSize = 50;
  const newItems: FeedItem[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const checks = await Promise.all(
      batch.map(async (item) => {
        const existing = await kv.get(kvKey(item.url));
        return existing === null ? item : null;
      })
    );
    for (const item of checks) {
      if (item) newItems.push(item);
    }
  }

  return newItems;
}

async function markUrlsSeen(items: FeedItem[], kv: KVNamespace): Promise<void> {
  await Promise.all(
    items.map((item) =>
      kv.put(kvKey(item.url), item.published, { expirationTtl: KV_TTL_SECONDS })
    )
  );
}

function kvKey(url: string): string {
  return `seen:${url}`;
}
