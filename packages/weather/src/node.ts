/**
 * Node-only conveniences for `@idfkit/weather`.
 *
 * The async edge that touches disk. The portable surface fetches over the
 * network and returns text; this adds the two things a browser cannot do —
 * load the index shipped inside the package without any network call, and
 * write downloaded weather files to disk.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import type { WeatherFiles } from './download.js';
import { indexFromData, type IndexData } from './load.js';
import { StationIndex } from './station-index.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

/**
 * Load the station index bundled inside this package (`data/stations.json.gz`)
 * from disk. No network access — the Node counterpart to Python's
 * `StationIndex.load()`.
 *
 * @param path - Override the path to a `stations.json.gz` file.
 */
export async function loadBundledIndex(
  path: string = join(DATA_DIR, 'stations.json.gz')
): Promise<StationIndex> {
  const gz = await readFile(path);
  const json = gunzipSync(gz).toString('utf-8');
  return indexFromData(JSON.parse(json) as IndexData);
}

/** Where {@link saveWeatherFiles} wrote each file. `null` when the file was absent. */
export interface SavedWeatherFiles {
  epw: string;
  ddy: string | null;
  stat: string | null;
}

/** Options for {@link saveWeatherFiles}. */
export interface SaveWeatherFilesOptions {
  /** Basename (without extension) for the written files. Defaults to the station's filename stem. */
  stem?: string;
}

/**
 * Write downloaded weather files to a directory and return the paths.
 *
 * Files are written Latin-1, the encoding EPW uses, matching how
 * `@idfkit/core/node` reads and writes IDF. The directory is created if needed.
 */
export async function saveWeatherFiles(
  files: WeatherFiles,
  directory: string,
  options: SaveWeatherFilesOptions = {}
): Promise<SavedWeatherFiles> {
  await mkdir(directory, { recursive: true });
  const stem = options.stem ?? files.station.filenameStem;

  const epwPath = join(directory, `${stem}.epw`);
  await writeFile(epwPath, files.epw, 'latin1');

  let ddyPath: string | null = null;
  if (files.ddy !== null) {
    ddyPath = join(directory, `${stem}.ddy`);
    await writeFile(ddyPath, files.ddy, 'latin1');
  }

  let statPath: string | null = null;
  if (files.stat !== null) {
    statPath = join(directory, `${stem}.stat`);
    await writeFile(statPath, files.stat, 'latin1');
  }

  return { epw: epwPath, ddy: ddyPath, stat: statPath };
}
