# dd-ingester

Cloudflare Worker that polls RSS feeds, renders articles to markdown, strips boilerplate with an LLM, and classifies relevance for a travel rewards knowledge base.

## Architecture

```
33 RSS Feeds
     │ cron */5
     ▼
┌──────────┐    dedup    ┌──────────┐
│ RSS Poll │────────────▶│ SEEN_URLS│
│(scheduled)│            │  (KV)    │
└────┬─────┘             └──────────┘
     │
     ▼
[rss-articles] queue ── batch 5, 30s
     │
     ▼
┌──────────────┐         ┌──────────────────────────┐
│ Stage 1      │────────▶│ R2: raw/{date}/{host}/   │
│ Render       │  .md    │      {slug}.md           │
│ (CF Browser) │         └──────────────────────────┘
└────┬─────────┘
     │
     ▼
[rss-articles-rendered] queue ── batch 1, 60s
     │
     ▼
┌──────────────┐         ┌──────────────────────────┐
│ Stage 2      │────────▶│ R2: clean/{date}/{host}/ │
│ Clean        │  .md    │      {slug}.md           │
│ (DeepSeek)   │         └──────────────────────────┘
└────┬─────────┘
     │                   ┌──────────────────────────┐
     ├──────────────────▶│ D1: articles             │
     │  INSERT           │ url, title, published,   │
     │                   │ r2_raw_key, r2_clean_key │
     │                   └───────────▲──────────────┘
     │ R2 references                 │
     │ only in queue msg             │
     ▼                               │
[rss-articles-cleaned] queue         │
     │                               │
     ▼                               │
┌──────────────┐    UPDATE status    │
│ Stage 3      │─────────────────────┘
│ Triage       │──▶ reads clean/{...}.md from R2
│ (DeepSeek)   │
└──────────────┘
     │
     ▼
 relevant / irrelevant
```

## Cloudflare Resources

| Resource | Type | Binding | ID / Name |
|----------|------|---------|-----------|
| `SEEN_URLS` | KV Namespace | `SEEN_URLS` | `dfbf88ee16984601b5227d85902fe252` |
| `dd-ingester-db` | D1 Database | `DB` | `c29a8ecd-5fef-4dcc-8f35-f557b06a7e33` |
| `dd-articles-markdown` | R2 Bucket | `ARTICLES_BUCKET` | — |
| `rss-articles` | Queue | `RSS_QUEUE` | — |
| `rss-articles-rendered` | Queue | `RENDERED_QUEUE` | — |
| `rss-articles-cleaned` | Queue | `CLEANED_QUEUE` | — |
| AI Gateway | Custom Provider | — | `dd-ai-gateway/custom-nvidia-nim` |

### Secrets (set via `wrangler secret put`)

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | CF API token for Browser Rendering REST API |
| `NVIDIA_API_KEY` | NVIDIA NIM API key (for AI Gateway) |
| `CF_AIG_TOKEN` | Cloudflare AI Gateway auth token |

## Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker entry: fetch, scheduled, queue dispatch |
| `src/ai-gateway.ts` | Shared AI Gateway client (`callAIGateway`, `DEFAULT_MODEL`) |
| `src/renderer.ts` | Stage 1: Browser Rendering API → raw markdown in R2 |
| `src/cleaner.ts` | Stage 2: DeepSeek boilerplate removal → cleaned markdown in R2 + D1 |
| `src/triage.ts` | Stage 3: DeepSeek relevance classification → D1 update |
| `src/rss.ts` | RSS/Atom XML parser with URL normalization |
| `src/feeds.ts` | Static list of 33 RSS feed URLs |

## Models (free via NVIDIA NIM)

| Model | Stage | Purpose |
|-------|-------|---------|
| `deepseek-ai/deepseek-v3.2` | Clean | Strip navigation, sidebars, boilerplate from rendered markdown |
| `deepseek-ai/deepseek-v3.2` | Triage | Classify articles as relevant/irrelevant for Indian travel rewards |

## Operating the Pipeline

All operations use the Cloudflare account ID `e0bc1f55dc6fc3f8fe870087199a2ee3`. Set it as a variable for convenience:

```bash
export CF_ACCOUNT_ID=e0bc1f55dc6fc3f8fe870087199a2ee3
```

### Send messages to a queue

