import { RSS_FEEDS } from "./feeds";
import { parseFeed, type FeedItem } from "./rss";

export interface Env {
  SEEN_URLS: KVNamespace;
  RSS_QUEUE: Queue<FeedItem>;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const KV_TTL_SECONDS = 14 * 24 * 60 * 60; // Keep seen URLs for 14 days, then auto-expire
const FEED_FETCH_TIMEOUT_MS = 10_000;

export default {
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
