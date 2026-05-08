---
name: github-issues
description: Promote SQLite asc_feedback rows to GitHub Issues with consistent labels. Use after the operator approves a draft on the dashboard, or when explicitly asked to file an issue.
---

Wraps `gh issue create`. Maintains the canonical label taxonomy
(source:*, type:*, priority:*, status:*). Updates `asc_feedback.status`
to `approved` and stores the resulting issue URL in the
`github_issue_url` column on success.