Use the [Cloudflare Queue REST API](https://developers.cloudflare.com/api/resources/queues/subresources/messages/methods/push/). The `body` field must be a JSON **object** (not a stringified JSON string).

#### Setup

```bash
export CF_ACCOUNT_ID=e0bc1f55dc6fc3f8fe870087199a2ee3
export CF_API_TOKEN=<your-cloudflare-api-token>
```

Get queue IDs:

```bash
npx wrangler queues list
# Or via API:
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/queues" \
  -H "Authorization: Bearer $CF_API_TOKEN" | jq '.result[] | {queue_name, queue_id}'
```

#### Single message

```bash
QUEUE_ID=<queue-id>
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/queues/$QUEUE_ID/messages" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":{"url":"https://example.com/article","title":"Test","published":"2026-03-27T00:00:00Z","feedUrl":"https://example.com/feed"}}'
```

#### Batch messages (up to 100 per call)

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/queues/$QUEUE_ID/messages/batch" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"body":{...}},{"body":{...}}]}'
```

#### Queue message schemas by stage

```jsonc
// rss-articles (Stage 1 input — render)
{ "url": "...", "title": "...", "published": "ISO8601", "feedUrl": "..." }

// rss-articles-rendered (Stage 2 input — clean)
{ "url": "...", "title": "...", "published": "...", "feedUrl": "...", "r2RawKey": "raw/..." }

// rss-articles-cleaned (Stage 3 input — triage)
{ "url": "...", "title": "...", "published": "...", "feedUrl": "...",
  "r2RawKey": "raw/...", "r2CleanKey": "clean/..." }
```

### Requeue all articles for re-cleaning and triage

Dump article metadata from D1, then batch-send to the rendered queue:

```bash
QUEUE_ID=<rss-articles-rendered queue id>

# Export articles from D1 as queue messages
npx wrangler d1 execute dd-ingester-db --remote \
  --command "SELECT url, title, published, feed_url, r2_raw_key FROM articles" --json \
  | jq '.[0].results | map({body: {url: .url, title: .title, published: .published, feedUrl: .feed_url, r2RawKey: .r2_raw_key}})' \
  > /tmp/queue-msgs.json

# Send in batches of 10
jq -c '[.[] | .body]' /tmp/queue-msgs.json \
  | jq -c 'range(0; length; 10) as $i | {messages: [.[($i):($i+10)][] | {body: .}]}' \
  | while read batch; do
      echo "$batch" > /tmp/batch_payload.json
      curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/queues/$QUEUE_ID/messages/batch" \
        -H "Authorization: Bearer $CF_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d @/tmp/batch_payload.json | jq -c '{success: .success}'
    done
```

### Clean up R2 and D1 before requeuing

```bash
# Delete all clean/ R2 objects
npx wrangler d1 execute dd-ingester-db --remote \
  --command "SELECT r2_clean_key FROM articles" --json \
  | jq -r '.[0].results[].r2_clean_key' \
  | while read key; do
      npx wrangler r2 object delete "dd-articles-markdown/$key" --remote
    done

# Clear D1 articles table
npx wrangler d1 execute dd-ingester-db --remote --command "DELETE FROM articles"
```

### Query articles from D1

Via the worker HTTP endpoint:

```bash
# All articles
curl https://dd-ingester.<your-subdomain>.workers.dev/articles

# Filter by triage status
curl https://dd-ingester.<your-subdomain>.workers.dev/articles?status=relevant
curl https://dd-ingester.<your-subdomain>.workers.dev/articles?status=irrelevant
```

Via wrangler CLI:

```bash
npx wrangler d1 execute dd-ingester-db --command "SELECT url, title, triage_status, triage_reason FROM articles ORDER BY published DESC LIMIT 20"
```

### R2 operations

```bash
# Download a specific article
npx wrangler r2 object get "dd-articles-markdown/raw/2026-03-27/loyaltylobby.com/some-article.md" --remote --pipe > article.md

# Delete a specific object
npx wrangler r2 object delete "dd-articles-markdown/raw/2026-03-27/loyaltylobby.com/some-article.md" --remote

# List objects by prefix (via API — wrangler has no list command)
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/r2/buckets/dd-articles-markdown/objects" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  --data-urlencode "prefix=raw/" | jq '.result.objects[].key'
```

### Check queue backlogs

```bash
npx wrangler queues list
```

### Tail live worker logs

```bash
npx wrangler tail dd-ingester --format pretty
```

### Trigger the cron manually

```bash
curl "https://dd-ingester.<your-subdomain>.workers.dev/cdn-cgi/mf/scheduled"
```

## Deployment

Merging to `main` triggers the GitHub Actions workflow (`.github/workflows/deploy.yml`). No manual deploys.

## R2 Key Convention

All R2 keys follow `{stage}/{YYYY-MM-DD}/{hostname}/{slug}.md`:

- `raw/2026-03-27/loyaltylobby.com/loyaltylobby-com-some-article.md`
- `clean/2026-03-27/loyaltylobby.com/loyaltylobby-com-some-article.md`

## D1 Schema

```sql
CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  published TEXT NOT NULL,
  feed_url TEXT NOT NULL,
  r2_raw_key TEXT NOT NULL,
  r2_clean_key TEXT,
  triage_status TEXT,       -- 'relevant' | 'irrelevant'
  triage_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_articles_triage_status ON articles(triage_status);
CREATE INDEX idx_articles_published ON articles(published);
```
