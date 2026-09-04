#!/usr/bin/env node
/**
 * The parity gate for idfkit-js (tasks T129, T130).
 *
 * Diffs the JavaScript exported capability set against the parity ledger,
 * `governance/parity.toml` in idfkit-conformance, read at the governance tag this
 * repository pins. The Python counterpart is `idfkit/scripts/check_parity_ledger.py`;
 * both implement the exit contract in contracts/parity-ledger.md.
 *
 * HOW THE LEDGER IS READ
 *
 * The tag comes from `idfkit.governance` in `packages/core/package.json`. There is no
 * fallback to a branch, to a cached copy, or to the newest tag: an unpinned or
 * unresolvable read fails with exit 2 (FR-081, governance/README.md, "Fail, do not fall
 * back"). The one way past that is deliberate and loud, `--governance-dir <path>` or
 * IDFKIT_GOVERNANCE_DIR, which reads the working tree of a conformance checkout and
 * prints an override banner on every run. The pin is required even under the override: a
 * repository that cannot say which vocabulary it is built against is broken wherever that
 * is noticed.
 *
 * HOW THE EXPORTED CAPABILITY SET IS DERIVED
 *
 * The same way the naming gate derives the public surface, then mapped to ledger ids
 * through the `names` field, in four steps:
 *
 *   1. Entry points come from each scanned package's `exports` map in its package.json,
 *      never from a hand-kept list. A `./dist/x.js` target resolves to `src/x.ts`, so the
 *      gate runs on a clean checkout with nothing built. A wildcard subpath such as
 *      `./types/*` contributes the module specifier itself, not the thousands of
 *      schema-generated interfaces behind it, which are named by EnergyPlus rather than
 *      by the register.
 *   2. Every top-level `export` in those entry files is harvested: brace re-exports
 *      (`export { a, b as c } from ...`, `export type { ... }`) and declaration exports
 *      (function, class, const, let, var, interface, type, enum). `export *` is rejected
 *      rather than followed, because a star would make the derived surface silently
 *      incomplete.
 *   3. Each harvested name is resolved to a naming-register concept through the
 *      `typescript` field of `governance/naming.toml`, read at the same pinned tag.
 *   4. Each concept is mapped to the capability whose `names` list contains it. That
 *      capability is the unit this gate reports on.
 *
 * A capability counts as PRESENT when at least one of its checkable names is exported.
 * Any, not all, on purpose: a capability mid-rename, exported under the old spelling for
 * one of its names, is naming drift and belongs to the naming gate. Reporting it here as
 * well would give one defect two red gates and teach a reader to discount both.
 *
 * A register name is checkable when it is an identifier (`parseIdf`), a member of an
 * exported type (`StationIndex.search`, checked by its receiver), or a module specifier
 * (`@idfkit/core/types`). The register also holds usage forms, `doc.all('Zone')` and
 * `new IdfDocument(schema)` among them, which name a shape rather than an export and are
 * counted as unverifiable rather than missing.
 *
 * PACKAGES SCANNED
 *
 * `@idfkit/core` and `@idfkit/weather`. Both appear in the ledger, weather under
 * `weather-index` and `geocoding`. `@idfkit/schemas` is deliberately not scanned: every
 * public name it has reaches a reader re-exported through `@idfkit/core`, where this gate
 * already sees it, and scanning it separately would count those names twice.
 * `@idfkit/engine` and `@idfkit/viewer` are outside this repository and outside the
 * shared install name by design (ledger entries `browser-simulation`, `scene-rendering`).
 *
 * EXIT CODES
 *
 *   0  the ledger and the exported set agree; counts per state are printed
 *   1  at least one finding, one line each, per the exit contract
 *   2  the gate could not run: no pin, no ledger, or an unscannable surface
 *
 * Plain ESM, no dependencies. The TOML reader below is a subset parser, written here
 * because Node has no built-in one and this gate is not worth a dependency.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Packages whose exports make up the shared JavaScript surface, and why each is here. */
const SCANNED_PACKAGES = [
  { dir: 'packages/core', reason: 'the shared install name' },
  {
    dir: 'packages/weather',
    reason: 'the opt-in weather peer, ledger entries weather-index and geocoding',
  },
];

