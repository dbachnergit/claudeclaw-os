-- store/migrations/2026-05-08-asc-drafts.sql
-- Phase 4 Task 4.4: ephemeral working-state table for comms-agent drafts
-- awaiting human approval. One draft per feedback row (UNIQUE on
-- feedback_id). Status enum is CHECK-constrained. The redactor's caught
-- terms are stored as a JSON-encoded array string so the dashboard can
-- show "PHI flagged because: <terms>" after the agent has run.
CREATE TABLE IF NOT EXISTS asc_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id INTEGER NOT NULL UNIQUE REFERENCES asc_feedback(id),
  classification TEXT NOT NULL,
  draft_subject TEXT NOT NULL,
  draft_body TEXT NOT NULL,
  suggested_issue_title TEXT NOT NULL,
  suggested_issue_body TEXT NOT NULL,
  suggested_priority TEXT NOT NULL,
  phi_flag INTEGER NOT NULL DEFAULT 0,
  redacted_terms TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('pending_approval', 'approved', 'rejected')) DEFAULT 'pending_approval',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_asc_drafts_status ON asc_drafts(status);
CREATE INDEX IF NOT EXISTS idx_asc_drafts_feedback_id ON asc_drafts(feedback_id);
