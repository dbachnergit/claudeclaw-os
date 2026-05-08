-- Add github_issue_url column to asc_feedback. Populated by the
-- github-issues skill (Phase 3) when an operator approves a draft.
-- Nullable: pending and rejected rows have no associated issue.
ALTER TABLE asc_feedback ADD COLUMN github_issue_url TEXT;