const TIERS = ['tier-1', 'tier-2', 'tier-3', 'never'];
const STATES = ['complete', 'partial', 'absent'];
const ABSENCE_KINDS = ['not-yet', 'never'];

const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_CANNOT_RUN = 2;

/**
 * @typedef {object} Capability
 * @property {string} id
 * @property {string} title
 * @property {string} tier
 * @property {string} python
 * @property {string} typescript
 * @property {string | null} absenceKind
 * @property {string | null} differences
 * @property {string | null} issue
 * @property {string | null} note
 * @property {string[]} names
 *
 * @typedef {object} RegisterEntry
 * @property {string} concept
 * @property {string} python
 * @property {string} typescript
 * @property {string} kind
 *
 * @typedef {object} ExportedName
 * @property {string} name
 * @property {string} module    Module specifier the name is exported from.
 * @property {string} file      Repository-relative source file it is declared or re-exported in.
 *
 * @typedef {object} Finding
 * @property {string} code
 * @property {string} subject   Capability id, or an exported name where no capability applies.
 * @property {string} message
 *
 * @typedef {object} GovernanceSource
 * @property {string} origin    Human-readable "<path> at <ref>".
 * @property {boolean} overridden
 * @property {string} pin
 * @property {string} namingToml
 * @property {string} parityToml
 */

class CannotRun extends Error {}

// ---------------------------------------------------------------------------
// A TOML subset parser: tables, arrays of tables, dotted keys, basic and literal
// strings (single and multi-line), integers, floats, booleans, arrays, inline
// tables, and comments. Enough for naming.toml and parity.toml, and it refuses
// anything it does not understand rather than guessing.
// ---------------------------------------------------------------------------

