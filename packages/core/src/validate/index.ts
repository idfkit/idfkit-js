/**
 * Schema validation.
 *
 * Five names, matching the Python library's `idfkit.validation` one for one
 * under the field-casing rule. Everything else in this directory is an
 * implementation detail.
 */

export { validateDocument, validateObject } from './validate.js';
export { Severity } from './types.js';
export type { ValidationError, ValidationResult } from './types.js';
