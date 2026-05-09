// skills/comms-agent/phi-redact.ts
//
// Pure programmatic PHI redactor. Strips known health terminology from a
// tester's feedback text before it is shown to any LLM. The agent prompt
// (agents/comms/CLAUDE.md) is the second line of defense; this is the first.
//
// No I/O. No external dependencies. Single internal terminology list.
//
// Match rules:
//   - Case-insensitive
//   - Word-boundary aware (so "lab" inside "labor" is not redacted)
//   - Multi-word terms supported ("blood pressure", "Tylenol PM")
//   - Surrounding whitespace and punctuation preserved
//   - Consecutive matches stay separate ("[redacted] [redacted]") so the
//     reviewer can see how many distinct things were caught

export interface RedactionResult {
  redactedText: string;
  /** Unique normalized (lowercased) terms that were replaced. */
  redactedTermsFound: string[];
}

// Starter terminology list, ~150 entries, weighted toward common iOS-tester
// language. Categories: medications, conditions, symptoms, anatomy, lab and
// vital terms, care contexts. Sourced internally; no network call.
const TERMS: string[] = [
  // Medications
  'Tylenol',
  'Tylenol PM',
  'Advil',
  'ibuprofen',
  'acetaminophen',
  'Lisinopril',
  'metformin',
  'atorvastatin',
  'Lipitor',
  'Crestor',
  'levothyroxine',
  'Synthroid',
  'amlodipine',
  'omeprazole',
  'Prilosec',
  'Plavix',
  'warfarin',
  'gabapentin',
  'Adderall',
  'Ritalin',
  'Xanax',
  'Prozac',
  'Zoloft',
  'Lexapro',
  'sertraline',
  'fluoxetine',
  'Ozempic',
  'Wegovy',
  'semaglutide',
  'insulin',
  'albuterol',
  'prednisone',
  'methotrexate',
  'Voltaren',
  'naproxen',
  'Aleve',
  'Aspirin',
  'Benadryl',
  'Claritin',
  'Zyrtec',
  'Flonase',
  'Nexium',
  'Pepcid',
  'Zofran',
  'hydrocodone',
  'oxycodone',
  'Vicodin',
  'Percocet',
  'Tramadol',
  'Lyrica',
  'Cymbalta',
  'Wellbutrin',

  // Conditions
  'hypertension',
  'high blood pressure',
  'diabetes',
  'type 2 diabetes',
  'asthma',
  'COPD',
  'arthritis',
  'rheumatoid arthritis',
  'osteoarthritis',
  'lupus',
  'fibromyalgia',
  'epilepsy',
  'depression',
  'anxiety',
  'ADHD',
  'bipolar',
  'schizophrenia',
  'cancer',
  'breast cancer',
  'prostate cancer',
  'lung cancer',
  'leukemia',
  'lymphoma',
  'melanoma',
  "Alzheimer's",
  'Alzheimers',
  'dementia',
  "Parkinson's",
  'Parkinsons',
  'multiple sclerosis',
  'MS',
  'stroke',
  'heart attack',
  'heart disease',
  'atrial fibrillation',
  'AFib',
  'AFIB',
  'kidney disease',
  'CKD',
  'liver disease',
  'cirrhosis',
  'hepatitis',
  'pneumonia',
  'bronchitis',
  'GERD',
  'IBS',
  'IBD',
  "Crohn's",
  'Crohns',
  'ulcerative colitis',
  'gallstones',

  // Symptoms
  'chest pain',
  'shortness of breath',
  'dizziness',
  'fatigue',
  'nausea',
  'vomiting',
  'diarrhea',
  'constipation',
  'fever',
  'headache',
  'migraine',
  'rash',
  'swelling',
  'numbness',
  'tingling',
  'palpitations',
  'insomnia',

  // Anatomy with strong clinical context
  'prostate',
  'ovaries',
  'uterus',
  'cervix',
  'kidney',
  'liver',
  'gallbladder',
  'pancreas',
  'thyroid',
  'lymph node',
  'lymph nodes',

  // Labs and vitals
  'A1C',
  'HbA1c',
  'blood pressure',
  'BP',
  'cholesterol',
  'LDL',
  'HDL',
  'triglycerides',
  'glucose',
  'blood sugar',
  'creatinine',
  'hemoglobin',
  'hematocrit',
  'platelets',
  'INR',
  'TSH',
  'T3',
  'T4',
  'PSA',
  'EKG',
  'ECG',
  'MRI',
  'CT scan',
  'CAT scan',
  'ultrasound',
  'biopsy',
  'mammogram',
  'colonoscopy',
  'endoscopy',

  // Care contexts
  'oncologist',
  'cardiologist',
  'neurologist',
  'endocrinologist',
  'psychiatrist',
  'dermatologist',
  'rheumatologist',
  'gastroenterologist',
  'OB-GYN',
  'OBGYN',
  'primary care',
  'PCP',
  'ER visit',
  'ICU',
  'hospice',
  'chemotherapy',
  'chemo',
  'radiation',
  'dialysis',
  'surgery',
];

/** Escape a string for safe inclusion in a regex source. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a single combined regex, sorted longest-first so multi-word terms
// match before their substrings (e.g., "blood pressure" beats "blood").
//
// Word-boundary handling: \b only fires between a word char and a non-word
// char. Most of our terms start and end with word chars, so plain \b on the
// outside works. Terms ending in an apostrophe (e.g., "Alzheimer's",
// "Crohn's") are a problem: "'" is non-word, so a trailing \b would refuse
// to match before another non-word char. We compile those without a
// trailing \b and instead require either end-of-string or a non-word char
// (excluding letters/digits) afterwards via a lookahead.
function buildPattern(terms: string[]): RegExp {
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const alternatives = sorted.map((term) => {
    const escaped = escapeRegex(term);
    const startsWithWord = /^\w/.test(term);
    const endsWithWord = /\w$/.test(term);
    const left = startsWithWord ? '\\b' : '';
    // Apostrophe-trailing terms: require non-letter/digit boundary after.
    const right = endsWithWord ? '\\b' : '(?![A-Za-z0-9])';
    return `${left}${escaped}${right}`;
  });
  return new RegExp(`(?:${alternatives.join('|')})`, 'gi');
}

const PATTERN = buildPattern(TERMS);

export function redactPhi(input: string): RedactionResult {
  if (input.length === 0) {
    return { redactedText: '', redactedTermsFound: [] };
  }

  const found = new Set<string>();
  // Reset lastIndex defensively — global regex state is per-instance.
  PATTERN.lastIndex = 0;
  const redactedText = input.replace(PATTERN, (match) => {
    found.add(match.toLowerCase());
    return '[redacted]';
  });

  return {
    redactedText,
    redactedTermsFound: Array.from(found),
  };
}