/**
 * @param {string} text
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function parseToml(text, label) {
  let i = 0;
  const root = /** @type {Record<string, unknown>} */ ({});
  let table = root;

  const fail = (message) => {
    const line = text.slice(0, i).split('\n').length;
    throw new CannotRun(`${label}:${line}: ${message}`);
  };

  const skipTrivia = () => {
    for (;;) {
      while (i < text.length && ' \t\r\n'.includes(text[i])) i += 1;
      if (text[i] === '#') {
        while (i < text.length && text[i] !== '\n') i += 1;
        continue;
      }
      return;
    }
  };

  const readBasicString = (raw) => {
    let out = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        i += 1;
        return out;
      }
      if (ch === '\\' && !raw) {
        i += 1;
        const esc = text[i];
        i += 1;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === '"') out += '"';
        else if (esc === '\\') out += '\\';
        else if (esc === 'u') {
          out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16));
          i += 4;
        } else fail(`unsupported escape \\${esc}`);
        continue;
      }
      out += ch;
      i += 1;
    }
    return fail('unterminated string');
  };

  const readMultiline = (delim) => {
    // TOML trims one newline immediately after the opening delimiter.
    if (text[i] === '\n') i += 1;
    else if (text.startsWith('\r\n', i)) i += 2;
    let out = '';
    while (i < text.length) {
      if (text.startsWith(delim, i)) {
        i += delim.length;
        return out;
      }
      if (delim === '"""' && text[i] === '\\') {
        const next = text[i + 1];
        if (next === '\n' || next === '\r') {
          // Line-ending backslash: swallow the newline and the indent after it.
          i += 1;
          while (i < text.length && ' \t\r\n'.includes(text[i])) i += 1;
          continue;
        }
        i += 1;
        i += 1;
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === '"') out += '"';
        else if (next === '\\') out += '\\';
        else fail(`unsupported escape \\${next}`);
        continue;
      }
      out += text[i];
      i += 1;
    }
    return fail('unterminated multi-line string');
  };

  const readValue = () => {
    skipTrivia();
    if (text.startsWith('"""', i)) {
      i += 3;
      return readMultiline('"""');
    }
    if (text.startsWith("'''", i)) {
      i += 3;
      return readMultiline("'''");
    }
    if (text[i] === '"') {
      i += 1;
      return readBasicString(false);
    }
    if (text[i] === "'") {
      i += 1;
      let out = '';
      while (i < text.length && text[i] !== "'") {
        out += text[i];
        i += 1;
      }
      if (text[i] !== "'") fail('unterminated literal string');
      i += 1;
      return out;
    }
    if (text[i] === '[') {
      i += 1;
      const items = [];
      for (;;) {
        skipTrivia();
        if (text[i] === ']') {
          i += 1;
          return items;
        }
        items.push(readValue());
        skipTrivia();
        if (text[i] === ',') i += 1;
        else if (text[i] !== ']') fail('expected , or ] in array');
      }
    }
    if (text[i] === '{') {
      i += 1;
      const inline = /** @type {Record<string, unknown>} */ ({});
      for (;;) {
        skipTrivia();
        if (text[i] === '}') {
          i += 1;
          return inline;
        }
        const key = readKey();
        skipTrivia();
        if (text[i] !== '=') fail('expected = in inline table');
        i += 1;
        assign(inline, key, readValue());
        skipTrivia();
        if (text[i] === ',') i += 1;
        else if (text[i] !== '}') fail('expected , or } in inline table');
      }
    }
    if (text.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return false;
    }
    const number = /^[+-]?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (number !== null) {
      i += number[0].length;
      return Number(number[0].replace(/_/g, ''));
    }
    return fail(`unrecognised value starting ${JSON.stringify(text.slice(i, i + 20))}`);
  };

  const readKey = () => {
    /** @type {string[]} */
    const parts = [];
    for (;;) {
      skipTrivia();
      if (text[i] === '"') {
        i += 1;
        parts.push(readBasicString(false));
      } else {
        const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
        if (bare === null) fail('expected a key');
        i += bare[0].length;
        parts.push(bare[0]);
      }
      if (text[i] === '.') {
        i += 1;
        continue;
      }
      return parts;
    }
  };

  /**
   * @param {Record<string, unknown>} target
   * @param {string[]} key
   * @param {unknown} value
   */
  function assign(target, key, value) {
    let node = target;
    for (const part of key.slice(0, -1)) {
      node[part] ??= {};
      node = /** @type {Record<string, unknown>} */ (node[part]);
    }
    node[key[key.length - 1]] = value;
  }

  for (;;) {
    skipTrivia();
    if (i >= text.length) return root;

    if (text.startsWith('[[', i)) {
      i += 2;
      const key = readKey();
      skipTrivia();
      if (!text.startsWith(']]', i)) fail('expected ]] closing an array-of-tables header');
      i += 2;
      let node = root;
      for (const part of key.slice(0, -1)) {
        node[part] ??= {};
        node = /** @type {Record<string, unknown>} */ (node[part]);
      }
      const last = key[key.length - 1];
      node[last] ??= [];
      const fresh = {};
      /** @type {unknown[]} */ (node[last]).push(fresh);
      table = fresh;
      continue;
    }

    if (text[i] === '[') {
      i += 1;
      const key = readKey();
      skipTrivia();
      if (text[i] !== ']') fail('expected ] closing a table header');
      i += 1;
      let node = root;
      for (const part of key) {
        node[part] ??= {};
        node = /** @type {Record<string, unknown>} */ (node[part]);
      }
      table = node;
      continue;
    }

    const key = readKey();
    skipTrivia();
    if (text[i] !== '=') fail('expected = after a key');
    i += 1;
    assign(table, key, readValue());
  }
}

// ---------------------------------------------------------------------------
// Reading the governance files at the pinned tag
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {GovernanceSource}
 */
