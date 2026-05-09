import { useState } from 'preact/hooks';
import { ExternalLink, AlertTriangle, RefreshCw } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { useFetch } from '@/lib/useFetch';
import { apiPost } from '@/lib/api';
import { pushToast } from '@/lib/toasts';

interface FeedbackRow {
  id: number;
  asc_id: string;
  type: 'testflight_feedback' | 'testflight_crash' | 'app_store_review';
  tester_id: string;
  build_version: string;
  text: string;
  received_at: number;
  status: 'pending_classification' | 'pending_approval';
  // Phase 4 (Task 4.6): the comms-agent's drafted reply, joined in by the
  // backend. When draft_id is null the agent hasn't run yet (cron is on a
  // 5-min interval) and the form falls back to heuristic defaults.
  draft_id: number | null;
  draft_classification: 'bug' | 'feature_request' | 'praise' | 'confusion' | null;
  draft_subject: string | null;
  draft_body: string | null;
  suggested_issue_title: string | null;
  suggested_issue_body: string | null;
  suggested_priority: 'p0' | 'p1' | 'p2' | 'p3' | null;
  phi_flag: 0 | 1 | null;
  redacted_terms: string[] | null;
  draft_created_at: number | null;
}

interface LaneResponse {
  items: FeedbackRow[];
}

type Classification = 'bug' | 'feature_request' | 'praise' | 'confusion';
type Priority = 'p0' | 'p1' | 'p2' | 'p3' | '';

const TYPE_LABEL: Record<FeedbackRow['type'], string> = {
  testflight_feedback: 'feedback',
  testflight_crash: 'crash',
  app_store_review: 'review',
};

function defaultTitle(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '(no text)';
  return trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed;
}

