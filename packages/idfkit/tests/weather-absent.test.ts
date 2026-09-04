/**
 * `idfkit/weather` with the optional peer absent (T091, T091a; FR-074, FR-089).
 *
 * @idfkit/weather is an optional peer dependency, so `npm install idfkit` does
 * not install it and this subpath can always be imported with nothing behind
 * it. FR-074 says that failure must name the component to install rather than
 * surface as a bare unresolved-module error.
 *
 * The failure is Node's module resolver, so these tests do not import anything:
 * they build a small node_modules tree in a temporary directory, run a real
 * `node` in it, and read what came out. Two things follow from that. The tree is
 * built under the system temp directory rather than inside the repository,
 * because Node's resolver walks `node_modules` upwards and this repository has
 * @idfkit/weather in its own: run it here and the peer would always be found.
 * And nothing is built first: the facade's files are hand-written re-exports, so
 * the test works on a clean checkout, which is what the `test` CI job is.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const FACADE = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

/** The install the failure has to name. */
const INSTALL = 'npm install @idfkit/weather';

let root: string;

/** Run node in the fixture tree and return everything it said, plus its status. */
function run(script: string): { status: number; output: string } {
  const path = join(root, 'run.mjs');
  writeFileSync(path, script);
  try {
    const stdout = execFileSync(process.execPath, [path], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

beforeAll(() => {
  // Outside the repository on purpose: Node's resolver walks upwards, and
  // @idfkit/weather is installed here.
  root = mkdtempSync(join(tmpdir(), 'idfkit-facade-'));

  const installed = join(root, 'node_modules', 'idfkit');
  mkdirSync(installed, { recursive: true });
  for (const file of ['package.json', 'weather.js', 'weather.d.ts']) {
    cpSync(join(FACADE, file), join(installed, file));
  }

  // A library built on the shared name that needs weather and never declares
  // it: the transitive case of FR-089.
  const intermediary = join(root, 'node_modules', 'weather-report');
  mkdirSync(intermediary, { recursive: true });
  writeFileSync(
    join(intermediary, 'package.json'),
    JSON.stringify({
      name: 'weather-report',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
      dependencies: { idfkit: '0.0.0' },
    })
  );
  writeFileSync(
    join(intermediary, 'index.js'),
    "export { indexFromData } from 'idfkit/weather';\n"
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('idfkit/weather without the optional peer', () => {
  it('names the install rather than failing to resolve a module (FR-074)', () => {
    const { status, output } = run("import 'idfkit/weather';\n");

    expect(status).not.toBe(0);
    expect(output).toContain(INSTALL);
    expect(output).toContain('@idfkit/weather');

    // The thrown error is ours, not the resolver's. The resolver's is kept as
    // the `cause`, which is why it still appears further down the output.
    const thrown = output.slice(output.indexOf('Error:'));
    expect(thrown.startsWith('Error: idfkit/weather requires the optional component')).toBe(true);
  });

  it('names the install through a dynamic import too', () => {
    const { status, output } = run(
      "await import('idfkit/weather').catch((error) => { console.log(error.message); process.exit(3); });\n"
    );

    expect(status).toBe(3);
    expect(output).toContain(INSTALL);
  });

  it('names the component when a dependency needed it and did not declare it (FR-089)', () => {
    // The application never mentions weather. weather-report does, and forgot
    // to declare @idfkit/weather, so this is the message the application sees.
    const { status, output } = run("import 'weather-report';\n");

    expect(status).not.toBe(0);
    expect(output).toContain(INSTALL);
  });

  it('does not fire when the peer is there, and binds to the peer (FR-089, T091a)', () => {
    // The fix for the case above: the dependency declares the component it
    // needs. A stub stands in for @idfkit/weather; what matters is that the
    // guard steps aside and the re-exported names bind to the installed
    // package rather than to anything of the facade's own.
    const peer = join(root, 'node_modules', '@idfkit', 'weather');
    mkdirSync(peer, { recursive: true });
    writeFileSync(
      join(peer, 'package.json'),
      JSON.stringify({
        name: '@idfkit/weather',
        version: '0.0.0',
        type: 'module',
        exports: './index.js',
      })
    );
    writeFileSync(
      join(peer, 'index.js'),
      "export const StationIndex = 'from the peer';\nexport const indexFromData = () => 'from the peer';\n"
    );

    const { status, output } = run(
      "import { StationIndex } from 'idfkit/weather';\n" +
        "import { indexFromData } from 'weather-report';\n" +
        'console.log(StationIndex, indexFromData());\n'
    );

    expect(status).toBe(0);
    expect(output.trim()).toBe('from the peer from the peer');
    expect(output).not.toContain(INSTALL);

    rmSync(join(root, 'node_modules', '@idfkit'), { recursive: true, force: true });
  });
});
