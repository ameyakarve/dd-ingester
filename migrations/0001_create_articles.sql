-- Migration number: 0001 	 2026-03-27T02:32:15.699Z
CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  published TEXT NOT NULL,
  feed_url TEXT NOT NULL,
  r2_raw_key TEXT NOT NULL,
  r2_clean_key TEXT,
  cleaned_content TEXT,
  triage_status TEXT,
  triage_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_articles_triage_status ON articles(triage_status);
CREATE INDEX idx_articles_published ON articles(published);
