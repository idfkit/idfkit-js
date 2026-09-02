#!/usr/bin/env node
/**
 * The naming gate for idfkit-js.
 *
 * Counterpart of `idfkit/scripts/check_naming_register.py`. Both read one file,
 * `governance/naming.toml` in the idfkit-conformance repository, at the pinned
 * `governance-YYYY.N` tag named by `idfkit.governance` in
 * `packages/core/package.json`, and hold their own library's public surface
 * against it.
 *
 * WHAT IT READS
 *
 *   The register:  git show <governance tag>:governance/naming.toml
 *   The surface:   the built `.d.ts` files each package's `exports` map points
 *                  at, plus the TypeDoc JSON `npm run docs:api` already
 *                  produces for the reference artifact.
 *
 * Neither input is a new parser over the sources. The `.d.ts` files say which
 * names an importer can actually reach, and the TypeDoc JSON says what kind
 * each name is and which file it came from, which is what a failure has to
 * report. Where they disagree, the union is the public surface and the report
 * says which input a name came from: a name in the `.d.ts` but not in TypeDoc
 * is importable and undocumented, which is a finding rather than a wash.
 *
 * WHY IT REFUSES TO RUN UNPINNED (FR-081, FR-084)
 *
 * Reading the register from the corpus repository's default branch would let
 * that repository turn this one's checks red with no review on this side. The
 * gate therefore reads a tag, never a branch, and stops rather than falling
 * back when the pin is missing, malformed, or names a tag that does not exist.
 * `--register <path>` exists for developing against an unpublished register and
 * announces itself in the output every time it is used; it does not lift the
 * requirement that a pin be declared.
 *
 * EXIT CODES
 *
 *   0  every public name in scope resolves to a register entry
 *   1  at least one contract failure, listed above the summary
 *   2  the gate could not run: no pin, a malformed pin, no register at the
 *      pinned tag, or no TypeDoc JSON. Distinct from 1 on purpose, so CI can
 *      tell "this change is wrong" from "this check never happened".
 *
 * Usage: node scripts/check-naming-register.mjs --help
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/** The package whose `idfkit.governance` field carries the pin. */
const PIN_PACKAGE = join(REPO, 'packages', 'core', 'package.json');
/** Where `npm run docs:api` writes its JSON. */
const DEFAULT_TYPEDOC = join(REPO, '.typedoc.json');
/** The register's path inside the corpus repository. */
const REGISTER_PATH = 'governance/naming.toml';
/** A governance tag, and nothing else, is a legal pin. */
const GOVERNANCE_TAG = /^governance-\d{4}\.\d+$/;

const USAGE = `
Check the idfkit-js public surface against the naming register.

  node scripts/check-naming-register.mjs [options]

Options
  --corpus <path>     An idfkit-conformance checkout to read the register from.
                      Default: $IDFKIT_CONFORMANCE_DIR, then ./conformance, then
                      ../idfkit-conformance.
  --register <path>   Read a naming.toml from this path instead of from the
                      pinned tag. DEVELOPMENT ONLY. Announced on every run, and
                      a pin must still be declared.
  --typedoc <path>    TypeDoc JSON to read. Default: .typedoc.json
  --build             Run "npx tsc --build" and "npm run docs:api" first, so the
                      .d.ts files and the TypeDoc JSON match the sources.
  --all-packages      Check every workspace package, not only the ones the
                      register's [register] governs list names.
  --json              Emit machine-readable findings on stdout.
  -h, --help          This text.

Prerequisites
  The gate reads built output. Without --build, run these first:

      npx tsc --build
      npm run docs:api

Scope
  By default the gate checks the packages the register says it governs. Names in
  other workspace packages are counted and reported, never failed, and a
  register entry whose only home is one of those packages is reported as a gap
  in the governs list rather than silently widening the scope. --all-packages
  checks them all.

  Coverage is checked over the names an entry point exports at the top level. A
  method or property on an exported class is out of that reach: the register
  names several of those (SchemaBundle.load, StationIndex.search) and each is
  covered by its exported head. The excluded-surface check has the same reach,
  so a counterpart that lands as a method rather than an export is caught by
  review, not here.
`.trimStart();

// ---------------------------------------------------------------------------
// A very small TOML reader
// ---------------------------------------------------------------------------
//
// Node has no TOML parser and this gate takes no dependencies, so this reads
// the subset naming.toml is written in: comments, tables, dotted table headers,
// arrays of tables, basic and literal strings including the triple-quoted
// forms, integers, floats, booleans, arrays, and inline tables. Anything else,
// dates above all, throws with a line number rather than being guessed at. The
// register is a governed file; a construct this cannot read is a change to the
// register that should be noticed here.

class TomlError extends Error {}

class Cursor {
  constructor(text, label) {
    this.text = text;
    this.i = 0;
    this.label = label;
  }

  get done() {
    return this.i >= this.text.length;
  }

  peek(offset = 0) {
    return this.text[this.i + offset];
  }

  starts(literal) {
    return this.text.startsWith(literal, this.i);
  }

  fail(message) {
    const line = this.text.slice(0, this.i).split('\n').length;
    throw new TomlError(`${this.label}:${line}: ${message}`);
  }
}

/** Whitespace and comments, staying on the current line. */
function skipInline(cursor) {
  for (;;) {
    const char = cursor.peek();
    if (char === ' ' || char === '\t' || char === '\r') {
      cursor.i += 1;
    } else if (char === '#') {
      while (!cursor.done && cursor.peek() !== '\n') cursor.i += 1;
    } else {
      return;
    }
  }
}

/** Whitespace, comments and newlines. */
function skipBlank(cursor) {
  for (;;) {
    const before = cursor.i;
    skipInline(cursor);
    while (cursor.peek() === '\n') cursor.i += 1;
    if (cursor.i === before) return;
  }
}

function readBareKey(cursor) {
  const start = cursor.i;
  while (!cursor.done && /[A-Za-z0-9_-]/.test(cursor.peek())) cursor.i += 1;
  if (cursor.i === start) cursor.fail('expected a key');
  return cursor.text.slice(start, cursor.i);
}

