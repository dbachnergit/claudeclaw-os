/**
 * Dev-agent dashboard page (the spec-approval surface).
 *
 * This is a DATA-FREE SPA shell, served unauthenticated like the `/` SPA.
 * It embeds NO task data, NO spec_md, and NO token. At runtime it reads
 * `?token=` from `window.location` and fetches the token-gated
 * `/api/dev/tasks` endpoint, then renders the queue and drives the three
 * human-gate POSTs (approve / request-changes / reject). Keeping the shell
 * data-free is the round-2 security contract: GET /dev passes through the
 * auth middleware (which gates only `/api/*`), so it must never carry a
 * spec or token in its source.
 */
export function getDevDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dev Agent</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0e1116; color: #e6edf3; line-height: 1.5;
    padding: 24px; max-width: 880px; margin: 0 auto;
  }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  .sub { color: #8b949e; font-size: 13px; margin-bottom: 24px; }
  .empty { color: #8b949e; padding: 40px 0; text-align: center; }
  .task {
    background: #161b22; border: 1px solid #30363d; border-radius: 10px;
    padding: 16px; margin-bottom: 16px;
  }
  .task-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .issue { font-weight: 700; }
  .title { color: #c9d1d9; }
  .badge {
    font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .b-spec_drafted { background: #1f6feb33; color: #79c0ff; }
  .b-running { background: #d2992233; color: #e3b341; }
  .b-spec_approved { background: #23863633; color: #56d364; }
  .b-pr_open { background: #23863633; color: #56d364; }
  .b-queued { background: #6e768166; color: #c9d1d9; }
  .b-stuck, .b-rejected { background: #f8514933; color: #ff7b72; }
  .meta { color: #8b949e; font-size: 12px; margin: 8px 0; }
  .spec {
    background: #0d1117; border: 1px solid #30363d; border-radius: 8px;
    padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; white-space: pre-wrap; max-height: 320px; overflow: auto;
    margin: 8px 0;
  }
  .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  button {
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    border-radius: 7px; padding: 7px 14px; border: 1px solid transparent;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .approve { background: #238636; color: #fff; }
  .changes { background: #21262d; color: #e6edf3; border-color: #30363d; }
  .reject { background: #21262d; color: #ff7b72; border-color: #30363d; }
  .notes { width: 100%; margin-top: 10px; background: #0d1117; color: #e6edf3;
    border: 1px solid #30363d; border-radius: 7px; padding: 8px; font: inherit;
    font-size: 13px; display: none; }
  .err { color: #ff7b72; font-size: 13px; margin-bottom: 16px; }
</style>
</head>
<body>
  <h1>Dev Agent</h1>
  <div class="sub">Spec approval queue. Review each drafted spec, then approve, request changes, or reject.</div>
  <div id="err" class="err" style="display:none"></div>
  <div id="list"><div class="empty">Loading...</div></div>

<script>
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const q = token ? ('?token=' + encodeURIComponent(token)) : '';
  const listEl = document.getElementById('list');
  const errEl = document.getElementById('err');

  function showErr(msg) {
    errEl.textContent = msg;
    errEl.style.display = msg ? 'block' : 'none';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function render(tasks) {
    if (!tasks.length) {
      listEl.innerHTML = '<div class="empty">No active dev tasks.</div>';
      return;
    }
    listEl.innerHTML = tasks.map(function (t) {
      const drafted = t.status === 'spec_drafted';
      const stage = t.stage ? (' &middot; ' + esc(t.stage)) : '';
      const cost = (typeof t.cost_usd === 'number') ? (' &middot; $' + t.cost_usd.toFixed(2)) : '';
      const rounds = (typeof t.review_rounds === 'number') ? (' &middot; ' + t.review_rounds + ' rounds') : '';
      const spec = t.spec_md ? '<div class="spec">' + esc(t.spec_md) + '</div>' : '';
      const pr = t.pr_url ? '<div class="meta"><a href="' + esc(t.pr_url) + '" style="color:#79c0ff">' + esc(t.pr_url) + '</a></div>' : '';
      const actions = drafted
        ? '<div class="actions">'
          + '<button class="approve" data-act="approve" data-id="' + esc(t.id) + '">Approve</button>'
          + '<button class="changes" data-act="request-changes" data-id="' + esc(t.id) + '">Request changes</button>'
          + '<button class="reject" data-act="reject" data-id="' + esc(t.id) + '">Reject</button>'
          + '<textarea class="notes" data-notes="' + esc(t.id) + '" placeholder="What should change? (required)"></textarea>'
          + '</div>'
        : '';
      return '<div class="task">'
        + '<div class="task-head">'
        + '<span class="issue">#' + esc(t.issue_number) + '</span>'
        + '<span class="title">' + esc(t.issue_title) + '</span>'
        + '<span class="badge b-' + esc(t.status) + '">' + esc(t.status) + '</span>'
        + '</div>'
        + '<div class="meta">' + esc(t.status) + stage + rounds + cost + '</div>'
        + spec + pr + actions
        + '</div>';
    }).join('');
  }

  async function load() {
    try {
      const res = await fetch('/api/dev/tasks' + q);
      if (res.status === 401) { showErr('Unauthorized. Append ?token=... to the URL.'); return; }
      if (!res.ok) { showErr('Failed to load tasks (' + res.status + ').'); return; }
      const body = await res.json();
      showErr('');
      render(body.tasks || []);
    } catch (e) {
      showErr('Network error loading tasks.');
    }
  }

  async function act(id, action, btn) {
    let payload = {};
    if (action === 'request-changes') {
      const ta = document.querySelector('textarea[data-notes="' + id + '"]');
      if (ta && ta.style.display !== 'block') {
        ta.style.display = 'block';
        ta.focus();
        return; // first click reveals the field; second click submits
      }
      payload = { notes: ta ? ta.value : '' };
    }
    btn.disabled = true;
    try {
      const res = await fetch('/api/dev/tasks/' + encodeURIComponent(id) + '/' + action + q, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 409) {
        showErr('That task already moved on (stale view). Reloading.');
      } else if (res.status === 400) {
        showErr('Notes are required for "request changes".');
        btn.disabled = false;
        return;
      } else if (!res.ok) {
        showErr('Action failed (' + res.status + ').');
      } else {
        showErr('');
      }
    } catch (e) {
      showErr('Network error performing action.');
    }
    await load();
  }

  listEl.addEventListener('click', function (ev) {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    act(btn.getAttribute('data-id'), btn.getAttribute('data-act'), btn);
  });

  load();
  setInterval(load, 5000);
</script>
</body>
</html>`;
}
