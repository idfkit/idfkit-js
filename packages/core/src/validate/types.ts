/**
 * The vocabulary validation reports in.
 *
 * A finding is a record, not a throw. The Python original names the type
 * `ValidationError` and this port keeps that spelling, but nothing here is ever
 * raised: a finding carries a severity and a location, and callers collect them
 * into a `ValidationResult` and decide what to do. Naming it after an exception
 * and then returning it is the one thing the naming register asks both
 * libraries to keep in step, so the name stays.
 */

/**
 * Severity of a validation finding.
 *
 * Both a value and a type. The value gives the Python original's
 * `Severity.ERROR` spelling; the type is the string union that a `'error'`
 * literal satisfies, which is how the same three strings reach the wire in both
 * languages. The strings themselves are load-bearing: the conformance corpus
 * compares them across the two implementations.
 */
export const Severity = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
} as const);

export type Severity = (typeof Severity)[keyof typeof Severity];

/**
 * One validation finding.
 *
 * `code` is the machine-readable part and is shared with the Python library
 * verbatim (`E001`…`E010`, `W002`, `W003`). `message` is for a human and is
 * *not* guaranteed identical across the two languages: number formatting and
 * type names differ between the runtimes. Match on `code`.
 */
export interface ValidationError {
  /** How serious the finding is. */
  readonly severity: Severity;
  /** Object type the finding was found on. */
  readonly objType: string;
  /** Object name the finding was found on. Empty for anonymous objects. */
  readonly objName: string;
  /** Field the finding concerns, or `undefined` when it concerns the object. */
  readonly field: string | undefined;
  /** Human-readable description. */
  readonly message: string;
  /** Machine-readable code, stable across languages. */
  readonly code: string;
}

/**
 * Everything one validation run found, split by severity.
 *
 * `isValid` and `totalIssues` are computed once when the result is built rather
 * than being live properties, because the arrays are read-only.
 */
export interface ValidationResult {
  readonly errors: readonly ValidationError[];
  readonly warnings: readonly ValidationError[];
  readonly info: readonly ValidationError[];
  /** True when `errors` is empty. Warnings and info do not make a model invalid. */
  readonly isValid: boolean;
  /** `errors + warnings + info`. */
  readonly totalIssues: number;
}