/** A key, bare or quoted, possibly dotted: `a.b."c"`. */
function readKeyPath(cursor) {
  const path = [];
  for (;;) {
    skipInline(cursor);
    path.push(
      cursor.peek() === '"' || cursor.peek() === "'" ? readString(cursor) : readBareKey(cursor)
    );
    skipInline(cursor);
    if (cursor.peek() !== '.') return path;
    cursor.i += 1;
  }
}

const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

function readEscape(cursor) {
  cursor.i += 1; // the backslash
  const char = cursor.peek();
  if (char in ESCAPES) {
    cursor.i += 1;
    return ESCAPES[char];
  }
  if (char === 'u' || char === 'U') {
    const width = char === 'u' ? 4 : 8;
    const hex = cursor.text.slice(cursor.i + 1, cursor.i + 1 + width);
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) cursor.fail('bad unicode escape');
    cursor.i += 1 + width;
    return String.fromCodePoint(Number.parseInt(hex, 16));
  }
  if (char === '\n' || char === '\r' || char === ' ' || char === '\t') {
    // Line-ending backslash: swallow the newline and the indent after it.
    while (!cursor.done && /[ \t\r\n]/.test(cursor.peek())) cursor.i += 1;
    return '';
  }
  return cursor.fail(`unknown escape \\${char}`);
}

function readString(cursor) {
  if (cursor.starts('"""')) {
    cursor.i += 3;
    if (cursor.peek() === '\n') cursor.i += 1;
    else if (cursor.starts('\r\n')) cursor.i += 2;
    let out = '';
    while (!cursor.starts('"""')) {
      if (cursor.done) cursor.fail('unterminated multi-line string');
      out += cursor.peek() === '\\' ? readEscape(cursor) : cursor.text[cursor.i++];
    }
    cursor.i += 3;
    return out;
  }
  if (cursor.starts("'''")) {
    cursor.i += 3;
    if (cursor.peek() === '\n') cursor.i += 1;
    const end = cursor.text.indexOf("'''", cursor.i);
    if (end === -1) cursor.fail('unterminated multi-line literal string');
    const out = cursor.text.slice(cursor.i, end);
    cursor.i = end + 3;
    return out;
  }
  if (cursor.peek() === '"') {
    cursor.i += 1;
    let out = '';
    while (cursor.peek() !== '"') {
      if (cursor.done || cursor.peek() === '\n') cursor.fail('unterminated string');
      out += cursor.peek() === '\\' ? readEscape(cursor) : cursor.text[cursor.i++];
    }
    cursor.i += 1;
    return out;
  }
  if (cursor.peek() === "'") {
    cursor.i += 1;
    const end = cursor.text.indexOf("'", cursor.i);
    if (end === -1) cursor.fail('unterminated literal string');
    const out = cursor.text.slice(cursor.i, end);
    cursor.i = end + 1;
    return out;
  }
  return cursor.fail('expected a string');
}

function readValue(cursor) {
  skipInline(cursor);
  const char = cursor.peek();
  if (char === '"' || char === "'") return readString(cursor);
  if (char === '[') {
    cursor.i += 1;
    const items = [];
    for (;;) {
      skipBlank(cursor);
      if (cursor.peek() === ']') {
        cursor.i += 1;
        return items;
      }
      items.push(readValue(cursor));
      skipBlank(cursor);
      if (cursor.peek() === ',') cursor.i += 1;
      else if (cursor.peek() !== ']') cursor.fail('expected , or ] in an array');
    }
  }
  if (char === '{') {
    cursor.i += 1;
    const table = {};
    for (;;) {
      skipBlank(cursor);
      if (cursor.peek() === '}') {
        cursor.i += 1;
        return table;
      }
      const path = readKeyPath(cursor);
      skipInline(cursor);
      if (cursor.peek() !== '=') cursor.fail('expected = in an inline table');
      cursor.i += 1;
      assign(cursor, table, path, readValue(cursor));
      skipBlank(cursor);
      if (cursor.peek() === ',') cursor.i += 1;
      else if (cursor.peek() !== '}') cursor.fail('expected , or } in an inline table');
    }
  }
  if (cursor.starts('true')) {
    cursor.i += 4;
    return true;
  }
  if (cursor.starts('false')) {
    cursor.i += 5;
    return false;
  }
  const start = cursor.i;
  while (!cursor.done && /[0-9+\-_.eE]/.test(cursor.peek())) cursor.i += 1;
  const raw = cursor.text.slice(start, cursor.i);
  if (raw === '') cursor.fail(`cannot read a value at ${JSON.stringify(cursor.peek() ?? '<eof>')}`);
  const number = Number(raw.replaceAll('_', ''));
  if (Number.isNaN(number)) cursor.fail(`cannot read ${JSON.stringify(raw)} as a number`);
  return number;
}

function assign(cursor, table, path, value) {
  let node = table;
  for (const key of path.slice(0, -1)) {
    node[key] ??= {};
    node = node[key];
  }
  const last = path.at(-1);
  if (last in node) cursor.fail(`duplicate key ${path.join('.')}`);
  node[last] = value;
}

function descend(cursor, root, path, { arrayOfTables }) {
  let node = root;
  for (const key of path.slice(0, -1)) {
    node[key] ??= {};
    node = Array.isArray(node[key]) ? node[key].at(-1) : node[key];
  }
  const last = path.at(-1);
  if (arrayOfTables) {
    node[last] ??= [];
    if (!Array.isArray(node[last])) cursor.fail(`${path.join('.')} is not an array of tables`);
    const fresh = {};
    node[last].push(fresh);
    return fresh;
  }
  node[last] ??= {};
  return node[last];
}

