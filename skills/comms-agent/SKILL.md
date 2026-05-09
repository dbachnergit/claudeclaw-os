---
name: comms-agent
description: Drafts replies and pre-classifies inbound TestFlight and App Store feedback for human approval. PHI-redacts the tester's text before any LLM call so health-specific content cannot leak into a draft. Output is JSON consumed by the dashboard, never auto-sent.
---

Inserts an LLM "comms agent" between feedback intake and the operator
dashboard. The agent proposes a classification (bug, feature_request,
praise, confusion), a priority, a draft reply, and a draft GitHub Issue
title and body.

PatientScribe is patient-facing health software, so the skill applies a
programmatic PHI redaction pre-pass (`phi-redact.ts`) to the tester's
text before constructing any prompt. The LLM only ever sees the redacted
version. Combined with the agent prompt at `agents/comms/CLAUDE.md`,
this gives belt-and-suspenders protection against echoing health terms
back into a reply.

The actual LLM call lands in Task 4.3. This scaffold ships the
redactor, the typed input/output contract, and the entry-point seam.
