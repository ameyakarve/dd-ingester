export interface FeedItem {
  url: string;
  title: string;
  published: string;
  feedUrl: string;
}

/**
 * Parse an RSS/Atom feed XML string and extract items published within the cutoff window.
 */
export function parseFeed(xml: string, feedUrl: string, cutoffDate: Date): FeedItem[] {
  const items: FeedItem[] = [];

  // Try RSS <item> elements first, then Atom <entry> elements
  const rssItems = matchAll(xml, /<item[\s>]([\s\S]*?)<\/item>/gi);
  const atomEntries = matchAll(xml, /<entry[\s>]([\s\S]*?)<\/entry>/gi);

  for (const block of rssItems) {
    const link = extractTag(block, "link");
    const title = extractTag(block, "title");
    const pubDate = extractTag(block, "pubDate");
    if (!link || !pubDate) continue;

    const published = new Date(pubDate);
    if (isNaN(published.getTime()) || published < cutoffDate) continue;

    items.push({ url: normalizeUrl(link), title: title ?? "", published: published.toISOString(), feedUrl });
  }

  for (const block of atomEntries) {
    const link = extractAtomLink(block);
    const title = extractTag(block, "title");
    const published = extractTag(block, "published") ?? extractTag(block, "updated");
    if (!link || !published) continue;

    const pubDate = new Date(published);
    if (isNaN(pubDate.getTime()) || pubDate < cutoffDate) continue;

    items.push({ url: normalizeUrl(link), title: title ?? "", published: pubDate.toISOString(), feedUrl });
  }

  return items;
}

function matchAll(text: string, regex: RegExp): string[] {
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    results.push(match[1]);
  }
  return results;
}

function extractTag(block: string, tag: string): string | null {
  // Handle CDATA: <tag><![CDATA[content]]></tag>
  const cdataMatch = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i").exec(block);
  if (cdataMatch) return cdataMatch[1].trim();

  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return match ? decodeXmlEntities(match[1].trim()) : null;
}

function extractAtomLink(block: string): string | null {
  // Prefer rel="alternate", fall back to first <link>
  const altMatch = /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(block);
  if (altMatch) return altMatch[1];

  const match = /<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(block);
  return match ? match[1] : null;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Strip trailing slash, fragment, and common tracking params
    u.hash = "";
    u.searchParams.delete("utm_source");
    u.searchParams.delete("utm_medium");
    u.searchParams.delete("utm_campaign");
    u.searchParams.delete("utm_content");
    u.searchParams.delete("utm_term");
    let normalized = u.toString();
    if (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return url.trim();
  }
}
