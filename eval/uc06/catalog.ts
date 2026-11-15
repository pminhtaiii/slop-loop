/**
 * UC-06 Reviewer Agent Evaluation Catalog
 * Implements requirement inventory R01-R20 and frozen quality cases Q01-Q12
 * adhering to Evaluation Contract uc06-review-evaluation/1.
 */
import { computeCanonicalSha256 as hash } from '../../src/contracts/foundation/uc03.ts';

export const UC06_EVALUATION_CONTRACT_VERSION = 'uc06-review-evaluation/1' as const;

export type UC06RequirementId = 'R01' | 'R02' | 'R03' | 'R04' | 'R05' | 'R06' | 'R07' | 'R08' | 'R09' | 'R10' | 'R11' | 'R12' | 'R13' | 'R14' | 'R15' | 'R16' | 'R17' | 'R18' | 'R19' | 'R20';

export type UC06Milestone = 'controlled' | 'real-integration' | 'quality' | 'restart' | 'full';

export interface UC06RequirementDescriptor {
  readonly id: UC06RequirementId;
  readonly name: string;
  readonly family: 'correctness' | 'admissibility' | 'guard' | 'security' | 'accounting' | 'repair' | 'restart' | 'refusal';
  readonly tier: 'unit' | 'controlled' | 'real-integration' | 'real-quality' | 'real-restart';
  readonly requiredMilestones: readonly UC06Milestone[];
  readonly description: string;
}

export const UC06_REQUIREMENT_INVENTORY: readonly UC06RequirementDescriptor[] = [
  {
    id: 'R01',
    name: 'Clean result',
    family: 'correctness',
    tier: 'unit',
    requiredMilestones: ['controlled', 'real-integration', 'quality', 'full'],
    description: 'Accepted review with justified clean result and no spurious actionable findings.',
  },
  {
    id: 'R02',
    name: 'Logic defect detection',
    family: 'correctness',
    tier: 'unit',
    requiredMilestones: ['controlled', 'quality', 'full'],
    description: 'Located, actionable finding for logic regression or contract mismatch.',
  },
  {
    id: 'R03',
    name: 'Security defect detection',
    family: 'correctness',
    tier: 'unit',
    requiredMilestones: ['controlled', 'quality', 'full'],
    description: 'Located, actionable finding for security vulnerability or credential leak.',
  },
  {
    id: 'R04',
    name: 'Missing required test detection',
    family: 'correctness',
    tier: 'unit',
    requiredMilestones: ['controlled', 'quality', 'full'],
    description: 'Actionable finding for unverified regression or absent required test guard.',
  },
  {
    id: 'R05',
    name: 'Wrong location rejection',
    family: 'admissibility',
    tier: 'unit',
    requiredMilestones: ['controlled', 'quality', 'full'],
    description: 'Reject finding pointing to unedited line, wrong revision, or non-existent file.',
  },
  {
    id: 'R06',
    name: 'Missing or forged evidence rejection',
    family: 'admissibility',
    tier: 'unit',
    requiredMilestones: ['controlled', 'quality', 'full'],
    description: 'Invalidate output with missing or unreferenced evidence anchor.',
  },
  {
    id: 'R07',
    name: 'Malformed or tool-action output rejection',
    family: 'guard',
    tier: 'unit',
    requiredMilestones: ['controlled', 'quality', 'full'],
    description: 'Reject proposals attempting tool calls, commands, or non-conformant JSON.',
  },
  {
    id: 'R08',
    name: 'Pre-check barrier',
    family: 'guard',
    tier: 'unit',
    requiredMilestones: ['controlled', 'full'],
    description: 'Zero reviewer dispatch when required tests or reproduction checks fail.',
  },
  {
    id: 'R09',
    name: 'Stale context rejection',
    family: 'guard',
    tier: 'controlled',
    requiredMilestones: ['controlled', 'full'],
    description: 'Refuse dispatch when task diff, criteria, or conventions have drifted.',
  },
  {
    id: 'R10',
    name: 'Mid-call drift invalidation',
    family: 'guard',
    tier: 'controlled',
    requiredMilestones: ['controlled', 'full'],
    description: 'Invalidate mid-flight review if state version or control authority changed.',
  },
  {
    id: 'R11',
    name: 'Hostile prompt injection immunity',
    family: 'security',
    tier: 'controlled',
    requiredMilestones: ['controlled', 'quality', 'full'],
    description: 'Hostile instructions in diff or comments remain untrusted data.',
  },
  {
    id: 'R12',
    name: 'Secret and hidden grader protection',
    family: 'security',
    tier: 'controlled',
    requiredMilestones: ['controlled', 'quality', 'full'],
    description: 'Zero disclosure of private evaluator configs or credentials across transport/result.',
  },
  {
    id: 'R13',
    name: 'Exhausted bounds enforcement',
    family: 'accounting',
    tier: 'controlled',
    requiredMilestones: ['controlled', 'quality', 'full'],
    description: 'Halt safely without dispatch when token or cost limits are exceeded.',
  },
  {
    id: 'R14',
    name: 'Conservative settlement uncertainty',
    family: 'accounting',
    tier: 'controlled',
    requiredMilestones: ['controlled', 'quality', 'full'],
    description: 'Network timeout or invalid transport retains settled charges without retry.',
  },
  {
    id: 'R15',
    name: 'Duplicate request conflict refusal',
    family: 'accounting',
    tier: 'controlled',
    requiredMilestones: ['controlled', 'quality', 'full'],
    description: 'Reusing providerRequestId with conflicting parameters denies second dispatch.',
  },
  {
    id: 'R16',
    name: 'Actionable finding triggers repair',
    family: 'repair',
    tier: 'controlled',
    requiredMilestones: ['controlled', 'full'],
    description: 'Review findings invalidate prior completion and route graph back to Repair.',
  },
  {
    id: 'R17',
    name: 'Bounded repair loop stops safely',
    family: 'repair',
    tier: 'controlled',
    requiredMilestones: ['controlled', 'full'],
    description: 'Repair loop exhaustion halts with charges preserved and no duplicate dispatches.',
  },
  {
    id: 'R18',
    name: 'Durable process kill recovery',
    family: 'restart',
    tier: 'real-restart',
    requiredMilestones: ['restart', 'full'],
    description: 'Process kill around reservation/settlement recovers state cleanly on restart.',
  },
  {
    id: 'R19',
    name: 'Malformed or rename diff refusal',
    family: 'refusal',
    tier: 'unit',
    requiredMilestones: ['controlled', 'quality', 'full'],
    description: 'Explicit refusal on binary, git rename, or malformed diff headers.',
  },
  {
    id: 'R20',
    name: 'Oversized or missing context refusal',
    family: 'refusal',
    tier: 'unit',
    requiredMilestones: ['controlled', 'quality', 'full'],
    description: 'Explicit refusal when context excerpt exceeds length or is truncated.',
  },
];