function defaultBody(it: FeedbackRow): string {
  const when = new Date(it.received_at * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const quoted = (it.text || '').split('\n').map((l) => '> ' + l).join('\n');
  return `${quoted}\n\n— ${it.tester_id || 'unknown'}, build ${it.build_version || '?'}, ${when}\n\n_(promoted from App Store Connect, asc_id=${it.asc_id || ''})_`;
}

function defaultClassification(it: FeedbackRow): Classification {
  if (it.type === 'testflight_crash') return 'bug';
  const t = (it.text || '').toLowerCase();
  if (/\b(crash|freeze|hang|bug|broken|doesn'?t work|stuck)\b/.test(t)) return 'bug';
  if (/\b(would love|wish|please add|feature|request|could you|can you add)\b/.test(t)) return 'feature_request';
  if (t.length > 0 && t.length < 20) return 'praise';
  if (/\b(thanks|love|awesome|great|amazing|fantastic)\b/.test(t)) return 'praise';
  return 'confusion';
}

function defaultPriority(c: Classification): Priority {
  return c === 'bug' ? 'p2' : '';
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

interface CardProps {
  row: FeedbackRow;
  onApproved: () => void;
  onRedrafted: () => void;
}

function Card({ row, onApproved, onRedrafted }: CardProps) {
  // Pre-populate from the agent's draft when present; fall back to heuristic
  // defaults when the comms-agent hasn't run yet (5-min cron, may be paused).
  const hasDraft = row.draft_id !== null;
  const initialClass: Classification = (row.draft_classification ?? defaultClassification(row)) as Classification;
  const initialTitle = row.suggested_issue_title ?? defaultTitle(row.text);
  const initialBody = row.suggested_issue_body ?? defaultBody(row);
  const initialPriority: Priority = (row.suggested_priority ?? defaultPriority(initialClass)) as Priority;

  const phiFlagged = row.phi_flag === 1;
  const redactedTerms = row.redacted_terms ?? [];

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [classification, setClassification] = useState<Classification>(initialClass);
  const [priority, setPriority] = useState<Priority>(initialPriority);
  const [submitting, setSubmitting] = useState(false);
  const [redrafting, setRedrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  const meta = `${TYPE_LABEL[row.type]} · build ${row.build_version || '?'} · ${row.tester_id || '?'} · ${formatTime(row.received_at)}`;

  async function submit(ev: Event) {
    ev.preventDefault();

    // PHI confirm gate. The badge tells the operator the redactor caught
    // health terms; this dialog forces a deliberate "yes I want to send a
    // reply about this" before the mailto opens.
    if (phiFlagged) {
      const confirmed = window.confirm(
        'This feedback was flagged as containing PHI. Are you sure you want to approve and send a reply?',
      );
      if (!confirmed) return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        classification,
        title,
        body,
      };
      if (priority) payload.priority = priority;
      const res = await apiPost<{ ok: boolean; url?: string; mailtoUrl?: string | null; error?: string }>(
        `/api/lanes/inbound-feedback/${row.id}/approve`,
        payload,
      );
      if (res.ok && res.url) {
        setCreatedUrl(res.url);
        pushToast({ tone: 'success', title: 'Issue created', description: res.url });
        onApproved();
        // Open the operator's default mail client with the agent's drafted
        // subject/body. Done last so the SPA state is settled (toast pushed,
        // lane refreshed) before the navigation hands off to the OS.
        if (res.mailtoUrl) {
          window.location.href = res.mailtoUrl;
        }
      } else {
        setError(res.error || 'unknown error');
      }
    } catch (e: any) {
      const msg = e?.body?.error || e?.message || String(e);
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  async function redraft() {
    setRedrafting(true);
    setError(null);
    try {
      const res = await apiPost<{ ok: boolean; drafted?: number; error?: string }>(
        `/api/lanes/inbound-feedback/${row.id}/redraft`,
        {},
      );
      if (res.ok) {
        pushToast({ tone: 'success', title: 'Re-drafted', description: 'Comms agent re-drafted this reply.' });
        onRedrafted();
      } else {
        setError(res.error || 'unknown error');
      }
    } catch (e: any) {
      const msg = e?.body?.error || e?.message || String(e);
      setError(msg);
    } finally {
      setRedrafting(false);
    }
  }

  const approveLabel = hasDraft ? 'Approve, send email, and promote' : 'Approve and promote';

  return (
    <div class="border border-[var(--color-border)] rounded-lg bg-[var(--color-card)] p-4">
      <div class="flex items-start justify-between gap-2 mb-1.5">
        <div class="text-[11px] text-[var(--color-text-faint)]">{meta}</div>
        {phiFlagged && (
          <div
            class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-yellow-100 text-yellow-900 border border-yellow-300"
            title={redactedTerms.length > 0 ? `Redacted: ${redactedTerms.join(', ')}` : undefined}
          >
            <AlertTriangle size={11} />
            PHI flagged
          </div>
        )}
      </div>
      <div class="text-[13px] text-[var(--color-text)] whitespace-pre-wrap mb-3">
        {row.text || <span class="italic text-[var(--color-text-muted)]">(empty)</span>}
      </div>

      {phiFlagged && redactedTerms.length > 0 && (
        <div class="text-[11px] text-[var(--color-text-muted)] mb-2">
          Redacted: <span class="font-mono">{redactedTerms.join(', ')}</span>
        </div>
      )}

      {hasDraft ? (
        <div class="mb-3 border border-[var(--color-border)] rounded-md bg-[var(--color-bg)] p-3">
          <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Draft reply</div>
          <div class="text-[12px] font-medium text-[var(--color-text)] mb-1">{row.draft_subject}</div>
          <div class="text-[12px] text-[var(--color-text-muted)] whitespace-pre-wrap">{row.draft_body}</div>
        </div>
      ) : (
        <div class="text-[11px] text-[var(--color-text-muted)] italic mb-3">
          No draft yet — comms agent runs every 5 minutes.
        </div>
      )}

      {createdUrl ? (
        <div class="flex items-center gap-1.5 text-[12px] text-[var(--color-status-done)]">
          <ExternalLink size={12} />
          <a href={createdUrl} target="_blank" rel="noopener" class="underline">{createdUrl}</a>
        </div>
      ) : !open ? (
        <div class="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            class="px-3 py-1.5 rounded-md text-[12px] font-medium bg-[var(--color-elevated)] text-[var(--color-text)] hover:bg-[var(--color-card-hover,var(--color-elevated))] border border-[var(--color-border)] transition-colors"
          >
            {approveLabel}
          </button>
          <button
            type="button"
            onClick={redraft}
            disabled={redrafting}
            class="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] border border-transparent disabled:opacity-40 transition-colors"
            title="Ask the comms agent to draft this reply again"
          >
            <RefreshCw size={12} class={redrafting ? 'animate-spin' : ''} />
            {redrafting ? 'Re-drafting…' : 'Re-draft'}
          </button>
          {error && (
            <div class="text-[11px] text-[var(--color-status-failed)] font-mono">Failed: {error}</div>
          )}
        </div>
      ) : (
        <form onSubmit={submit} class="flex flex-col gap-2">
          <label class="flex flex-col gap-1">
            <span class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Title</span>
            <input
              type="text"
              value={title}
              onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
              maxLength={255}
              class="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1.5 text-[12px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent,#7c5cff)]"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Body</span>
            <textarea
              value={body}
              onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
              rows={5}
              class="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1.5 text-[12px] text-[var(--color-text)] font-mono focus:outline-none focus:border-[var(--color-accent,#7c5cff)] resize-y"
            />
          </label>
          <div class="flex gap-2">
            <label class="flex flex-col gap-1 flex-1">
              <span class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Classification</span>
              <select
                value={classification}
                onChange={(e) => {
                  const c = (e.target as HTMLSelectElement).value as Classification;
                  setClassification(c);
                  if (!priority) setPriority(defaultPriority(c));
                }}
                class="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1.5 text-[12px] text-[var(--color-text)]"
              >
                <option value="bug">bug</option>
                <option value="feature_request">feature_request</option>
                <option value="praise">praise</option>
                <option value="confusion">confusion</option>
              </select>
            </label>
            <label class="flex flex-col gap-1 flex-1">
              <span class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Priority</span>
              <select
                value={priority}
                onChange={(e) => setPriority((e.target as HTMLSelectElement).value as Priority)}
                class="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1.5 text-[12px] text-[var(--color-text)]"
              >
                <option value="">(none)</option>
                <option value="p0">p0</option>
                <option value="p1">p1</option>
                <option value="p2">p2</option>
                <option value="p3">p3</option>
              </select>
            </label>
          </div>
          {error && (
            <div class="text-[11px] text-[var(--color-status-failed)] font-mono">Failed: {error}</div>
          )}
          <div class="flex gap-2 mt-1">
            <button
              type="submit"
              disabled={submitting || !title.trim()}
              class="px-3 py-1.5 rounded-md text-[12px] font-medium bg-[var(--color-accent,#7c5cff)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {submitting ? 'Submitting…' : approveLabel}
            </button>
            <button
              type="button"
              onClick={redraft}
              disabled={submitting || redrafting}
              class="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] disabled:opacity-40 transition-colors"
              title="Ask the comms agent to draft this reply again"
            >
              <RefreshCw size={12} class={redrafting ? 'animate-spin' : ''} />
              {redrafting ? 'Re-drafting…' : 'Re-draft'}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={submitting}
              class="px-3 py-1.5 rounded-md text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function InboundFeedback() {
  const { data, loading, error, refresh } = useFetch<LaneResponse>('/api/lanes/inbound-feedback', 30_000);
  const items = data?.items ?? [];

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Inbound Feedback"
        actions={<span class="text-[11px] text-[var(--color-text-muted)] tabular-nums">{items.length} pending</span>}
      />
      {error && <PageState error={error} />}
      {loading && items.length === 0 && <PageState loading />}
      {!loading && !error && items.length === 0 && (
        <PageState
          empty
          emptyTitle="Inbox is empty"
          emptyDescription="TestFlight feedback, crashes, and App Store reviews appear here as they arrive (polled every 30 minutes)."
        />
      )}
      {items.length > 0 && (
        <div class="flex-1 overflow-y-auto px-6 py-4">
          <div class="flex flex-col gap-3 max-w-3xl">
            {items.map((row) => (
              <Card
                key={row.id}
                row={row}
                onApproved={() => refresh()}
                onRedrafted={() => refresh()}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