/** Read the subset of TOML the naming register is written in. */
export function parseToml(text, label = 'naming.toml') {
  const cursor = new Cursor(text, label);
  const root = {};
  let table = root;
  for (;;) {
    skipBlank(cursor);
    if (cursor.done) return root;
    if (cursor.starts('[[')) {
      cursor.i += 2;
      const path = readKeyPath(cursor);
      skipInline(cursor);
      if (!cursor.starts(']]')) cursor.fail('expected ]]');
      cursor.i += 2;
      table = descend(cursor, root, path, { arrayOfTables: true });
    } else if (cursor.peek() === '[') {
      cursor.i += 1;
      const path = readKeyPath(cursor);
      skipInline(cursor);
      if (cursor.peek() !== ']') cursor.fail('expected ]');
      cursor.i += 1;
      table = descend(cursor, root, path, { arrayOfTables: false });
    } else {
      const path = readKeyPath(cursor);
      skipInline(cursor);
      if (cursor.peek() !== '=') cursor.fail('expected = after a key');
      cursor.i += 1;
      assign(cursor, table, path, readValue(cursor));
    }
    skipInline(cursor);
    if (!cursor.done && cursor.peek() !== '\n') cursor.fail('unexpected trailing text');
  }
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const KINDS = new Set(['aligned', 'divergent', 'excluded']);

/**
 * The names a register field mentions.
 *
 * A `python` or `typescript` field is usually one identifier, but the register
 * also spells a concept as a member (`SchemaBundle.load`), a construction
 * (`new IdfDocument(schema)`), a call (`doc.all('Zone')`), a module
 * (`@idfkit/core/types`), or a comma-separated list of every name in an
 * excluded surface. This reduces any of those to the identifiers it mentions.
 *
 * Reading every dotted segment rather than only the head is deliberate: the
 * head of `SchemaBundle.load` is the export, and the head of `col.get(name)` is
 * a receiver placeholder whose member is the name being registered. Taking both
 * covers each case without the register having to say which shape it used.
 * Arguments are dropped at the opening parenthesis so that a placeholder like
 * `schema` or a literal like `'Zone'` never counts as a registered name.
 */
class RegisteredNames {
  /** @param {string} field */
  constructor(field) {
    /** Each comma-separated item, as written. */
    this.items = [];
    /** Identifiers any item mentions. */
    this.tokens = new Set();
    /** Items that name a module or package path rather than an identifier. */
    this.modulePaths = [];

    for (const raw of String(field ?? '').split(',')) {
      const item = raw.trim();
      if (item === '') continue;
      this.items.push(item);

      let head = item.replace(/^new\s+/, '');
      const cut = head.search(/[(<[]/);
      if (cut !== -1) head = head.slice(0, cut);
      head = head.trim();

      if (head.includes('/') || head.startsWith('@')) this.modulePaths.push(head);
      for (const segment of head.split(/[./@]/)) {
        if (IDENTIFIER.test(segment)) this.tokens.add(segment);
      }
    }
  }

  get isAbsent() {
    return this.items.length === 0;
  }

  toString() {
    return this.items.join(', ');
  }
}

/** One `[[entry]]` of the register, read into a shape the checks can rely on. */
class RegisterEntry {
  /** @param {Record<string, unknown>} raw @param {number} index */
  constructor(raw, index) {
    this.index = index;
    this.concept = typeof raw.concept === 'string' ? raw.concept : '';
    this.kind = typeof raw.kind === 'string' ? raw.kind : '';
    this.divergenceReason = typeof raw.divergence_reason === 'string' ? raw.divergence_reason : '';
    this.canonicalForm = typeof raw.canonical_form === 'string' ? raw.canonical_form : '';
    this.notes = typeof raw.notes === 'string' ? raw.notes : '';
    this.python = new RegisteredNames(raw.python);
    this.typescript = new RegisteredNames(raw.typescript);

    const counts = raw.rename_count;
    const table =
      counts !== null && typeof counts === 'object' && !Array.isArray(counts) ? counts : null;
    this.hasRenameCount = table !== null;
    this.renamePython = typeof table?.python === 'number' ? table.python : null;
    this.renameTypescript = typeof table?.typescript === 'number' ? table.typescript : null;
  }

  /** The label a failure message uses for this entry. */
  get label() {
    return `"${this.concept}"`;
  }
}

class Register {
  /** @param {Record<string, unknown>} root @param {string} origin */
  constructor(root, origin) {
    this.origin = origin;
    this.governs = Array.isArray(root.register?.governs)
      ? root.register.governs.filter((name) => typeof name === 'string')
      : [];
    this.schemaVersion = root.register?.schema_version ?? null;
    this.entries = (Array.isArray(root.entry) ? root.entry : []).map(
      (raw, index) => new RegisterEntry(raw, index)
    );
  }

  /** Every identifier the TypeScript side of the register mentions. */
  typescriptTokens() {
    const byToken = new Map();
    for (const entry of this.entries) {
      for (const token of entry.typescript.tokens) {
        if (!byToken.has(token)) byToken.set(token, []);
        byToken.get(token).push(entry);
      }
    }
    return byToken;
  }

  /** Module paths the register names, longest first so the most specific wins. */
  typescriptModulePaths() {
    const paths = [];
    for (const entry of this.entries) {
      for (const path of entry.typescript.modulePaths) paths.push({ path, entry });
    }
    return paths.sort((a, b) => b.path.length - a.path.length);
  }
}

// ---------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------

/** One name an entry point exports. */
class PublicName {
  constructor({ name, packageName, specifier, file, kind, sources }) {
    this.name = name;
    this.packageName = packageName;
    this.specifier = specifier;
    this.file = file;
    this.kind = kind;
    /** Which inputs saw this name: 'd.ts', 'typedoc', or both. */
    this.sources = new Set(sources);
  }

  get where() {
    return `${this.specifier} (${this.file})`;
  }
}

/** One entry of a package's `exports` map, resolved to a built declaration file. */
class EntryPoint {
  constructor({ packageName, specifier, declarationFile, typedocName }) {
    this.packageName = packageName;
    this.specifier = specifier;
    this.declarationFile = declarationFile;
    this.typedocName = typedocName;
  }
}

/**
 * Names a built `.d.ts` re-exports or declares.
 *
 * Regexes rather than a TypeScript parse, because a declaration file is already
 * the flattened form: every public name appears in an `export` clause at the
 * top level, and this side of the input exists to catch what TypeDoc leaves
 * out, not to re-derive the whole surface.
 */
function namesInDeclarationFile(file) {
  const text = readFileSync(file, 'utf8');
  const names = new Set();
  let starExport = false;

  for (const match of text.matchAll(/^export\s+(?:type\s+)?\{([\s\S]*?)\}/gm)) {
    for (const clause of match[1].split(',')) {
      const parts = clause
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/);
      const name = (parts.at(-1) ?? '').trim();
      if (IDENTIFIER.test(name) && name !== 'default') names.add(name);
    }
  }
  const declared =
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|var|enum|namespace|interface|type)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of text.matchAll(declared)) names.add(match[1]);
  if (/^export\s+\*/m.test(text)) starExport = true;

  return { names, starExport };
}

