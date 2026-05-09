import { describe, it, expect } from 'vitest';
import { redactPhi } from '../phi-redact';

describe('redactPhi', () => {
  it('returns empty result for empty input', () => {
    const result = redactPhi('');
    expect(result.redactedText).toBe('');
    expect(result.redactedTermsFound).toEqual([]);
  });

  it('returns identical text and empty terms when no health terms present', () => {
    const input = 'The app crashed when I tapped the record button on my iPhone.';
    const result = redactPhi(input);
    expect(result.redactedText).toBe(input);
    expect(result.redactedTermsFound).toEqual([]);
  });

  it('redacts a single medication match', () => {
    const result = redactPhi('I took Tylenol this morning');
    expect(result.redactedText).toContain('[redacted]');
    expect(result.redactedText).not.toContain('Tylenol');
    expect(result.redactedText).not.toContain('tylenol');
    expect(result.redactedTermsFound).toContain('tylenol');
  });

  it('is case-insensitive (lowercase)', () => {
    const result = redactPhi('I took tylenol this morning');
    expect(result.redactedText).not.toContain('tylenol');
    expect(result.redactedText).toContain('[redacted]');
  });

  it('is case-insensitive (uppercase)', () => {
    const result = redactPhi('I TOOK TYLENOL THIS MORNING');
    expect(result.redactedText).not.toMatch(/TYLENOL/i);
    expect(result.redactedText).toContain('[redacted]');
  });

  it('is case-insensitive (mixed)', () => {
    const result = redactPhi('I took Tylenol this morning');
    expect(result.redactedText).not.toMatch(/tylenol/i);
  });

  it('redacts multi-word terms as a single unit and preserves surrounding words', () => {
    const result = redactPhi('My blood pressure was high');
    expect(result.redactedText).not.toMatch(/blood pressure/i);
    expect(result.redactedText).toContain('[redacted]');
    // "high" is not a clinical term, so it must remain.
    expect(result.redactedText).toContain('high');
    expect(result.redactedTermsFound).toContain('blood pressure');
    // The whole phrase should collapse to ONE [redacted], not two.
    const matches = result.redactedText.match(/\[redacted\]/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('respects word boundaries: "lab" inside "labor" is not redacted', () => {
    // "lab" is not in our terminology list, but neither is "labor".
    // The point: substring matches inside a longer word should never trigger.
    // Use a known term that is a prefix of a longer non-clinical word: "MS"
    // is in the list (multiple sclerosis). Make sure "MSNBC" or "MSG" do
    // not get redacted just because they start with MS.
    const result = redactPhi('I watch MSNBC every night');
    expect(result.redactedText).toBe('I watch MSNBC every night');
    expect(result.redactedTermsFound).toEqual([]);
  });

  it('respects word boundaries: "labor" is not redacted as "lab"', () => {
    const result = redactPhi('It was a labor of love');
    expect(result.redactedText).toBe('It was a labor of love');
  });

  it('redacts A1C as a standalone clinical acronym', () => {
    const result = redactPhi('She had her A1C done last week');
    expect(result.redactedText).not.toContain('A1C');
    expect(result.redactedText).toContain('[redacted]');
    expect(result.redactedTermsFound).toContain('a1c');
  });

  it('redacts multiple distinct terms with separate markers', () => {
    const result = redactPhi('I take metformin for diabetes');
    expect(result.redactedText).not.toMatch(/metformin/i);
    expect(result.redactedText).not.toMatch(/diabetes/i);
    const matches = result.redactedText.match(/\[redacted\]/g) ?? [];
    expect(matches.length).toBe(2);
    expect(result.redactedTermsFound).toContain('metformin');
    expect(result.redactedTermsFound).toContain('diabetes');
  });

  it('dedupes redactedTermsFound across repeated occurrences of the same term', () => {
    const result = redactPhi('Tylenol then more Tylenol');
    const matches = result.redactedText.match(/\[redacted\]/g) ?? [];
    expect(matches.length).toBe(2);
    // Both replaced, but reported once.
    expect(result.redactedTermsFound).toEqual(['tylenol']);
  });

  it('preserves trailing punctuation', () => {
    const result = redactPhi('took Tylenol.');
    expect(result.redactedText).toBe('took [redacted].');
  });

  it('preserves leading and trailing whitespace and punctuation around match', () => {
    const result = redactPhi('  (Tylenol)  ');
    expect(result.redactedText).toBe('  ([redacted])  ');
  });

  it('keeps consecutive matches as separate markers (does not collapse)', () => {
    const result = redactPhi('Tylenol Advil');
    expect(result.redactedText).toBe('[redacted] [redacted]');
  });

  it('redacts care-context terms like "oncologist"', () => {
    const result = redactPhi('my oncologist said the scan was clear');
    expect(result.redactedText).not.toMatch(/oncologist/i);
    expect(result.redactedText).toContain('[redacted]');
    expect(result.redactedTermsFound).toContain('oncologist');
  });

  it("redacts Alzheimer's with apostrophe", () => {
    const result = redactPhi("My mother has Alzheimer's");
    expect(result.redactedText).not.toMatch(/alzheimer's/i);
    expect(result.redactedText).toContain('[redacted]');
  });

  it("redacts alzheimer's with apostrophe (lowercase)", () => {
    const result = redactPhi("my mother has alzheimer's disease");
    expect(result.redactedText).not.toMatch(/alzheimer's/i);
    expect(result.redactedText).toContain('[redacted]');
  });

  it('redacts Alzheimers without apostrophe', () => {
    const result = redactPhi('My mother has Alzheimers');
    expect(result.redactedText).not.toMatch(/alzheimers/i);
    expect(result.redactedText).toContain('[redacted]');
  });

  it('redacts AFib in mixed case variants', () => {
    expect(redactPhi('AFib').redactedText).toBe('[redacted]');
    expect(redactPhi('afib').redactedText).toBe('[redacted]');
    expect(redactPhi('AFIB').redactedText).toBe('[redacted]');
  });

  it('PROOF: known terms never appear (case-insensitive) in redacted output', () => {
    const fixtures = [
      { text: 'I took Tylenol with my morning coffee', terms: ['tylenol'] },
      { text: 'My A1C is way too high', terms: ['a1c'] },
      { text: 'Saw the cardiologist about my AFib', terms: ['cardiologist', 'afib'] },
      { text: 'I take metformin for diabetes', terms: ['metformin', 'diabetes'] },
      { text: 'My blood pressure has been all over the place', terms: ['blood pressure'] },
    ];
    for (const { text, terms } of fixtures) {
      const result = redactPhi(text);
      for (const term of terms) {
        expect(
          result.redactedText.toLowerCase().includes(term.toLowerCase()),
          `term "${term}" leaked through redactor for input "${text}" -> "${result.redactedText}"`
        ).toBe(false);
      }
    }
  });

  it('PROPERTY: stripping [redacted] markers leaves no source health term behind', () => {
    const fixtures = [
      'I took Tylenol with my morning coffee',
      'My A1C is way too high lately',
      'Saw the cardiologist about my AFib last week',
      'I take metformin for diabetes',
      'My blood pressure has been all over the place',
    ];
    // The set of terms we expect to verify against (a subset of the full
    // terminology that appears in the fixtures).
    const trackedTerms = [
      'Tylenol',
      'A1C',
      'cardiologist',
      'AFib',
      'metformin',
      'diabetes',
      'blood pressure',
    ];

    for (const text of fixtures) {
      const result = redactPhi(text);
      // Strip out [redacted] markers entirely and lowercase what remains.
      const stripped = result.redactedText.split('[redacted]').join('').toLowerCase();
      for (const term of trackedTerms) {
        expect(
          stripped.includes(term.toLowerCase()),
          `term "${term}" survived redaction in "${text}" -> "${result.redactedText}"`
        ).toBe(false);
      }
    }
  });
});