function resolveGovernance(argv) {
  const flagIndex = argv.indexOf('--governance-dir');
  const overrideDir = flagIndex === -1 ? process.env.IDFKIT_GOVERNANCE_DIR : argv[flagIndex + 1];

  const corePackagePath = join(REPO_ROOT, 'packages/core/package.json');
  if (!existsSync(corePackagePath)) {
    throw new CannotRun(`no packages/core/package.json under ${REPO_ROOT}`);
  }
  const corePackage = JSON.parse(readFileSync(corePackagePath, 'utf8'));
  const pin = corePackage?.idfkit?.governance;

  // The pin is required even under the override. A repository with no pin cannot say
  // which vocabulary it is built against, and that is a defect wherever it is noticed.
  if (typeof pin !== 'string' || !/^governance-\d{4}\.\d+$/.test(pin)) {
    throw new CannotRun(
      [
        'no governance pin in packages/core/package.json.',
        'Add one, for example:',
        '',
        '  "idfkit": { "governance": "governance-2026.1" }',
        '',
        'The ledger is read at a pinned governance tag and never from a branch (FR-081).',
      ].join('\n')
    );
  }

  if (overrideDir !== undefined && overrideDir !== '') {
    const dir = resolve(overrideDir);
    const governanceDir = existsSync(join(dir, 'governance')) ? join(dir, 'governance') : dir;
    const read = (name) => {
      const path = join(governanceDir, name);
      if (!existsSync(path)) throw new CannotRun(`override directory has no ${name}: ${path}`);
      return readFileSync(path, 'utf8');
    };
    return {
      origin: `${governanceDir} (working tree)`,
      overridden: true,
      pin,
      namingToml: read('naming.toml'),
      parityToml: read('parity.toml'),
    };
  }

  // Checkout search order, matching scripts/check-naming-register.mjs so the two gates take
  // the same argument: --corpus, then the environment, then ./conformance (a CI checkout
  // inside the workspace), then a sibling clone.
  const corpusIndex = argv.indexOf('--corpus');
  const candidates = [
    corpusIndex === -1 ? undefined : argv[corpusIndex + 1],
    process.env.IDFKIT_CONFORMANCE_DIR,
    process.env.IDFKIT_CONFORMANCE_REPO,
    join(REPO_ROOT, 'conformance'),
    join(REPO_ROOT, '..', 'idfkit-conformance'),
  ].filter((candidate) => candidate !== undefined && candidate !== '');

  const conformanceRepo = resolve(
    candidates.find((candidate) => existsSync(join(resolve(candidate), '.git'))) ??
      candidates[candidates.length - 1]
  );
  if (!existsSync(join(conformanceRepo, '.git'))) {
    throw new CannotRun(
      [
        `no idfkit-conformance checkout at ${conformanceRepo}.`,
        'Clone it beside this repository, pass --corpus <path>, or set IDFKIT_CONFORMANCE_DIR.',
      ].join('\n')
    );
  }

  const show = (path) => {
    try {
      return execFileSync('git', ['-C', conformanceRepo, 'show', `${pin}:${path}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new CannotRun(
        [
          `cannot read ${path} at ${pin} in ${conformanceRepo}.`,
          `git said: ${String(error.stderr ?? error.message).trim()}`,
          '',
          'The tag is published before it is pinned, and a consuming build never falls back',
          'to a branch (FR-081). Fetch the tag, or pass --governance-dir <path> to read a',
          'working tree deliberately.',
        ].join('\n')
      );
    }
  };

  return {
    origin: `${conformanceRepo} at ${pin}`,
    overridden: false,
    pin,
    namingToml: show('governance/naming.toml'),
    parityToml: show('governance/parity.toml'),
  };
}

// ---------------------------------------------------------------------------
// Deriving the exported capability set
// ---------------------------------------------------------------------------

const EXPORT_BRACE = /^export\s+(?:type\s+)?\{([^}]*)\}/gm;
const EXPORT_DECL =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_STAR = /^export\s+\*/m;

/**
 * Harvest the top-level exported names of one entry file.
 *
 * @param {string} source
 * @param {string} label
 * @returns {string[]}
 */
function exportedNamesOf(source, label) {
  if (EXPORT_STAR.test(source)) {
    throw new CannotRun(
      `${label} uses "export *", which this gate does not follow. Name the exports explicitly ` +
        'so the derived public surface stays complete.'
    );
  }

  /** @type {string[]} */
  const names = [];

  for (const match of source.matchAll(EXPORT_BRACE)) {
    for (const raw of match[1].split(',')) {
      const clause = raw.trim().replace(/^type\s+/, '');
      if (clause === '') continue;
      const parts = clause.split(/\s+as\s+/);
      const name = (parts[parts.length - 1] ?? '').trim();
      if (name !== '' && name !== 'default') names.push(name);
    }
  }

  for (const match of source.matchAll(EXPORT_DECL)) names.push(match[1]);

  return names;
}

/**
 * @returns {{ names: ExportedName[]; specifiers: Set<string>; modules: string[] }}
 */
function deriveExportedSurface() {
  /** @type {ExportedName[]} */
  const names = [];
  /** @type {Set<string>} */
  const specifiers = new Set();
  /** @type {string[]} */
  const modules = [];

  for (const pkg of SCANNED_PACKAGES) {
    const packageJsonPath = join(REPO_ROOT, pkg.dir, 'package.json');
    if (!existsSync(packageJsonPath)) {
      throw new CannotRun(`scanned package ${pkg.dir} has no package.json (${pkg.reason})`);
    }
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const exportsMap = manifest.exports;
    if (typeof exportsMap !== 'object' || exportsMap === null) {
      throw new CannotRun(`${pkg.dir}/package.json has no exports map to derive a surface from`);
    }

    for (const [subpath, target] of Object.entries(exportsMap)) {
      const specifier =
        subpath === '.'
          ? manifest.name
          : `${manifest.name}${subpath.slice(1)}`.replace(/\/\*$/, '');
      specifiers.add(specifier);

      if (subpath.includes('*')) {
        // A wildcard subpath is a directory of generated or data files. The specifier is
        // public; the thousands of names behind it are named by EnergyPlus, not by the
        // naming register, so they are not harvested.
        continue;
      }

      const file =
        typeof target === 'string' ? target : (target.types ?? target.default ?? target.import);
      if (typeof file !== 'string') {
        throw new CannotRun(`${pkg.dir} exports "${subpath}" with no resolvable target`);
      }
      const sourcePath = join(
        REPO_ROOT,
        pkg.dir,
        file.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$|\.js$/, '.ts')
      );
      if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
        throw new CannotRun(
          `${pkg.dir} exports "${subpath}" but its source ${sourcePath} does not exist`
        );
      }

      const relative = sourcePath.slice(REPO_ROOT.length + 1);
      modules.push(specifier);
      for (const name of exportedNamesOf(readFileSync(sourcePath, 'utf8'), relative)) {
        names.push({ name, module: specifier, file: relative });
      }
    }
  }

  return { names, specifiers, modules };
}

// ---------------------------------------------------------------------------
// Classifying a register name
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const MEMBER = /^([A-Z][\w$]*)\.([A-Za-z_$][\w$]*)$/;

/**
 * @param {string} name
 * @returns {{ kind: 'identifier' | 'member' | 'module' | 'usage' | 'absent'; lookup: string }}
 */
function classifyName(name) {
  const trimmed = name.trim();
  if (trimmed === '') return { kind: 'absent', lookup: '' };
  if (trimmed.startsWith('@') || trimmed.includes('/')) return { kind: 'module', lookup: trimmed };
  if (IDENTIFIER.test(trimmed)) return { kind: 'identifier', lookup: trimmed };
  const member = MEMBER.exec(trimmed);
  // A PascalCase receiver is an exported type, so the member is checkable through it. A
  // lowercase receiver (`doc.version`) names an instance, which no static scan can find.
  if (member !== null) return { kind: 'member', lookup: member[1] };
  return { kind: 'usage', lookup: trimmed };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * @param {unknown} raw
 * @returns {Capability[]}
 */
function readLedger(raw) {
  const rows = /** @type {Record<string, unknown>} */ (raw).capability;
  if (!Array.isArray(rows)) throw new CannotRun('parity.toml holds no [[capability]] entries');
  return rows.map((row) => ({
    id: typeof row.id === 'string' ? row.id : '',
    title: typeof row.title === 'string' ? row.title : '',
    tier: typeof row.tier === 'string' ? row.tier : '',
    python: typeof row.python === 'string' ? row.python : '',
    typescript: typeof row.typescript === 'string' ? row.typescript : '',
    absenceKind: typeof row.absence_kind === 'string' ? row.absence_kind : null,
    differences: typeof row.differences === 'string' ? row.differences : null,
    issue: typeof row.issue === 'string' ? row.issue : null,
    note: typeof row.note === 'string' ? row.note : null,
    names: Array.isArray(row.names) ? row.names.filter((n) => typeof n === 'string') : [],
  }));
}

/**
 * @param {unknown} raw
 * @returns {Map<string, RegisterEntry>}
 */
function readRegister(raw) {
  const rows = /** @type {Record<string, unknown>} */ (raw).entry;
  if (!Array.isArray(rows)) throw new CannotRun('naming.toml holds no [[entry]] entries');
  /** @type {Map<string, RegisterEntry>} */
  const byConcept = new Map();
  for (const row of rows) {
    if (typeof row.concept !== 'string') continue;
    byConcept.set(row.concept, {
      concept: row.concept,
      python: typeof row.python === 'string' ? row.python : '',
      typescript: typeof row.typescript === 'string' ? row.typescript : '',
      kind: typeof row.kind === 'string' ? row.kind : '',
    });
  }
  return byConcept;
}

/**
 * Ledger self-consistency, which is what T130 turns on: the field contract in
 * contracts/parity-ledger.md, checked before any diff against the code.
 *
 * @param {Capability[]} ledger
 * @param {Map<string, RegisterEntry>} register
 * @returns {Finding[]}
 */
function checkLedgerShape(ledger, register) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (const cap of ledger) {
    const add = (code, message) => findings.push({ code, subject: cap.id || '(no id)', message });

    if (cap.id === '') add('E-SCHEMA', 'a capability has no id');
    else if (seen.has(cap.id)) add('E-SCHEMA', `duplicate capability id "${cap.id}"`);
    seen.add(cap.id);

    if (cap.title === '') add('E-SCHEMA', 'no title');
    if (!TIERS.includes(cap.tier))
      add('E-SCHEMA', `tier "${cap.tier}" is not one of ${TIERS.join(', ')}`);
    if (!STATES.includes(cap.python))
      add('E-SCHEMA', `python "${cap.python}" is not one of ${STATES.join(', ')}`);
    if (!STATES.includes(cap.typescript))
      add('E-SCHEMA', `typescript "${cap.typescript}" is not one of ${STATES.join(', ')}`);

    const someoneIsAbsent = cap.python === 'absent' || cap.typescript === 'absent';
    const someoneIsPartial = cap.python === 'partial' || cap.typescript === 'partial';

    if (someoneIsAbsent && cap.absenceKind === null) {
      add('E-ABSENCE-KIND', 'a side is absent with no absence_kind (FR-050)');
    }
    if (cap.absenceKind !== null && !ABSENCE_KINDS.includes(cap.absenceKind)) {
      add(
        'E-ABSENCE-KIND',
        `absence_kind "${cap.absenceKind}" is not one of ${ABSENCE_KINDS.join(', ')}`
      );
    }
    if (cap.absenceKind !== null && !someoneIsAbsent) {
      add('E-ABSENCE-KIND', 'absence_kind is set but neither side is absent');
    }

    // Invariant 3: partial with no differences is indistinguishable from complete.
    if (someoneIsPartial && (cap.differences === null || cap.differences.trim() === '')) {
      add('E-PARTIAL-NO-DIFF', 'partial with no differences (FR-049)');
    }

    // absence_kind = "not-yet" requires a tracking issue, and a placeholder is not one.
    // A fabricated or unwritten URL passes as documentation and dead-links the reader.
    if (cap.absenceKind === 'not-yet') {
      const issue = (cap.issue ?? '').trim();
      if (issue === '') {
        add('E-NOTYET-NO-ISSUE', 'absence_kind = "not-yet" with no issue');
      } else if (!/^https?:\/\/\S+$/.test(issue)) {
        add(
          'E-NOTYET-NO-ISSUE',
          `absence_kind = "not-yet" with no tracking issue URL: issue = "${issue}"`
        );
      }
    }

    // `never` is a permanent claim, so it has to say why.
    if (cap.absenceKind === 'never' && (cap.note === null || cap.note.trim() === '')) {
      add('E-NEVER-NO-NOTE', 'absence_kind = "never" with no note');
    }

    for (const concept of cap.names) {
      if (!register.has(concept)) {
        add(
          'E-NAME-UNRESOLVED',
          `names entry "${concept}" does not resolve in the naming register`
        );
      }
    }
  }

  return findings;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      [
        'check-parity-ledger.mjs: diff the JavaScript exported capability set against the parity ledger.',
        '',
        'Usage: node scripts/check-parity-ledger.mjs [--corpus <path>] [--governance-dir <path>]',
        '                                            [--verbose]',
        '',
        '  --corpus <path>          The idfkit-conformance checkout the pinned tag is read from.',
        '                           Default: $IDFKIT_CONFORMANCE_DIR, then ./conformance, then',
        '                           ../idfkit-conformance.',
        '  --governance-dir <path>  Read naming.toml and parity.toml from a working tree instead',
        '                           of from the pinned tag. DEVELOPMENT ONLY: announced on every',
        '                           run, and a pin must still be declared. A directory, not a',
        '                           file, because this gate reads both governance files.',
        '  --verbose                Also list exported names that resolve to no register concept.',
        '',
        'Environment: IDFKIT_GOVERNANCE_DIR (same as --governance-dir),',
        '             IDFKIT_CONFORMANCE_DIR (same as --corpus).',
        '',
        'Exit: 0 agreement, 1 findings, 2 the gate could not run.',
        '',
      ].join('\n')
    );
    return EXIT_OK;
  }
  const verbose = argv.includes('--verbose');

  const governance = resolveGovernance(argv);
  const ledger = readLedger(parseToml(governance.parityToml, 'parity.toml'));
  const register = readRegister(parseToml(governance.namingToml, 'naming.toml'));
  const surface = deriveExportedSurface();

  const exportedByName = new Map(surface.names.map((entry) => [entry.name, entry]));

  /** @type {Finding[]} */
  const findings = checkLedgerShape(ledger, register);

  // Concept to capability, so an exported name can be traced back to the ledger.
  /** @type {Map<string, Capability>} */
  const capabilityByConcept = new Map();
  for (const cap of ledger) {
    for (const concept of cap.names) {
      if (!capabilityByConcept.has(concept)) capabilityByConcept.set(concept, cap);
    }
  }

  // ---- Direction one: does the code still carry what the ledger claims? ----

  /** @type {Map<string, string[]>} */
  const unverifiable = new Map();

  for (const cap of ledger) {
    if (
      cap.typescript !== 'complete' &&
      cap.typescript !== 'partial' &&
      cap.typescript !== 'absent'
    ) {
      continue; // Already reported as a schema failure.
    }

    /** @type {string[]} */
    const found = [];
    /** @type {string[]} */
    const missing = [];
    /** @type {string[]} */
    const skipped = [];
    let unresolved = 0;

    for (const concept of cap.names) {
      const entry = register.get(concept);
      if (entry === undefined) {
        unresolved += 1; // Reported as E-NAME-UNRESOLVED.
        continue;
      }
      const { kind, lookup } = classifyName(entry.typescript);
      if (kind === 'absent' || kind === 'usage') {
        skipped.push(`${concept} (${kind === 'absent' ? 'no TypeScript name' : entry.typescript})`);
        continue;
      }
      const present =
        kind === 'module' ? surface.specifiers.has(lookup) : exportedByName.has(lookup);
      if (present) found.push(entry.typescript);
      else missing.push(entry.typescript);
    }

    const checkable = found.length + missing.length;

    if (cap.typescript === 'absent') {
      if (found.length > 0) {
        const where = found
          .map((name) => {
            const at = exportedByName.get(classifyName(name).lookup);
            return at === undefined ? name : `${name} (${at.module}, ${at.file})`;
          })
          .join('; ');
        findings.push({
          code: 'E-CLAIMED-ABSENT',
          subject: cap.id,
          message: `ledger records typescript = "absent", but the surface exports ${where}`,
        });
      }
      continue;
    }

    if (checkable === 0) {
      // A capability whose names all failed to resolve is already an E-NAME-UNRESOLVED
      // finding. Listing it here as well would read as a second, softer problem.
      if (unresolved === 0) unverifiable.set(cap.id, skipped);
      continue;
    }

    if (found.length === 0) {
      findings.push({
        code: 'E-MISSING',
        subject: cap.id,
        message:
          `ledger records typescript = "${cap.typescript}", but none of its names is exported: ` +
          missing.join(', '),
      });
    }
  }

  // ---- Direction two: does the ledger cover everything the code exports? ----

  // One TypeScript name can carry several concepts: `IdfObject` is both "the object class"
  // and the register's "acronym casing" convention entry. The name is unclaimed only when
  // no capability claims ANY of them, so the mapping is one to many.
  /** @type {Map<string, RegisterEntry[]>} */
  const registerByTypeScriptName = new Map();
  for (const entry of register.values()) {
    const { kind, lookup } = classifyName(entry.typescript);
    if (kind !== 'identifier' && kind !== 'member') continue;
    const bucket = registerByTypeScriptName.get(lookup);
    if (bucket === undefined) registerByTypeScriptName.set(lookup, [entry]);
    else bucket.push(entry);
  }

  /** @type {ExportedName[]} */
  const outsideTheRegister = [];

  for (const exported of surface.names) {
    const entries = registerByTypeScriptName.get(exported.name);
    if (entries === undefined) {
      // Not in the naming register at all. That is the naming gate's finding, not this
      // one, and reporting it here would give one defect two red gates.
      outsideTheRegister.push(exported);
      continue;
    }
    if (entries.some((entry) => capabilityByConcept.has(entry.concept))) continue;
    findings.push({
      code: 'E-UNREGISTERED',
      subject: exported.name,
      message:
        `exported from ${exported.module} (${exported.file}) as register concept ` +
        `${entries.map((entry) => `"${entry.concept}"`).join(' / ')}, ` +
        'which no capability in the ledger claims',
    });
  }

  // ---- Report ----

  const out = [];
  out.push('idfkit-js parity gate');
  if (governance.overridden) {
    out.push('');
    out.push('  !! GOVERNANCE PIN OVERRIDDEN !!');
    out.push(`  Reading a working tree, not ${governance.pin}. Never do this in CI.`);
    out.push('');
  }
  out.push(`  ledger      ${governance.origin}`);
  out.push(`  pin         ${governance.pin} (packages/core/package.json)`);
  out.push(`  modules     ${surface.modules.join(', ')}`);
  out.push(`  exports     ${surface.names.length} names`);
  out.push(`  ledger size ${ledger.length} ${ledger.length === 1 ? 'capability' : 'capabilities'}`);

  const count = (predicate) => ledger.filter(predicate).length;
  out.push('');
  out.push(
    '  TypeScript  ' + STATES.map((s) => `${s} ${count((c) => c.typescript === s)}`).join(', ')
  );
  out.push('  Python      ' + STATES.map((s) => `${s} ${count((c) => c.python === s)}`).join(', '));
  out.push('  tiers       ' + TIERS.map((t) => `${t} ${count((c) => c.tier === t)}`).join(', '));

  if (unverifiable.size > 0) {
    out.push('');
    out.push(
      `  ${unverifiable.size} ${unverifiable.size === 1 ? 'capability has' : 'capabilities have'} ` +
        'no statically checkable TypeScript name:'
    );
    for (const [id, reasons] of [...unverifiable].sort()) {
      out.push(`    ${id}: ${reasons.length === 0 ? 'no names' : reasons.join(', ')}`);
    }
  }

  if (outsideTheRegister.length > 0) {
    out.push('');
    out.push(
      `  ${outsideTheRegister.length} exported ${outsideTheRegister.length === 1 ? 'name resolves' : 'names resolve'} ` +
        'to no register concept. That is the naming gate, not this one.'
    );
    if (verbose) {
      for (const exported of outsideTheRegister) {
        out.push(`    ${exported.name} (${exported.module}, ${exported.file})`);
      }
    } else {
      out.push('    Run with --verbose to list them.');
    }
  }

  out.push('');
  if (findings.length === 0) {
    out.push('  PASS: the ledger and the exported capability set agree.');
    process.stdout.write(out.join('\n') + '\n');
    return EXIT_OK;
  }

  const order = [
    'E-SCHEMA',
    'E-UNREGISTERED',
    'E-MISSING',
    'E-CLAIMED-ABSENT',
    'E-PARTIAL-NO-DIFF',
    'E-NOTYET-NO-ISSUE',
    'E-NEVER-NO-NOTE',
    'E-ABSENCE-KIND',
    'E-NAME-UNRESOLVED',
  ];
  findings.sort(
    (a, b) => order.indexOf(a.code) - order.indexOf(b.code) || a.subject.localeCompare(b.subject)
  );

  out.push(`  FAIL: ${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}.`);
  let lastCode = '';
  for (const finding of findings) {
    if (finding.code !== lastCode) {
      out.push('');
      lastCode = finding.code;
    }
    out.push(`  ${finding.code}  ${finding.subject}: ${finding.message}`);
  }
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
  return EXIT_FINDINGS;
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof CannotRun) {
    process.stderr.write(`check-parity-ledger: cannot run.\n${error.message}\n`);
    process.exitCode = EXIT_CANNOT_RUN;
  } else {
    throw error;
  }
}
