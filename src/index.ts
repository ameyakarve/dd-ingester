import { RSS_FEEDS } from "./feeds";
import { parseFeed, type FeedItem } from "./rss";
import { renderArticle, type RenderedArticle } from "./renderer";
import { cleanArticle, type CleanedArticle } from "./cleaner";
import { triageArticle } from "./triage";

export interface Env {
  SEEN_URLS: KVNamespace;
  DB: D1Database;
  RSS_QUEUE: Queue<FeedItem>;
  ARTICLES_BUCKET: R2Bucket;
  RENDERED_QUEUE: Queue<RenderedArticle>;
  CLEANED_QUEUE: Queue<CleanedArticle>;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  AI_GATEWAY_URL: string;
  NVIDIA_API_KEY: string;
  CF_AIG_TOKEN: string;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const KV_TTL_SECONDS = 14 * 24 * 60 * 60;
const FEED_FETCH_TIMEOUT_MS = 10_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/replay-clean") {
      try {
        const listed = await env.ARTICLES_BUCKET.list();
        const enqueued: string[] = [];
        const errors: string[] = [];

        for (const obj of listed.objects) {
          if (obj.key.startsWith("clean/")) continue; // Skip cleaned versions
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

    if (url.pathname === "/articles") {
      const status = url.searchParams.get("status");
      let query = "SELECT id, url, title, published, triage_status, triage_reason, created_at FROM articles";
      const params: string[] = [];
      if (status) {
        query += " WHERE triage_status = ?";
        params.push(status);
      }
      query += " ORDER BY published DESC LIMIT 100";
      const result = await env.DB.prepare(query).bind(...params).all();
      return Response.json(result.results);
    }

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

    const results = await Promise.allSettled(
      RSS_FEEDS.map((feedUrl) => fetchFeed(feedUrl, cutoffDate))
    );

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

    const newItems = await filterNewUrls(allItems, env.SEEN_URLS);
    console.log(`${newItems.length} new items after dedup against KV`);

    if (newItems.length === 0) return;

    for (let i = 0; i < newItems.length; i += 100) {
      const batch = newItems.slice(i, i + 100).map((item) => ({ body: item }));
      await env.RSS_QUEUE.sendBatch(batch);
    }

    ctx.waitUntil(markUrlsSeen(newItems, env.SEEN_URLS));
    console.log(`Enqueued ${newItems.length} new articles`);
  },

  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Queue handler invoked. Queue: ${batch.queue}, messages: ${batch.messages.length}`);

    if (batch.queue === "rss-articles") {
      // Stage 1: Render raw markdown
      for (const message of batch.messages) {
        try {
          const item = message.body as FeedItem;
          console.log(`Rendering: ${item.url}`);

          const rendered = await renderArticle(item, env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN, env.ARTICLES_BUCKET);
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
      // Stage 2: Clean with DeepSeek, store in R2 + D1
      for (const message of batch.messages) {
        try {
          const article = message.body as RenderedArticle;
          console.log(`Cleaning: ${article.url}`);

          const obj = await env.ARTICLES_BUCKET.get(article.r2Key);
          if (!obj) {
            console.error(`R2 object not found: ${article.r2Key}`);
            message.ack();
            continue;
          }
          const rawMarkdown = await obj.text();

          const { cleaned } = await cleanArticle(
            article, rawMarkdown, env.AI_GATEWAY_URL, env.NVIDIA_API_KEY, env.CF_AIG_TOKEN, env.ARTICLES_BUCKET
          );

          // Upsert into D1
          await env.DB.prepare(
            `INSERT INTO articles (url, title, published, feed_url, r2_raw_key, r2_clean_key, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(url) DO UPDATE SET
               r2_clean_key = excluded.r2_clean_key,
               updated_at = datetime('now')`
          ).bind(
            cleaned.url, cleaned.title, cleaned.published, cleaned.feedUrl,
            cleaned.r2RawKey, cleaned.r2CleanKey
          ).run();

          await env.CLEANED_QUEUE.send(cleaned);
          console.log(`Cleaned and stored: ${article.url} -> ${cleaned.r2CleanKey}`);

          message.ack();
        } catch (err) {
          const article = message.body as RenderedArticle;
          console.error(`Failed to clean ${article.url}: ${err}`);
          message.retry();
        }
      }
    } else if (batch.queue === "rss-articles-cleaned") {
      // Stage 3: Triage with Kimi
      for (const message of batch.messages) {
        try {
          const article = message.body as CleanedArticle;
          console.log(`Triaging: ${article.url}`);

          // Fetch cleaned content from R2
          const obj = await env.ARTICLES_BUCKET.get(article.r2CleanKey);
          if (!obj) {
            console.error(`Cleaned R2 object not found: ${article.r2CleanKey}`);
            message.ack();
            continue;
          }
          const cleanedContent = await obj.text();

          const result = await triageArticle(
            article, cleanedContent, env.AI_GATEWAY_URL, env.NVIDIA_API_KEY, env.CF_AIG_TOKEN
          );

          // Update D1 with triage result
          await env.DB.prepare(
            `UPDATE articles SET triage_status = ?, triage_reason = ?, updated_at = datetime('now') WHERE url = ?`
          ).bind(result.status, result.reason, article.url).run();

          console.log(`Triaged: ${article.url} -> ${result.status}`);

          // 5s delay between articles to avoid rate limits
          await new Promise((resolve) => setTimeout(resolve, 5000));

          message.ack();
        } catch (err) {
          const article = message.body as CleanedArticle;
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
