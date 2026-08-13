# How to fetch a weather file

This guide shows you how to find a weather station and pull its EPW file into a
model run, using [`@idfkit/weather`](../reference/weather.md). It assumes you
already have a model in hand and want a matching weather file — by city name, by
coordinate, or by its canonical EPW filename.

The weather files come from the [climate.onebuilding.org](https://climate.onebuilding.org)
TMYx set: ~70,000 dataset entries covering ~17,300 stations worldwide, indexed
once and shipped inside the package.

```bash
npm install @idfkit/weather
```

## Load the station index

The index is a searchable, in-memory snapshot. How you load it depends on where
your code runs.

In Node, read the bundled copy straight off disk — no network:

```ts
import { loadBundledIndex } from '@idfkit/weather/node';

const index = await loadBundledIndex();
```

In the browser, there is no filesystem, so serve the shipped index from your own
origin and fetch it:

```bash
cp node_modules/@idfkit/weather/data/stations.json.gz public/
```

```ts
import { loadStationIndex } from '@idfkit/weather';

const index = await loadStationIndex('/stations.json.gz');
```

`loadStationIndex` inflates the gzip itself, so it works whether or not your host
sets `Content-Encoding: gzip`. The payload is ~1.7 MB; load it once and keep the
index for the lifetime of the page.

## Find a station

Pick whichever entry point matches what you know.

Search by name — results come back scored, best first:

```ts
const [best] = index.search('chicago ohare');
const station = best.station;
```

Search near a coordinate, closest first:

```ts
const [nearest] = index.nearest(41.98, -87.9, { maxDistanceKm: 50 });
```

If you have an address rather than a coordinate, geocode it and spread the
result straight into `nearest`:

```ts
import { geocode } from '@idfkit/weather';

const results = index.nearest(...(await geocode('350 Fifth Avenue, New York')));
```

`geocode` uses the free Nominatim service and is rate-limited to one request per
second. For "stations near me", `detectLocation()` resolves the caller's public
IP the same way. Both send data to a third-party service — pass explicit
coordinates instead if that is a concern.

When you already know the exact EPW filename, resolve it directly:

```ts
const [match] = index.getByFilename('USA_IL_Chicago.OHare.Intl.AP.725300_TMYx.2009-2023.epw');
```

For the full list of search, lookup, and filter options, see the
[`StationIndex` reference](../reference/weather.md).

## Download the EPW

`fetchEpw` downloads the station's archive, unpacks it in memory, and returns the
EPW file as text — the exact value `@idfkit/engine` wants:

```ts
import { fetchEpw } from '@idfkit/weather';

const epw = await fetchEpw(station);
```

To keep the design-day and statistics files too, use `fetchWeatherFiles`, which
returns `epw`, `ddy`, and `stat` as text (plus every other archive member as raw
bytes):

```ts
import { fetchWeatherFiles } from '@idfkit/weather';

const files = await fetchWeatherFiles(station);
console.log(files.ddy, files.stat);
```

### Work around CORS in the browser

climate.onebuilding.org serves no `Access-Control-Allow-Origin` header, so a
direct fetch from a web page is blocked by the browser's same-origin policy.
Node and workers are unaffected; a page needs a proxy you control. Point
`rewriteUrl` at it:

```ts
const epw = await fetchEpw(station, {
  rewriteUrl: (url) => `https://your-proxy.example/?url=${encodeURIComponent(url)}`,
});
```

Any forwarding proxy that adds the CORS header works; `rewriteUrl` only changes
the URL that gets fetched. Pass your own `fetch` instead if you need to add
headers or authentication.

## Hand it to the engine

The EPW text drops straight into a simulation. See
[How to run a simulation](run-a-simulation.md) for the engine setup:

```ts
import { writeIdf } from '@idfkit/core';
import { createEnergyPlus } from '@idfkit/engine';

const ep = await createEnergyPlus({ assetBaseUrl: '/energyplus' });
const result = await ep.run({ idf: writeIdf(document), epw });
ep.dispose();
```

## Keep the index current

The bundled index is a snapshot taken when the package was built. To rebuild from
the live upstream KML files — in Node, or in the browser through a CORS proxy —
call `refreshStationIndex`:

```ts
import { checkForUpdates, refreshStationIndex } from '@idfkit/weather';

if (await checkForUpdates(index)) {
  index = await refreshStationIndex();
}
```

`refreshStationIndex` downloads and parses the ten regional indexes, so it is far
slower than `loadStationIndex`. Most applications never need it — the bundled
snapshot is enough.

## Related

- [`@idfkit/weather` reference](../reference/weather.md) — every option on
  `StationIndex`, `fetchWeatherFiles`, and the rest.
- [How to run a simulation](run-a-simulation.md) — where the EPW text goes next.
- [Parity with the Python library](../explanation/parity.md) — what this package
  ports and what it deliberately leaves out.