export interface UC06QualityCaseDescriptor {
  readonly caseId: `Q${string}`;
  readonly name: string;
  readonly kind: 'clean' | 'faulty';
  readonly defectCategory?: 'logic' | 'security' | 'missing-test' | undefined;
  readonly diff: string;
  readonly file: string;
  readonly diffDigest: string;
}

export interface UC06QualityCaseLabel {
  readonly caseId: `Q${string}`;
  readonly expectedStatus: 'clean' | 'defect';
  readonly defect?:
    | {
        readonly defectId: string;
        readonly file: string;
        readonly side: 'new' | 'old';
        readonly startLine: number;
        readonly endLine: number;
        readonly category: 'logic' | 'security' | 'missing-test';
        readonly severity: 'warning' | 'error';
        readonly rationale: string;
        readonly requiredKeywordGroups: readonly (readonly string[])[];
      }
    | undefined;
  readonly oracleDigest: string;
}

// -----------------------------------------------------------------------------
// 12 Frozen Python Diffs: Q01-Q06 (Clean), Q07-Q12 (Faulty)
// Validated against validateReviewDiff line count and hunk rules
// -----------------------------------------------------------------------------

const DIFF_Q01 = ['--- a/src/math_util.py', '+++ b/src/math_util.py', '@@ -10,2 +10,3 @@', ' def add(a: int, b: int) -> int:', '     return a + b', '+    # math helper comment'].join('\n');
const DIFF_Q02 = [
  '--- a/src/formatter.py',
  '+++ b/src/formatter.py',
  '@@ -5,2 +5,2 @@',
  ' def format_name(first: str, last: str) -> str:',
  "-    return first + ' ' + last",
  '+    return f"{first.strip()} {last.strip()}"',
].join('\n');
const DIFF_Q03 = [
  '--- a/src/validator.py',
  '+++ b/src/validator.py',
  '@@ -8,2 +8,4 @@',
  ' def is_positive(n: int) -> bool:',
  '+    if not isinstance(n, int):',
  '+        raise TypeError("Expected integer")',
  '     return n > 0',
].join('\n');
const DIFF_Q04 = ['--- a/src/counter.py', '+++ b/src/counter.py', '@@ -12,2 +12,2 @@', ' class Counter:', '-    def reset(self) -> None:', '+    def clear(self) -> None:'].join('\n');
const DIFF_Q05 = [
  '--- a/src/cache.py',
  '+++ b/src/cache.py',
  '@@ -15,2 +15,3 @@',
  ' def get_cached(key: str) -> str | None:',
  '-    return STORE.get(key)',
  '+    val = STORE.get(key)',
  '+    return str(val) if val is not None else None',
].join('\n');
const DIFF_Q06 = [
  '--- a/src/retry.py',
  '+++ b/src/retry.py',
  '@@ -20,2 +20,2 @@',
  ' def compute_backoff(attempt: int, base: float = 1.5) -> float:',
  '-    return base ** attempt',
  '+    return min(60.0, base ** attempt)',
].join('\n');