/** Expand a single `*` in an exports target against the built tree. */
function expandTarget(packageDir, target) {
  const relativeTarget = target.replace(/^\.\//, '');
  if (!relativeTarget.includes('*')) {
    const file = join(packageDir, relativeTarget);
    return existsSync(file) ? [{ file, star: null }] : [];
  }
  const [before, after] = relativeTarget.split('*');
  const slash = before.lastIndexOf('/');
  const dir = join(packageDir, slash === -1 ? '.' : before.slice(0, slash));
  if (!existsSync(dir)) return [];
  const prefix = slash === -1 ? before : before.slice(slash + 1);
  const found = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(after)) continue;
    const star = name.slice(prefix.length, name.length - after.length);
    if (star === '') continue;
    found.push({ file: join(dir, name), star });
  }
  return found;
}

/** Resolve every entry point of every workspace package to its built `.d.ts`. */
function readEntryPoints(packageDirs) {
  const entryPoints = [];
  const missing = [];
  for (const packageDir of packageDirs) {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const exportsMap = manifest.exports ?? {};
    for (const [subpath, value] of Object.entries(exportsMap)) {
      const target = typeof value === 'string' ? value : (value?.types ?? value?.default);
      if (typeof target !== 'string' || !target.endsWith('.d.ts')) continue;
      const suffix = subpath === '.' ? '' : subpath.replace(/^\./, '');
      const expanded = expandTarget(packageDir, target);
      if (expanded.length === 0) {
        missing.push(`${manifest.name}${suffix} -> ${target}`);
        continue;
      }
      for (const { file, star } of expanded) {
        const specifier = `${manifest.name}${suffix}`.replace('*', star ?? '*');
        entryPoints.push(
          new EntryPoint({
            packageName: manifest.name,
            specifier,
            declarationFile: file,
            typedocName: basename(file).replace(/\.d\.ts$/, ''),
          })
        );
      }
    }
  }
  return { entryPoints, missing };
}

const TYPEDOC_KINDS = {
  2: 'module',
  4: 'namespace',
  8: 'enum',
  32: 'variable',
  64: 'function',
  128: 'class',
  256: 'interface',
  2097152: 'type',
  4194304: 'reference',
};

/** Read the TypeDoc JSON into `package -> entry point -> declarations`. */
function readTypedoc(file) {
  const project = JSON.parse(readFileSync(file, 'utf8'));
  const byPackage = new Map();
  for (const pkg of project.children ?? []) {
    const modules = new Map();
    for (const module of pkg.children ?? []) {
      const declarations = (module.children ?? []).map((child) => ({
        name: child.name,
        kind: TYPEDOC_KINDS[child.kind] ?? String(child.kind),
        file: child.sources?.[0]?.fileName ?? null,
      }));
      modules.set(module.name, declarations);
    }
    byPackage.set(pkg.name, modules);
  }
  return byPackage;
}

