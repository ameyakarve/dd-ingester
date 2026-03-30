import { RSS_FEEDS } from "./feeds";
import { parseFeed, type FeedItem } from "./rss";
import { renderArticle, isArticleContent, type RenderedArticle } from "./renderer";
import { cleanArticle, type CleanedArticle } from "./cleaner";
import { triageArticle } from "./triage";
import type { AiGatewayConfig } from "./ai-gateway";

export interface Env {
  SEEN_URLS: KVNamespace;
  DB: D1Database;
  RSS_QUEUE: Queue<FeedItem & { renderRetry?: number }>;
  ARTICLES_BUCKET: R2Bucket;
  RENDERED_QUEUE: Queue<RenderedArticle & { renderRetry?: number }>;
  CLEANED_QUEUE: Queue<CleanedArticle>;
  INCORPORATE_QUEUE: Queue;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  CF_AIG_TOKEN: string;
}

const QUEUE_RSS = "rss-articles";
const QUEUE_RENDERED = "rss-articles-rendered";
const QUEUE_CLEANED = "rss-articles-cleaned";

const MAX_RERENDER_RETRIES = 3;
const RERENDER_DELAY_SECONDS = 60;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const KV_TTL_SECONDS = 14 * 24 * 60 * 60;
const FEED_FETCH_TIMEOUT_MS = 10_000;

const AI_GATEWAY_NAME = "dd-ai-gateway";

function aiConfig(env: Env): AiGatewayConfig {
  return { accountId: env.CLOUDFLARE_ACCOUNT_ID, gateway: AI_GATEWAY_NAME, cfAigToken: env.CF_AIG_TOKEN };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
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

    await markUrlsSeen(newItems, env.SEEN_URLS);

    for (let i = 0; i < newItems.length; i += 100) {
      const batch = newItems.slice(i, i + 100).map((item) => ({ body: item }));
      await env.RSS_QUEUE.sendBatch(batch);
    }

    console.log(`Enqueued ${newItems.length} new articles`);
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    console.log(`Queue handler invoked. Queue: ${batch.queue}, messages: ${batch.messages.length}`);
    const ai = aiConfig(env);

    if (batch.queue === QUEUE_RSS) {
      for (const message of batch.messages) {
        const item = message.body as FeedItem & { renderRetry?: number };
        try {
          console.log(`Rendering: ${item.url}${item.renderRetry ? ` (re-render attempt ${item.renderRetry})` : ""}`);
          const rendered = await renderArticle(item, env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN, env.ARTICLES_BUCKET);
          await env.RENDERED_QUEUE.send({ ...rendered, renderRetry: item.renderRetry });
          message.ack();
          console.log(`Rendered and enqueued: ${item.url} -> ${rendered.r2RawKey}`);
        } catch (err) {
          console.error(`Failed to render ${item.url}: ${err}`);
          message.retry();
        }
      }
    } else if (batch.queue === QUEUE_RENDERED) {
      for (const message of batch.messages) {
        const article = message.body as RenderedArticle & { renderRetry?: number };
        try {
          console.log(`Cleaning: ${article.url}`);
          const obj = await env.ARTICLES_BUCKET.get(article.r2RawKey);
          if (!obj) {
            console.error(`R2 object not found: ${article.r2RawKey}`);
            message.ack();
            continue;
          }
          const rawMarkdown = await obj.text();

          if (!await isArticleContent(rawMarkdown, ai)) {
            const retryCount = (article.renderRetry ?? 0) + 1;
            if (retryCount > MAX_RERENDER_RETRIES) {
              console.error(`Bot content persisted after ${MAX_RERENDER_RETRIES} re-renders, skipping: ${article.url}`);
              message.ack();
              continue;
            }
            console.warn(`Bot content detected in raw R2 for ${article.url}, requeuing for re-render (attempt ${retryCount}/${MAX_RERENDER_RETRIES})`);
            await env.RSS_QUEUE.send(
              { url: article.url, title: article.title, published: article.published, feedUrl: article.feedUrl, renderRetry: retryCount },
              { delaySeconds: RERENDER_DELAY_SECONDS * retryCount },
            );
            message.ack();
            continue;
          }

          const cleaned = await cleanArticle(article, rawMarkdown, ai, env.ARTICLES_BUCKET);

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
          console.error(`Failed to clean ${article.url}: ${err}`);
          message.retry();
        }
      }
    } else if (batch.queue === QUEUE_CLEANED) {
      for (const message of batch.messages) {
        const article = message.body as CleanedArticle;
        try {
          console.log(`Triaging: ${article.url}`);

          const obj = await env.ARTICLES_BUCKET.get(article.r2CleanKey);
          if (!obj) {
            console.error(`Cleaned R2 object not found: ${article.r2CleanKey}`);
            message.ack();
            continue;
          }
          const cleanedContent = await obj.text();

          const result = await triageArticle(article, cleanedContent, ai);

          await env.DB.prepare(
            `UPDATE articles SET triage_status = ?, triage_reason = ?, updated_at = datetime('now') WHERE url = ?`
          ).bind(result.status, result.reason, article.url).run();

          if (result.status === "relevant") {
            await env.INCORPORATE_QUEUE.send({
              url: article.url,
              title: article.title,
              published: article.published,
              feedUrl: article.feedUrl,
              r2CleanKey: article.r2CleanKey,
              triageReason: result.reason,
            });
            console.log(`Triaged: ${article.url} -> ${result.status}, queued for incorporation`);
          } else {
            console.log(`Triaged: ${article.url} -> ${result.status}`);
          }
          message.ack();
        } catch (err) {
          console.error(`Failed to triage ${article.url}: ${err}`);
          message.retry();
        }
      }
    } else {
      console.error(`Unknown queue: ${batch.queue}`);
    }
  },
} satisfies ExportedHandler<Env>;

async function fetchFeed(feedUrl: string, cutoffDate: Date): Promise<FeedItem[]> {
  const response = await fetch(feedUrl, {
    signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "DoubleDip-Ingester/1.0" },
  });

  if (!response.ok) {
    throw new Error(`Feed ${feedUrl} returned ${response.status}`);
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
  const batchSize = 50;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(
      batch.map((item) =>
        kv.put(kvKey(item.url), item.published, { expirationTtl: KV_TTL_SECONDS })
      )
    );
  }
}

function kvKey(url: string): string {
  return `seen:${url}`;
}
