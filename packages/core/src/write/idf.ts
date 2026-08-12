import type { FieldKind, SlimType } from '@idfkit/schemas';

import type { IDFDocument } from '../document.js';
import type { AnyTypeMap } from '../typemap.js';
import type { IdfObject, StoredValue } from '../object.js';

export interface WriteIdfOptions {
  /**
   * Emit `!- Field Name` comments after each field.
   * @default true
   */
  comments?: boolean;
  /**
   * Column the field-name comments are aligned to.
   * @default 30
   */
  commentColumn?: number;
  /**
   * Indent for field lines.
   * @default '    '
   */
  indent?: string;
  /**
   * Write `Version` first regardless of insertion order. EnergyPlus does not
   * require it, but every tool in the ecosystem expects it and diffs are
   * cleaner when it is stable.
   * @default true
   */
  versionFirst?: boolean;
}

/**
 * Serialize a document to IDF text.
 *
 * One caveat worth stating plainly: this does not round-trip formatting.
 * `3.0` in the input comes back as `3`, because JavaScript has a single number
 * type and the distinction is lost the moment the value is parsed. The models
 * are semantically identical and EnergyPlus reads both, but a textual diff of
 * input against output will show those fields. Preserving the original text
 * needs a concrete syntax tree, which the Python library has and this does not
 * yet.
 */
export function writeIdf<M extends AnyTypeMap>(
  document: IDFDocument<M>,
  options: WriteIdfOptions = {}
): string {
  const comments = options.comments ?? true;
  const commentColumn = options.commentColumn ?? 30;
  const indent = options.indent ?? '    ';
  const versionFirst = options.versionFirst ?? true;

  const parts: string[] = [];
  const types = document.types();

  if (versionFirst && types.includes('Version')) {
    types.splice(types.indexOf('Version'), 1);
    types.unshift('Version');
  }

  for (const typeName of types) {
    const collection = document.all(typeName);
    if (collection.size === 0) continue;
    for (const obj of collection) {
      parts.push(writeObject(obj, { comments, commentColumn, indent }));
    }
    parts.push('');
  }

  return parts.join('\n');
}

interface ObjectWriteOptions {
  comments: boolean;
  commentColumn: number;
  indent: string;
}

/** Serialize one object. */
export function writeObject(obj: IdfObject, options: ObjectWriteOptions): string {
  const definition = obj.schema;
  const cells: Array<{ value: string; label: string }> = [];

  if (obj.isNamed) {
    cells.push({ value: obj.name, label: 'Name' });
  }

  const extensible = definition.x;
  const groups = extensible === undefined ? [] : obj.extensible;

  const fixed = definition.f.filter((f) => f !== 'name');
  // Trailing empty fields are normally dropped, since EnergyPlus defaults them
  // and a run of bare commas is noise. But IDF is positional: if extensible
  // groups follow, every fixed slot must be emitted or the groups land one
  // field early and each value is read into the wrong slot on the way back in.
  const lastFixed = groups.length > 0 ? fixed.length - 1 : lastSetIndex(obj, fixed);
  for (let i = 0; i <= lastFixed; i += 1) {
    const field = fixed[i]!;
    cells.push({ value: formatValue(definition, field, obj.get(field)), label: humanize(field) });
  }

  if (extensible !== undefined) {
    for (const group of groups) {
      for (const field of extensible.fields) {
        cells.push({
          value: formatScalar(extensible.p[field]?.t, group[field]),
          label: humanize(field),
        });
      }
    }
  }

  const lines: string[] = [`${obj.typeName},`];
  if (cells.length === 0) {
    return `${obj.typeName};\n`;
  }

  cells.forEach((cell, index) => {
    const terminator = index === cells.length - 1 ? ';' : ',';
    const body = `${options.indent}${cell.value}${terminator}`;
    if (!options.comments) {
      lines.push(body);
      return;
    }
    const padding = ' '.repeat(Math.max(1, options.commentColumn - body.length));
    lines.push(`${body}${padding}!- ${cell.label}`);
  });

  return `${lines.join('\n')}\n`;
}

function lastSetIndex(obj: IdfObject, fields: readonly string[]): number {
  for (let i = fields.length - 1; i >= 0; i -= 1) {
    if (obj.get(fields[i]!) !== undefined) return i;
  }
  return -1;
}

function formatValue(definition: SlimType, field: string, value: StoredValue | undefined): string {
  return formatScalar(definition.p[field]?.t, value);
}

/**
 * Render one value as IDF text.
 *
 * The `kind === 'n'` branch is the fix for JavaScript having a single number
 * type: `3` and `3.0` are the same value at runtime, so without consulting the
 * schema every real-valued field would be written as a bare integer.
 */
function formatScalar(kind: FieldKind | undefined, value: StoredValue | undefined): string {
  if (value === undefined || Array.isArray(value)) return '';
  if (typeof value === 'string') return value;

  if (kind === 'i') return String(Math.trunc(value));
  if (Number.isInteger(value)) {
    return kind === 'n' ? `${value}.0` : String(value);
  }
  return String(value);
}

/**
 * Minor words EnergyPlus leaves lowercase in its own field comments, as in
 * `Direction of Relative North` and `Number of Timesteps per Hour`.
 */
const MINOR_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'per',
  'the',
  'to',
  'with',
]);

/**
 * `outside_boundary_condition` -> `Outside Boundary Condition`.
 *
 * The exact IDD field labels live in the schema's `field_info`, which the slim
 * bundle drops because it is documentation weight on the parse path. Deriving
 * the label from the epJSON key recovers it almost exactly; the comments are
 * cosmetic and EnergyPlus ignores them entirely.
 */
function humanize(field: string): string {
  return field
    .split('_')
    .map((word, index) => {
      if (word.length === 0) return word;
      if (index > 0 && MINOR_WORDS.has(word)) return word;
      return word[0]!.toUpperCase() + word.slice(1);
    })
    .join(' ');
}