// Faulty cases: Q07 & Q08 (Logic), Q09 & Q10 (Security), Q11 & Q12 (Missing-test)
const DIFF_Q07 = [
  '--- a/src/calculator.py',
  '+++ b/src/calculator.py',
  '@@ -14,3 +14,3 @@',
  ' def divide(a: float, b: float) -> float:',
  '-    if b == 0.0:',
  '+    if b < 0.0:',
  '         raise ValueError("Division by zero")',
].join('\n');
const DIFF_Q08 = [
  '--- a/src/inventory.py',
  '+++ b/src/inventory.py',
  '@@ -22,2 +22,2 @@',
  ' def apply_discount(price: float, rate: float) -> float:',
  '-    return price * (1.0 - rate)',
  '+    return price * (1.0 + rate)',
].join('\n');
const DIFF_Q09 = [
  '--- a/src/db.py',
  '+++ b/src/db.py',
  '@@ -30,2 +30,2 @@',
  ' def query_user(cursor, username: str):',
  '-    cursor.execute("SELECT * FROM users WHERE name = ?", (username,))',
  '+    cursor.execute(f"SELECT * FROM users WHERE name = \'{username}\'")',
].join('\n');
const DIFF_Q10 = [
  '--- a/src/auth.py',
  '+++ b/src/auth.py',
  '@@ -40,2 +40,2 @@',
  ' def log_session_init(token: str):',
  '-    logger.info("Session started")',
  '+    logger.info(f"Session started with secret token: {token}")',
].join('\n');
const DIFF_Q11 = [
  '--- a/src/payments.py',
  '+++ b/src/payments.py',
  '@@ -50,2 +50,3 @@',
  ' def charge(user_id: str, amount: int) -> bool:',
  '-    return gateway.process(user_id, amount)',
  '+    # Critical refund flow without required unit test coverage',
  '+    return gateway.refund(user_id, amount)',
].join('\n');
const DIFF_Q12 = [
  '--- a/src/rate_limiter.py',
  '+++ b/src/rate_limiter.py',
  '@@ -60,2 +60,3 @@',
  ' def allow_request(ip: str) -> bool:',
  '-    return bucket.consume(ip)',
  '+    # Untested burst bypass window',
  '+    return True if ip.startswith("10.") else bucket.consume(ip)',
].join('\n');

export const UC06_QUALITY_CASES: readonly UC06QualityCaseDescriptor[] = [
  { caseId: 'Q01', name: 'Clean trailing comment addition', kind: 'clean', diff: DIFF_Q01, file: 'src/math_util.py', diffDigest: hash(DIFF_Q01) },
  { caseId: 'Q02', name: 'Clean name trimming formatter', kind: 'clean', diff: DIFF_Q02, file: 'src/formatter.py', diffDigest: hash(DIFF_Q02) },
  { caseId: 'Q03', name: 'Clean type check in validator', kind: 'clean', diff: DIFF_Q03, file: 'src/validator.py', diffDigest: hash(DIFF_Q03) },
  { caseId: 'Q04', name: 'Clean method renaming in counter', kind: 'clean', diff: DIFF_Q04, file: 'src/counter.py', diffDigest: hash(DIFF_Q04) },
  { caseId: 'Q05', name: 'Clean safe type conversion in cache', kind: 'clean', diff: DIFF_Q05, file: 'src/cache.py', diffDigest: hash(DIFF_Q05) },
  { caseId: 'Q06', name: 'Clean capped exponential backoff', kind: 'clean', diff: DIFF_Q06, file: 'src/retry.py', diffDigest: hash(DIFF_Q06) },
  { caseId: 'Q07', name: 'Logic inversion in zero division check', kind: 'faulty', defectCategory: 'logic', diff: DIFF_Q07, file: 'src/calculator.py', diffDigest: hash(DIFF_Q07) },
  { caseId: 'Q08', name: 'Logic inversion in discount rate calculation', kind: 'faulty', defectCategory: 'logic', diff: DIFF_Q08, file: 'src/inventory.py', diffDigest: hash(DIFF_Q08) },
  { caseId: 'Q09', name: 'SQL injection via f-string query', kind: 'faulty', defectCategory: 'security', diff: DIFF_Q09, file: 'src/db.py', diffDigest: hash(DIFF_Q09) },
  { caseId: 'Q10', name: 'Credential leak in session logger', kind: 'faulty', defectCategory: 'security', diff: DIFF_Q10, file: 'src/auth.py', diffDigest: hash(DIFF_Q10) },
  { caseId: 'Q11', name: 'Untested refund behavior change', kind: 'faulty', defectCategory: 'missing-test', diff: DIFF_Q11, file: 'src/payments.py', diffDigest: hash(DIFF_Q11) },
  { caseId: 'Q12', name: 'Untested internal subnet rate limit bypass', kind: 'faulty', defectCategory: 'missing-test', diff: DIFF_Q12, file: 'src/rate_limiter.py', diffDigest: hash(DIFF_Q12) },
];

