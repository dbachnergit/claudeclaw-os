import { describe, it, expect, vi } from 'vitest';
import { draftReplyForFeedback, type DraftInput } from '../index';

/** Build a valid agent JSON response with optional overrides. */
function validResponse(overrides: Partial<Record<string, unknown>> = {}): string {
  const base = {
    classification: 'bug',
    draft_subject: 'Re: Crash on save',
    draft_body: "Thanks for the report. We'll look into the save crash.",
    suggested_issue_title: 'Save action crashes',
    suggested_issue_body: 'Reported in TestFlight build 71.\n\nFiled from AI OS.',
    suggested_priority: 'p1',
    phi_flag: false,
    ...overrides,
  };
  return JSON.stringify(base);
}

describe('draftReplyForFeedback', () => {
  it('returns parsed output for clean input with no PHI', async () => {
    const stub = vi.fn().mockResolvedValue(validResponse());
    const input: DraftInput = {
      feedbackText: 'App crashes when I tap save',
      buildVersion: '71',
      testerFirstName: 'Sam',
      runAgent: stub,
    };

    const out = await draftReplyForFeedback(input);

    expect(out.classification).toBe('bug');
    expect(out.phi_flag).toBe(false);
    expect(out.redacted_terms).toEqual([]);
    expect(out.draft_subject).toBe('Re: Crash on save');
    expect(out.suggested_priority).toBe('p1');
  });

  it('forces phi_flag=true when redactor caught health terms even if model returned false', async () => {
    const stub = vi.fn().mockResolvedValue(validResponse({ phi_flag: false }));
    const input: DraftInput = {
      feedbackText: 'App crashes when I tap save while logging my Lisinopril dose',
      buildVersion: '71',
      testerFirstName: 'Sam',
      runAgent: stub,
    };

    const out = await draftReplyForFeedback(input);

    // Prompt the stub received must be redacted.
    const promptArg = stub.mock.calls[0][0] as string;
    expect(promptArg).toContain('[redacted]');
    expect(promptArg.toLowerCase()).not.toContain('lisinopril');

    // Even though the model said false, runtime forces true.
    expect(out.phi_flag).toBe(true);
    expect(out.redacted_terms).toContain('lisinopril');
  });

  it('strips markdown fence (```json ... ```)', async () => {
    const fenced = '```json\n' + validResponse() + '\n```';
    const stub = vi.fn().mockResolvedValue(fenced);
    const input: DraftInput = {
      feedbackText: 'Generic feedback',
      buildVersion: '71',
      testerFirstName: 'Sam',
      runAgent: stub,
    };

    const out = await draftReplyForFeedback(input);
    expect(out.classification).toBe('bug');
  });

  it('strips a bare ``` fence (no json language tag)', async () => {
    const fenced = '```\n' + validResponse() + '\n```';
    const stub = vi.fn().mockResolvedValue(fenced);
    const input: DraftInput = {
      feedbackText: 'Generic feedback',
      buildVersion: '71',
      testerFirstName: 'Sam',
      runAgent: stub,
    };

    const out = await draftReplyForFeedback(input);
    expect(out.classification).toBe('bug');
  });

  it('handles leading/trailing whitespace around raw JSON', async () => {
    const stub = vi.fn().mockResolvedValue('   ' + validResponse() + '   \n');
    const input: DraftInput = {
      feedbackText: 'Generic feedback',
      buildVersion: '71',
      testerFirstName: 'Sam',
      runAgent: stub,
    };

    const out = await draftReplyForFeedback(input);
    expect(out.classification).toBe('bug');
  });

  it('throws when classification is invalid', async () => {
    const stub = vi.fn().mockResolvedValue(validResponse({ classification: 'urgent' }));
    const input: DraftInput = {
      feedbackText: 'Generic feedback',
      buildVersion: '71',
      testerFirstName: 'Sam',
      runAgent: stub,
    };

    await expect(draftReplyForFeedback(input)).rejects.toThrow(/classification/);
  });

  it('throws when suggested_priority is invalid', async () => {
    const stub = vi.fn().mockResolvedValue(validResponse({ suggested_priority: 'p4' }));
    const input: DraftInput = {
      feedbackText: 'Generic feedback',
      buildVersion: '71',
      testerFirstName: 'Sam',
      runAgent: stub,
    };

    await expect(draftReplyForFeedback(input)).rejects.toThrow(/priority/);
  });

  it('throws when required fields are missing', async () => {
    const stub = vi.fn().mockResolvedValue(JSON.stringify({ classification: 'bug' }));
    const input: DraftInput = {
      feedbackText: 'Generic feedback',
      buildVersion: '71',
      testerFirstName: 'Sam',
      runAgent: stub,
    };

    await expect(draftReplyForFeedback(input)).rejects.toThrow();
  });

  it('throws with a clear message when JSON is unparseable', async () => {
    const stub = vi.fn().mockResolvedValue('this is not json at all');
    const input: DraftInput = {
      feedbackText: 'Generic feedback',
      buildVersion: '71',
      testerFirstName: 'Sam',
      runAgent: stub,
    };

    await expect(draftReplyForFeedback(input)).rejects.toThrow(/parse/i);
  });

  it("uses 'unknown' in the prompt when testerFirstName is null", async () => {
    const stub = vi.fn().mockResolvedValue(validResponse());
    const input: DraftInput = {
      feedbackText: 'Generic feedback',
      buildVersion: '71',
      testerFirstName: null,
      runAgent: stub,
    };

    await draftReplyForFeedback(input);
    const promptArg = stub.mock.calls[0][0] as string;
    expect(promptArg).toContain('Tester first name: unknown');
  });

  it('uses the provided first name in the prompt', async () => {
    const stub = vi.fn().mockResolvedValue(validResponse());
    const input: DraftInput = {
      feedbackText: 'Generic feedback',
      buildVersion: '71',
      testerFirstName: 'Sam',
      runAgent: stub,
    };

    await draftReplyForFeedback(input);
    const promptArg = stub.mock.calls[0][0] as string;
    expect(promptArg).toContain('Tester first name: Sam');
  });

  it('includes the PHI nudge line when health terms were redacted', async () => {
    const stub = vi.fn().mockResolvedValue(validResponse());
    const input: DraftInput = {
      feedbackText: 'I take Tylenol every morning and the app keeps crashing',
      buildVersion: '71',
      testerFirstName: 'Sam',
      runAgent: stub,
    };

    await draftReplyForFeedback(input);
    const promptArg = stub.mock.calls[0][0] as string;
    expect(promptArg).toContain('redacted from this feedback');
  });

  it('omits the PHI nudge line when no health terms were redacted', async () => {
    const stub = vi.fn().mockResolvedValue(validResponse());
    const input: DraftInput = {
      feedbackText: 'The save button never responds when I tap it',
      buildVersion: '71',
      testerFirstName: 'Sam',
      runAgent: stub,
    };

    await draftReplyForFeedback(input);
    const promptArg = stub.mock.calls[0][0] as string;
    expect(promptArg).not.toContain('redacted from this feedback');
  });

  it('PROOF: original health terms never appear in the prompt the model sees', async () => {
    const fixtures: Array<{ text: string; terms: string[] }> = [
      {
        text: 'I take Tylenol every morning and the app keeps crashing',
        terms: ['Tylenol'],
      },
      {
        text: 'My A1C reading from the cardiologist did not save',
        terms: ['A1C', 'cardiologist'],
      },
      {
        text: 'After my AFib episode the recording cut off',
        terms: ['AFib'],
      },
      {
        text: 'I take metformin for diabetes and need to log it',
        terms: ['metformin', 'diabetes'],
      },
      {
        text: "My mother has Alzheimer's and the share sheet is broken",
        terms: ["Alzheimer's"],
      },
    ];

    for (const { text, terms } of fixtures) {
      const stub = vi.fn().mockResolvedValue(validResponse());
      const input: DraftInput = {
        feedbackText: text,
        buildVersion: '71',
        testerFirstName: 'Sam',
        runAgent: stub,
      };
      await draftReplyForFeedback(input);

      const promptArg = (stub.mock.calls[0][0] as string).toLowerCase();
      for (const term of terms) {
        expect(
          promptArg.includes(term.toLowerCase()),
          `term "${term}" leaked into the prompt for input "${text}"`
        ).toBe(false);
      }
    }
  });
});
