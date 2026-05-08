-- store/migrations/2026-05-08-asc-feedback.sql
CREATE TABLE IF NOT EXISTS asc_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asc_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('testflight_feedback', 'testflight_crash', 'app_store_review')),
  tester_id TEXT NOT NULL,
  build_version TEXT NOT NULL,
  text TEXT NOT NULL,
  screenshots_json TEXT NOT NULL DEFAULT '[]',
  raw_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_classification', 'pending_approval', 'approved', 'rejected', 'sent', 'error')),
  received_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_asc_feedback_status ON asc_feedback(status);
CREATE INDEX IF NOT EXISTS idx_asc_feedback_received ON asc_feedback(received_at DESC);
