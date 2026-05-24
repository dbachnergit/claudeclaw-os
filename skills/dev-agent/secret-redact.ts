// skills/dev-agent/secret-redact.ts
//
// VENDORED, VERBATIM, from src/exfiltration-guard.ts (scanForSecrets /
// redactSecrets / PATTERNS). Skills compile in place (tsconfig.skills.json,
// rootDir ./skills) and load as skills/<name>/*.js at runtime, while src
// compiles to dist/ — so a skill CANNOT import ../../src/* (it breaks both
// tsc rootDir and the runtime path). This mirrors how comms-agent vendors its
// own phi-redact.ts inside the skills tree. KEEP IN SYNC with
// src/exfiltration-guard.ts; if that file's patterns change, update here too.

export interface SecretMatch {
  type: string;
  position: number;
  length: number;
  preview: string;
}

const PATTERNS: Array<{ type: string; regex: RegExp }> = [
  // Anthropic API keys: sk-ant- followed by 20+ alphanumeric chars
  { type: 'anthropic_key', regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },

  // Generic SK keys: sk- followed by 20+ alphanumeric/dash chars
  // (must not start with sk-ant- to avoid double-matching Anthropic keys)
  { type: 'generic_sk_key', regex: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/g },

  // Slack tokens: xoxb- or xoxp- followed by alphanumeric/dash chars
  { type: 'slack_token', regex: /xox[bp]-[A-Za-z0-9-]+/g },

  // GitHub tokens: ghp_ or gho_ followed by 20+ alphanumeric chars
  { type: 'github_token', regex: /gh[po]_[A-Za-z0-9]{20,}/g },

  // AWS access keys: AKIA followed by exactly 16 alphanumeric chars
  { type: 'aws_key', regex: /AKIA[A-Za-z0-9]{16}/g },

  // Long hex strings: 41+ hex chars (40-char SHAs handled separately below).
  { type: 'hex_key', regex: /(?<![A-Za-z0-9])[0-9a-fA-F]{41,}(?![A-Za-z0-9])/g },
];

// Git patterns that precede a 40-char hex SHA (so we don't redact commit SHAs).
const GIT_SHA_PREFIX = /(?:commit |tree |parent |object |[0-9a-f]{40}\.\.)/;

/** Scan text for leaked secrets and credentials. */
export function scanForSecrets(text: string, protectedValues?: string[]): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const seen = new Set<string>(); // dedupe by "position:length"

  for (const { type, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const key = `${m.index}:${m[0].length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ type, position: m.index, length: m[0].length, preview: m[0].slice(0, 8) + '...' });
    }
  }

  // Exactly-40-char hex strings that are NOT git SHAs.
  const hex40Regex = /(?<![A-Za-z0-9])[0-9a-fA-F]{40}(?![A-Za-z0-9])/g;
  let m40: RegExpExecArray | null;
  while ((m40 = hex40Regex.exec(text)) !== null) {
    if (m40[0].length === 40) {
      const prefix = text.slice(Math.max(0, m40.index - 10), m40.index);
      if (GIT_SHA_PREFIX.test(prefix)) continue;
      const key = `${m40.index}:${m40[0].length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ type: 'hex_key', position: m40.index, length: m40[0].length, preview: m40[0].slice(0, 8) + '...' });
    }
  }

  if (protectedValues) {
    for (const value of protectedValues) {
      if (value.length <= 8) continue;
      const variants: Array<{ encoded: string; label: string }> = [
        { encoded: Buffer.from(value).toString('base64'), label: 'base64' },
        { encoded: encodeURIComponent(value), label: 'url_encoded' },
      ];
      for (const { encoded, label } of variants) {
        if (encoded === value && label === 'url_encoded') continue;
        let idx = text.indexOf(encoded);
        while (idx !== -1) {
          const key = `${idx}:${encoded.length}`;
          if (!seen.has(key)) {
            seen.add(key);
            matches.push({ type: 'env_value', position: idx, length: encoded.length, preview: encoded.slice(0, 8) + '...' });
          }
          idx = text.indexOf(encoded, idx + 1);
        }
      }
    }
  }

  matches.sort((a, b) => a.position - b.position);
  return matches;
}

/** Replace each matched secret with [REDACTED] (end-to-start to keep positions valid). */
export function redactSecrets(text: string, matches: SecretMatch[]): string {
  if (matches.length === 0) return text;
  const sorted = [...matches].sort((a, b) => b.position - a.position);
  let result = text;
  for (const match of sorted) {
    result = result.slice(0, match.position) + '[REDACTED]' + result.slice(match.position + match.length);
  }
  return result;
}
