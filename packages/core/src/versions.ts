/** Numeric sort key. Plain string sort puts 8.9.0 after 22.1.0. */
export function versionKey(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return major * 1_000_000 + minor * 1_000 + patch;
}

/** Compare two version strings. */
export function compareVersions(a: string, b: string): number {
  return versionKey(a) - versionKey(b);
}

/**
 * Pick the bundled schema version to use for a version read from a file.
 *
 * IDF files write `Version, 9.0;` while schemas are keyed `9.0.1`, so an exact
 * match often fails on the patch component. Matching on major.minor first is
 * what makes "support every version" actually work against real files rather
 * than only against files whose patch number happens to line up.
 *
 * Returns undefined rather than guessing when there is no match at all;
 * silently loading the wrong schema would mis-map every positional field.
 */
export function resolveVersion(detected: string, available: readonly string[]): string | undefined {
  if (available.includes(detected)) return detected;

  const [major, minor] = detected.split('.').map(Number);
  const sameMinor = available.filter((candidate) => {
    const [cMajor, cMinor] = candidate.split('.').map(Number);
    return cMajor === major && cMinor === minor;
  });
  if (sameMinor.length > 0) {
    return sameMinor.sort(compareVersions).at(-1);
  }
  return undefined;
}