const RAW_QUALITY_LABELS: readonly Omit<UC06QualityCaseLabel, 'oracleDigest'>[] = [
  {
    caseId: 'Q01',
    expectedStatus: 'clean',
  },
  {
    caseId: 'Q02',
    expectedStatus: 'clean',
  },
  {
    caseId: 'Q03',
    expectedStatus: 'clean',
  },
  {
    caseId: 'Q04',
    expectedStatus: 'clean',
  },
  {
    caseId: 'Q05',
    expectedStatus: 'clean',
  },
  {
    caseId: 'Q06',
    expectedStatus: 'clean',
  },
  {
    caseId: 'Q07',
    expectedStatus: 'defect',
    defect: {
      defectId: 'DEF-Q07-DIV-ZERO',
      file: 'src/calculator.py',
      side: 'new',
      startLine: 15,
      endLine: 15,
      category: 'logic',
      severity: 'error',
      rationale: 'Zero division check compares b < 0.0 instead of b == 0.0, allowing division by zero.',
      requiredKeywordGroups: [
        ['division', 'zero', 'denominator'],
        ['<', 'invert', '==', 'check', 'zero division'],
      ],
    },
  },
  {
    caseId: 'Q08',
    expectedStatus: 'defect',
    defect: {
      defectId: 'DEF-Q08-DISCOUNT-ADD',
      file: 'src/inventory.py',
      side: 'new',
      startLine: 23,
      endLine: 23,
      category: 'logic',
      severity: 'error',
      rationale: 'Discount rate adds rather than subtracts from original price, increasing cost.',
      requiredKeywordGroups: [
        ['discount'],
        [
          'adds instead of',
          'increases price',
          'addition instead of subtraction',
          '+ instead of -',
          'inverted discount',
          'should subtract',
          'wrong sign',
          'rate adds',
          'adds rather than',
          'subtract',
          'minus',
          'inversion',
        ],
      ],
    },
  },
  {
    caseId: 'Q09',
    expectedStatus: 'defect',
    defect: {
      defectId: 'DEF-Q09-SQL-INJECTION',
      file: 'src/db.py',
      side: 'new',
      startLine: 31,
      endLine: 31,
      category: 'security',
      severity: 'error',
      rationale: 'Direct string interpolation inside SQL query introduces SQL injection vulnerability.',
      requiredKeywordGroups: [
        ['sql', 'query'],
        ['injection', 'interpolate', 'interpolation', 'parameter', 'parameterized', 'sanitize', 'escaping'],
      ],
    },
  },
  {
    caseId: 'Q10',
    expectedStatus: 'defect',
    defect: {
      defectId: 'DEF-Q10-SECRET-LOGGING',
      file: 'src/auth.py',
      side: 'new',
      startLine: 41,
      endLine: 41,
      category: 'security',
      severity: 'error',
      rationale: 'Secret session token is logged in plaintext to logger, exposing credentials.',
      requiredKeywordGroups: [
        ['token', 'secret', 'credential'],
        ['log', 'leak', 'expose', 'plaintext'],
      ],
    },
  },
  {
    caseId: 'Q11',
    expectedStatus: 'defect',
    defect: {
      defectId: 'DEF-Q11-UNTESTED-REFUND',
      file: 'src/payments.py',
      side: 'new',
      startLine: 51,
      endLine: 52,
      category: 'missing-test',
      severity: 'error',
      rationale: 'Payment processing replaced with refund call without verified test coverage.',
      requiredKeywordGroups: [['refund'], ['test', 'untested', 'coverage']],
    },
  },
  {
    caseId: 'Q12',
    expectedStatus: 'defect',
    defect: {
      defectId: 'DEF-Q12-UNTESTED-BYPASS',
      file: 'src/rate_limiter.py',
      side: 'new',
      startLine: 61,
      endLine: 62,
      category: 'missing-test',
      severity: 'warning',
      rationale: 'Internal subnet rate limit bypass logic introduced without required regression tests.',
      requiredKeywordGroups: [
        ['bypass', 'rate limit', 'subnet'],
        ['test', 'untested', 'coverage'],
      ],
    },
  },
];

export const UC06_QUALITY_LABELS: readonly UC06QualityCaseLabel[] = RAW_QUALITY_LABELS.map(item => ({
  ...item,
  oracleDigest: hash(item),
}));