/** Merge the two inputs into one surface, keyed by entry point and name. */
function readSurface(entryPoints, typedoc) {
  /** @type {PublicName[]} */
  const names = [];
  const starExports = [];
  const undocumented = [];
  for (const entryPoint of entryPoints) {
    const { names: declared, starExport } = namesInDeclarationFile(entryPoint.declarationFile);
    if (starExport) starExports.push(entryPoint.specifier);

    const documented = typedoc.get(entryPoint.packageName)?.get(entryPoint.typedocName) ?? [];
    if (documented.length === 0 && declared.size > 0) undocumented.push(entryPoint.specifier);
    const byName = new Map(documented.map((entry) => [entry.name, entry]));

    for (const name of new Set([...declared, ...byName.keys()])) {
      const entry = byName.get(name);
      const seenIn = [];
      if (declared.has(name)) seenIn.push('d.ts');
      if (entry !== undefined) seenIn.push('typedoc');
      names.push(
        new PublicName({
          name,
          packageName: entryPoint.packageName,
          specifier: entryPoint.specifier,
          file: entry?.file ?? relative(REPO, entryPoint.declarationFile),
          kind: entry?.kind ?? 'unknown',
          sources: seenIn,
        })
      );
    }
  }
  return { names, starExports, undocumented };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** One thing the gate has to say. `fail` decides the exit code. */
class Finding {
  constructor({ check, requirement, fail, message, detail = null, side = null }) {
    this.check = check;
    this.requirement = requirement;
    this.fail = fail;
    this.message = message;
    this.detail = detail;
    /** Which side is behind the pinned register, where that is the point. */
    this.side = side;
  }
}

/** snake_case, kebab-case, or an already-camel name, as TypeScript would spell it. */
function camelCase(name) {
  return name.replace(/[-_]+([A-Za-z0-9])/g, (_, char) => char.toUpperCase()).replace(/[-_]+$/, '');
}

/** What a TypeScript counterpart of a Python name would plausibly be called. */
function counterpartCandidates(names) {
  const candidates = new Map();
  for (const item of names.items) {
    const head = item
      .replace(/^new\s+/, '')
      .split(/[(<[]/)[0]
      .trim();
    const last = head.split('.').at(-1) ?? '';
    if (!IDENTIFIER.test(last)) continue;
    candidates.set(last, item);
    const camel = camelCase(last);
    if (IDENTIFIER.test(camel)) candidates.set(camel, item);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * Every public name resolves to an entry (FR-003, FR-008).
 *
 * An uncovered name is one of two things and the message says both: a name the
 * register has not been amended to carry yet, in which case the register is
 * behind and the entry lands first at a new governance tag; or an assembly
 * artefact that was never meant to be public, in which case it is deleted
 * rather than registered (FR-008). The gate cannot tell them apart, and the
 * naming register is explicit that it should not try.
 */
function checkCoverage(register, inScope, moduleCovered) {
  const byToken = register.typescriptTokens();
  const findings = [];
  const uncovered = [];
  let covered = 0;
  let inModules = 0;

  for (const name of inScope) {
    // An entry point the register covers as a module is covered whole. Its
    // members are machine-written from the EnergyPlus schema rather than chosen,
    // so enumerating them here would be counting the schema, not the surface.
    if (moduleCovered.has(name.specifier)) {
      inModules += 1;
      continue;
    }
    if (byToken.has(name.name)) {
      covered += 1;
      continue;
    }
    uncovered.push(name);
  }

  for (const name of uncovered) {
    findings.push(
      new Finding({
        check: 'coverage',
        requirement: 'FR-003, FR-008',
        fail: true,
        side: 'register',
        message: `${name.name} is public in ${name.packageName} and the pinned register does not cover it`,
        detail: `exported from ${name.where}, ${name.kind}, seen in ${[...name.sources].join(' and ')}`,
      })
    );
  }
  return { findings, covered, uncovered, inModules };
}

/** One public name per concept per language (FR-005). */
function checkOneNamePerConcept(register) {
  const findings = [];
  for (const entry of register.entries) {
    // An excluded entry lists a whole surface on purpose. That is the point of
    // writing the names out rather than describing a category, so the count
    // rule does not apply to it.
    if (entry.kind === 'excluded') continue;
    if (entry.typescript.items.length > 1) {
      findings.push(
        new Finding({
          check: 'one-name-per-concept',
          requirement: 'FR-005',
          fail: true,
          message: `${entry.label} has ${entry.typescript.items.length} public TypeScript names`,
          detail: entry.typescript.items.join(' and '),
        })
      );
    }
    if (entry.python.items.length > 1) {
      findings.push(
        new Finding({
          check: 'one-name-per-concept',
          requirement: 'FR-005',
          fail: true,
          message: `${entry.label} has ${entry.python.items.length} public Python names`,
          detail: entry.python.items.join(' and '),
        })
      );
    }
  }
  return findings;
}

/** An excluded entry must not gain a counterpart in the other language (FR-006). */
function checkExcluded(register, surfaceByName) {
  const findings = [];
  for (const entry of register.entries) {
    if (entry.kind !== 'excluded') continue;
    if (!entry.typescript.isAbsent) continue;
    for (const [candidate, origin] of counterpartCandidates(entry.python)) {
      const found = surfaceByName.get(candidate);
      if (found === undefined) continue;
      findings.push(
        new Finding({
          check: 'excluded',
          requirement: 'FR-006',
          fail: true,
          side: 'idfkit-js',
          message: `${entry.label} is excluded, and ${candidate} is public in ${found.packageName}`,
          detail:
            `the Python name it answers is ${origin}; exported from ${found.where}. ` +
            'Excluded is terminal: delete the counterpart, or amend the entry with review from both languages.',
        })
      );
    }
  }
  return findings;
}

/** A divergent or excluded entry states why each side is correct (contract, schema table). */
function checkDivergenceReasons(register) {
  const findings = [];
  for (const entry of register.entries) {
    if (!KINDS.has(entry.kind)) {
      findings.push(
        new Finding({
          check: 'schema',
          requirement: 'contract: field contract',
          fail: true,
          message: `${entry.label} has kind ${JSON.stringify(entry.kind)}`,
          detail: 'expected one of aligned, divergent, excluded',
        })
      );
      continue;
    }
    if (entry.kind !== 'aligned' && entry.divergenceReason.trim() === '') {
      findings.push(
        new Finding({
          check: 'divergence-reason',
          requirement: 'contract: exit contract',
          fail: true,
          message: `${entry.label} is ${entry.kind} and has no divergence_reason`,
        })
      );
    }
  }
  return findings;
}

/**
 * One rename per name, and no second one (FR-079, SC-003).
 *
 * Two things are checkable here. A count that has already reached 2 in the
 * pinned register is a failure on its face: the budget is one, and the block is
 * not waivable by the gate. And where a previous governance tag exists, a name
 * that changed between the two tags must have taken its count up by exactly
 * one, which is what makes the count a record of what happened rather than a
 * number someone remembered to type.
 */
function checkRenameCounts(register, previous) {
  const findings = [];
  for (const entry of register.entries) {
    if (!entry.hasRenameCount || entry.renamePython === null || entry.renameTypescript === null) {
      findings.push(
        new Finding({
          check: 'rename-count',
          requirement: 'FR-079',
          fail: true,
          message: `${entry.label} has no usable rename_count`,
          detail: 'expected rename_count = { python = <int>, typescript = <int> }',
        })
      );
      continue;
    }
    for (const [language, count] of [
      ['typescript', entry.renameTypescript],
      ['python', entry.renamePython],
    ]) {
      if (count >= 2) {
        findings.push(
          new Finding({
            check: 'rename-count',
            requirement: 'FR-079, SC-003',
            fail: true,
            message: `${entry.label} records ${count} ${language} renames`,
            detail:
              'One rename is the budget and a name at 1 is spent. A second rename needs an ' +
              'amendment to naming.toml, reviewed by both languages, stating why the first was wrong.',
          })
        );
      }
    }
  }

  if (previous === null) {
    findings.push(
      new Finding({
        check: 'rename-count',
        requirement: 'FR-079',
        fail: false,
        message:
          'no earlier governance tag to compare against, so no rename was checked against history',
      })
    );
    return findings;
  }

  const before = new Map(previous.entries.map((entry) => [entry.concept, entry]));
  for (const entry of register.entries) {
    const was = before.get(entry.concept);
    if (was === undefined) continue;
    for (const [language, side, wasSide, count, wasCount] of [
      [
        'typescript',
        entry.typescript,
        was.typescript,
        entry.renameTypescript,
        was.renameTypescript,
      ],
      ['python', entry.python, was.python, entry.renamePython, was.renamePython],
    ]) {
      // A name that disappeared between the two tags was renamed or withdrawn,
      // and the register is explicit that a withdrawal costs the same as a
      // rename. A name that only appeared is a new registration, which FR-007
      // asks for and which spends nothing.
      const gone = wasSide.items.filter((item) => !side.items.includes(item));
      if (gone.length === 0) continue;
      if (count !== (wasCount ?? 0) + 1) {
        findings.push(
          new Finding({
            check: 'rename-count',
            requirement: 'FR-079',
            fail: true,
            message: `${entry.label} dropped a ${language} name since ${previous.origin} without spending a rename`,
            detail: `${gone.join(', ')} is gone, ${side.toString() || '(nothing)'} is what is registered now, and rename_count.${language} went ${wasCount} to ${count}`,
          })
        );
      }
    }
  }
  return findings;
}

/**
 * Which side is behind the pinned register (FR-003, FR-082).
 *
 * A landed rename is the case that matters. `rename_count.typescript` above 0
 * says a rename has already been agreed and paid for, so the new spelling must
 * be on the surface: if it is not, this library is behind, and it stays blocked
 * until it catches up rather than the entry being withdrawn to make the red go
 * away. A registered name whose count is still 0 is the FR-007 case, a name
 * decided before it is written, and is reported without failing.
 */
function checkWhichSideIsBehind(register, surfaceByName, landedModulePaths) {
  const findings = [];
  const pending = [];
  for (const entry of register.entries) {
    const renamed = (entry.renameTypescript ?? 0) >= 1;

    if (entry.typescript.isAbsent) {
      // A withdrawal: the count was spent on removing the name, so the name it
      // answers must be gone from the surface.
      if (!renamed) continue;
      for (const [candidate, origin] of counterpartCandidates(entry.python)) {
        const found = surfaceByName.get(candidate);
        if (found === undefined) continue;
        findings.push(
          new Finding({
            check: 'behind',
            requirement: 'FR-003, FR-082',
            fail: true,
            side: 'idfkit-js',
            message: `${entry.label} was withdrawn in the pinned register and ${candidate} is still public`,
            detail: `answering ${origin}; exported from ${found.where}`,
          })
        );
      }
      continue;
    }

    const landed =
      [...entry.typescript.tokens].some((token) => surfaceByName.has(token)) ||
      entry.typescript.modulePaths.some((path) => landedModulePaths.has(path));
    if (landed) continue;
    if (renamed) {
      findings.push(
        new Finding({
          check: 'behind',
          requirement: 'FR-003, FR-082',
          fail: true,
          side: 'idfkit-js',
          message: `${entry.label} is registered as ${entry.typescript} with a rename already spent, and no such name is public`,
          detail:
            'idfkit-js is behind the pinned register. The entry is not withdrawn to clear this: ' +
            'the reverted side stays blocked until it catches up (FR-082).',
        })
      );
    } else {
      pending.push(entry);
    }
  }

  if (pending.length > 0) {
    findings.push(
      new Finding({
        check: 'behind',
        requirement: 'FR-007',
        fail: false,
        side: 'idfkit-js',
        message: `${pending.length} registered TypeScript names are not public yet`,
        detail: pending.map((entry) => `${entry.typescript} (${entry.concept})`).join(', '),
      })
    );
  }
  return findings;
}

/** Register entries whose only TypeScript home is a package the register does not claim. */
function checkGovernsList(register, surfaceByName, governed) {
  const strays = new Map();
  for (const entry of register.entries) {
    for (const token of entry.typescript.tokens) {
      const found = surfaceByName.get(token);
      if (found === undefined) continue;
      if (governed.has(found.packageName)) continue;
      if (!strays.has(found.packageName)) strays.set(found.packageName, []);
      strays.get(found.packageName).push(`${token} (${entry.concept})`);
    }
  }
  return [...strays].map(
    ([packageName, names]) =>
      new Finding({
        check: 'governs',
        requirement: 'FR-081',
        fail: true,
        side: 'register',
        message: `the register governs [${[...governed].join(', ')}] and names ${names.length} public members of ${packageName}`,
        detail: `${names.join(', ')}. Either add ${packageName} to [register] governs, or move those entries.`,
      })
  );
}

// ---------------------------------------------------------------------------
// Reading the register at the pinned tag
// ---------------------------------------------------------------------------

/** The gate could not run. Distinct from a contract failure, and exits 2. */
class GateRefusal extends Error {}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/** The pinned governance tag, or a refusal (FR-081, FR-084). */
function readPin() {
  if (!existsSync(PIN_PACKAGE)) {
    throw new GateRefusal(`No ${relative(REPO, PIN_PACKAGE)}, so there is no pin to read.`);
  }
  const manifest = JSON.parse(readFileSync(PIN_PACKAGE, 'utf8'));
  const tag = manifest.idfkit?.governance;
  if (typeof tag !== 'string' || tag === '') {
    throw new GateRefusal(
      `No idfkit.governance in ${relative(REPO, PIN_PACKAGE)}.\n` +
        'The naming register is read at a pinned governance-YYYY.N tag and never from a\n' +
        'default branch (FR-081). Add the pin, for example:\n\n' +
        '    "idfkit": { "governance": "governance-2026.1" }\n'
    );
  }
  if (!GOVERNANCE_TAG.test(tag)) {
    throw new GateRefusal(
      `idfkit.governance is ${JSON.stringify(tag)}; expected governance-YYYY.N.\n` +
        'Checked here rather than left to git, because a typo otherwise reports as a\n' +
        'missing ref, which reads like the corpus is broken.'
    );
  }
  return tag;
}

/** An idfkit-conformance checkout to read the register out of. */
function resolveCorpus(explicit) {
  const candidates = explicit
    ? [explicit]
    : [
        process.env.IDFKIT_CONFORMANCE_DIR,
        join(REPO, 'conformance'),
        resolve(REPO, '..', 'idfkit-conformance'),
      ].filter(Boolean);

  for (const candidate of candidates) {
    const dir = resolve(candidate);
    if (existsSync(join(dir, '.git'))) return dir;
  }
  throw new GateRefusal(
    'No idfkit-conformance checkout found. Looked at:\n' +
      candidates.map((candidate) => `    ${resolve(candidate)}`).join('\n') +
      '\n\nClone it, or pass --corpus <path>. There is no fallback to an unpinned copy:\n' +
      'the gate stops rather than reading a register it cannot vouch for (FR-084).'
  );
}

/** Read `governance/naming.toml` at one tag, and only at a tag. */
function readRegisterAtTag(corpusDir, tag) {
  const byTag = git(corpusDir, ['show', `${tag}:${REGISTER_PATH}`]);
  if (byTag.status === 0) {
    return { text: byTag.stdout, origin: `${tag} (git show, ${corpusDir})` };
  }

  // A CI checkout made with `actions/checkout` at `ref: <tag>` may hold the
  // commit without the tag object. Accept that, but only when HEAD is exactly
  // the pinned tag: reading a working tree that is anywhere else would be the
  // unpinned read FR-081 prohibits.
  const described = git(corpusDir, ['describe', '--tags', '--exact-match', 'HEAD']);
  if (described.status === 0 && described.stdout.trim() === tag) {
    const file = join(corpusDir, REGISTER_PATH);
    if (existsSync(file)) {
      return { text: readFileSync(file, 'utf8'), origin: `${tag} (checkout at ${corpusDir})` };
    }
  }

  const tags = git(corpusDir, ['tag', '--list', 'governance-*']).stdout.trim();
  throw new GateRefusal(
    `${corpusDir} has no ${tag}.\n` +
      (tags === ''
        ? 'It carries no governance tags at all. The register has to be published and\n' +
          'versioned before it can be pinned (FR-084): tag the corpus repository, then\n' +
          'point idfkit.governance at that tag.\n'
        : `Governance tags it does carry:\n${tags.replace(/^/gm, '    ')}\n`) +
      '\nThe gate does not read the default branch instead. An unpinned read would let\n' +
      'the corpus repository turn this one red with no review on this side (FR-081).'
  );
}

/** The governance tag immediately before the pinned one, if there is one. */
function previousGovernanceTag(corpusDir, tag) {
  const listed = git(corpusDir, ['tag', '--list', 'governance-*']);
  if (listed.status !== 0) return null;
  const order = (candidate) => {
    const [, year, serial] = /^governance-(\d{4})\.(\d+)$/.exec(candidate) ?? [];
    return year === undefined ? null : Number(year) * 10000 + Number(serial);
  };
  const tags = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => order(line) !== null)
    .sort((a, b) => order(a) - order(b));
  const index = tags.indexOf(tag);
  return index > 0 ? tags[index - 1] : null;
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    corpus: null,
    register: null,
    typedoc: DEFAULT_TYPEDOC,
    build: false,
    allPackages: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new GateRefusal(`${arg} needs a value`);
      return value;
    };
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg === '--corpus') options.corpus = next();
    else if (arg === '--register') options.register = next();
    else if (arg === '--typedoc') options.typedoc = resolve(next());
    else if (arg === '--build') options.build = true;
    else if (arg === '--all-packages') options.allPackages = true;
    else if (arg === '--json') options.json = true;
    else throw new GateRefusal(`Unknown option ${arg}. Try --help.`);
  }
  return options;
}

function build() {
  for (const command of [
    ['npx', ['tsc', '--build']],
    ['npm', ['run', 'docs:api']],
  ]) {
    const result = spawnSync(command[0], command[1], {
      cwd: REPO,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      throw new GateRefusal(
        `${command[0]} ${command[1].join(' ')} failed, so there is nothing to check.`
      );
    }
  }
}

/** Every workspace package directory that has a package.json. */
function workspacePackages() {
  const dir = join(REPO, 'packages');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => existsSync(join(path, 'package.json')));
}

function newest(files) {
  let latest = 0;
  for (const file of files) {
    const time = statSync(file).mtimeMs;
    if (time > latest) latest = time;
  }
  return latest;
}

function report(lines) {
  process.stdout.write(lines.join('\n') + '\n');
}

function main(argv) {
  const options = parseArgs(argv);
  const out = [];

  if (options.build) build();

  // The pin is required whether or not the register is read from it. A local
  // override changes where the bytes come from, never whether a pin exists.
  const tag = readPin();

  let registerText;
  let origin;
  let previous = null;

  if (options.register !== null) {
    const file = resolve(options.register);
    if (!existsSync(file)) throw new GateRefusal(`No register at ${file}`);
    registerText = readFileSync(file, 'utf8');
    origin = `${relative(REPO, file) || file} (LOCAL OVERRIDE)`;
    out.push(
      '!! --register is in use. This run read a local file, not the pinned tag.',
      `!! Pin declared: ${tag}. Register read from: ${file}`,
      '!! A CI run must not pass --register: the gate reads a tag, never a working copy.',
      ''
    );
  } else {
    const corpus = resolveCorpus(options.corpus);
    const read = readRegisterAtTag(corpus, tag);
    registerText = read.text;
    origin = read.origin;
    const earlier = previousGovernanceTag(corpus, tag);
    if (earlier !== null) {
      previous = new Register(parseToml(readRegisterAtTag(corpus, earlier).text, earlier), earlier);
    }
  }

  const register = new Register(parseToml(registerText, 'naming.toml'), origin);
  if (register.entries.length === 0) {
    throw new GateRefusal(`Read ${origin} and found no [[entry]] tables. That cannot be right.`);
  }

  const packageDirs = workspacePackages();
  const { entryPoints, missing } = readEntryPoints(packageDirs);
  if (entryPoints.length === 0) {
    throw new GateRefusal(
      'No built declaration files behind any package exports map.\n' +
        'Run "npx tsc --build" first, or pass --build.'
    );
  }
  if (!existsSync(options.typedoc)) {
    throw new GateRefusal(
      `No TypeDoc JSON at ${options.typedoc}.\n` +
        'It is the same artifact the reference pages are built from. Produce it with\n' +
        '"npm run docs:api" (after "npx tsc --build"), or pass --build.'
    );
  }

  const typedoc = readTypedoc(options.typedoc);
  const { names, starExports, undocumented } = readSurface(entryPoints, typedoc);

  // Presence is a whole-repository question: a registered name counts as landed
  // wherever in idfkit-js it lives. Coverage is the scoped one.
  const surfaceByName = new Map();
  for (const name of names) if (!surfaceByName.has(name.name)) surfaceByName.set(name.name, name);

  const governed = new Set(register.governs);
  const inScope = options.allPackages
    ? names
    : names.filter((name) => governed.has(name.packageName));
  const outOfScope = names.length - inScope.length;

  // An entry point the register names as a module is covered whole. The
  // generated type maps are the case this exists for: one entry per EnergyPlus
  // object type, machine-written from the schema, and registered as one concept.
  const moduleCovered = new Set();
  const landedModulePaths = new Set();
  for (const { path } of register.typescriptModulePaths()) {
    for (const entryPoint of entryPoints) {
      if (entryPoint.specifier === path || entryPoint.specifier.startsWith(`${path}/`)) {
        moduleCovered.add(entryPoint.specifier);
        landedModulePaths.add(path);
      }
    }
  }

  const coverage = checkCoverage(register, inScope, moduleCovered);
  const findings = [
    ...coverage.findings,
    ...checkOneNamePerConcept(register),
    ...checkExcluded(register, surfaceByName),
    ...checkDivergenceReasons(register),
    ...checkRenameCounts(register, previous),
    ...checkWhichSideIsBehind(register, surfaceByName, landedModulePaths),
    ...checkGovernsList(register, surfaceByName, governed),
  ];

  for (const specifier of starExports) {
    findings.push(
      new Finding({
        check: 'coverage',
        requirement: 'FR-008',
        fail: false,
        message: `${specifier} re-exports with "export *", so its surface cannot be enumerated exactly`,
      })
    );
  }
  for (const specifier of undocumented) {
    findings.push(
      new Finding({
        check: 'inputs',
        requirement: 'FR-084',
        fail: false,
        message: `${specifier} contributed nothing to the TypeDoc JSON, so only its .d.ts was read`,
        detail:
          'Expected for an entry point TypeDoc does not enumerate, such as a wildcard subpath. ' +
          'Unexpected anywhere else, and it means the reference artifact is missing that surface too.',
      })
    );
  }
  for (const target of missing) {
    findings.push(
      new Finding({
        check: 'inputs',
        requirement: 'FR-084',
        fail: false,
        message: `${target} is in an exports map with nothing built behind it`,
      })
    );
  }
  if (
    newest(entryPoints.map((entryPoint) => entryPoint.declarationFile)) >
    statSync(options.typedoc).mtimeMs
  ) {
    findings.push(
      new Finding({
        check: 'inputs',
        requirement: 'FR-084',
        fail: false,
        message: 'the TypeDoc JSON is older than the built declarations, so it may be stale',
        detail: 'rerun with --build, or "npm run docs:api"',
      })
    );
  }

  const failures = findings.filter((finding) => finding.fail);
  const notes = findings.filter((finding) => !finding.fail);

  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        {
          pin: tag,
          register: origin,
          previousRegister: previous?.origin ?? null,
          governs: [...governed],
          namesChecked: inScope.length - coverage.inModules,
          namesCovered: coverage.covered,
          namesInCoveredModules: coverage.inModules,
          namesOutOfScope: outOfScope,
          entryPoints: entryPoints.map((entryPoint) => entryPoint.specifier),
          findings: findings.map((finding) => ({ ...finding })),
        },
        null,
        2
      ) + '\n'
    );
    return failures.length === 0 ? 0 : 1;
  }

  out.push(
    'Naming register gate, idfkit-js',
    `  pin           ${tag}`,
    `  register      ${origin}`,
    `  compared to   ${previous?.origin ?? '(no earlier governance tag)'}`,
    `  governs       ${[...governed].join(', ') || '(nothing)'}`,
    `  entry points  ${entryPoints.length} across ${packageDirs.length} packages`,
    `  names         ${inScope.length - coverage.inModules} checked, ${coverage.covered} covered, ${coverage.uncovered.length} uncovered`,
    `                ${coverage.inModules} inside entry points the register covers as whole modules`,
    `                ${outOfScope} outside the governs list, counted and not failed`,
    ''
  );

  const order = [
    'coverage',
    'behind',
    'one-name-per-concept',
    'excluded',
    'divergence-reason',
    'rename-count',
    'schema',
    'governs',
    'inputs',
  ];
  const sortByCheck = (a, b) => order.indexOf(a.check) - order.indexOf(b.check);

  if (failures.length > 0) {
    out.push(`FAIL (${failures.length})`, '');
    for (const finding of [...failures].sort(sortByCheck)) {
      out.push(`  [${finding.check}] ${finding.message}`);
      out.push(`      ${finding.requirement}${finding.side ? ` | behind: ${finding.side}` : ''}`);
      if (finding.detail) out.push(...finding.detail.split('\n').map((line) => `      ${line}`));
      out.push('');
    }
  }
  if (notes.length > 0) {
    out.push(`Notes (${notes.length}), not failures`, '');
    for (const finding of [...notes].sort(sortByCheck)) {
      out.push(`  [${finding.check}] ${finding.message}`);
      if (finding.detail) out.push(...finding.detail.split('\n').map((line) => `      ${line}`));
      out.push('');
    }
  }

  out.push(
    failures.length === 0
      ? `PASS: ${coverage.covered} of ${inScope.length - coverage.inModules} public names resolve to a register entry.`
      : `FAIL: ${failures.length} findings against ${origin}.`
  );
  report(out);
  return failures.length === 0 ? 0 : 1;
}

// Guarded, so the pieces above can be imported and exercised on their own. The
// TOML reader in particular is worth holding against a second implementation.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

try {
  if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof GateRefusal) {
    process.stderr.write(`\ncheck-naming-register: refusing to run.\n\n${error.message}\n\n`);
    process.exitCode = 2;
  } else if (error instanceof TomlError) {
    process.stderr.write(
      `\ncheck-naming-register: cannot read the register.\n\n${error.message}\n\n`
    );
    process.exitCode = 2;
  } else {
    throw error;
  }
}
