---
name: appstoreconnect
description: Polls App Store Connect for TestFlight feedback, crashes, and customer reviews. Writes new items to the local SQLite. Use when the operator asks for the latest beta feedback, when scheduled cron fires, or when a Telegram message says "check feedback".
---

This skill polls the App Store Connect API on a schedule (registered separately by the cron scheduler) and writes new items to `asc_feedback` in the local SQLite. It does NOT classify, draft, or reply. Those live in the comms agent (Phase 4).

Inputs: none, secrets read from process.env.
Outputs: rows in `asc_feedback` with status `pending_classification`.
Failure: three consecutive failures pause polling; a single Telegram alert is sent (registered in Task 2.6).
