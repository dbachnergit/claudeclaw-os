#!/usr/bin/env bash
# setup-github-labels.sh
#
# Creates the canonical AI OS label taxonomy on the PatientScribe repo.
# Idempotent: gh label create --force overwrites color/description on
# existing labels and creates missing ones. Safe to re-run.
#
# Taxonomy (12 labels):
#   source:*    where the item came from
#   type:*      what kind of work it is
#   priority:*  triage urgency
#   status:*    where it sits in the AI OS pipeline
#
# Usage: ./scripts/setup-github-labels.sh [owner/repo]
#   default repo: dbachnergit/PatientScribe

set -euo pipefail

REPO="${1:-dbachnergit/PatientScribe}"

echo "Applying AI OS label taxonomy to $REPO ..."

# format: name|color|description
LABELS=(
  "source:testflight|0E8A16|TestFlight feedback or crash from a beta tester"
  "source:appstore|1D76DB|App Store customer review"
  "source:internal|5319E7|Operator-filed item from inside the AI OS"
  "type:bug|D73A4A|Defect in shipped behavior"
  "type:feature|A2EEEF|New capability or enhancement"
  "type:chore|CFD3D7|Tech debt, cleanup, or non-user-visible work"
  "priority:p0|B60205|Drop everything"
  "priority:p1|D93F0B|Top of next batch"
  "priority:p2|FBCA04|Normal queue"
  "priority:p3|0E8A16|Eventually / nice-to-have"
  "status:draft|FBCA04|Reply drafted, awaiting operator approval"
  "status:in-flight|1D76DB|Issue picked up; work in progress"
)

for entry in "${LABELS[@]}"; do
  IFS='|' read -r name color description <<< "$entry"
  gh label create "$name" \
    --repo "$REPO" \
    --color "$color" \
    --description "$description" \
    --force >/dev/null
  echo "  ✓ $name"
done

echo
echo "Verifying ..."
gh label list --repo "$REPO" --limit 100 \
  | grep -E "^(source|type|priority|status):" \
  | sort

echo
COUNT=$(gh label list --repo "$REPO" --limit 100 \
  | grep -cE "^(source|type|priority|status):")
echo "Total taxonomy labels: $COUNT (expected: 12)"

if [ "$COUNT" -ne 12 ]; then
  echo "ERROR: expected 12 labels, found $COUNT" >&2
  exit 1
fi

echo "Done."
