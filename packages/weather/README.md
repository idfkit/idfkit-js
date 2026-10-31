<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/idfkit/idfkit-brand/identity-2026.2/marks/mark-on-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/idfkit/idfkit-brand/identity-2026.2/marks/mark-on-light.svg">
    <img alt="idfkit" width="72" src="https://raw.githubusercontent.com/idfkit/idfkit-brand/identity-2026.2/marks/tile.png">
  </picture>
</p>

# @idfkit/weather

Browser-side EPW weather-file retrieval for EnergyPlus, from the climate.onebuilding.org TMYx index.

[idfkit](https://idfkit.com) · [Developers](https://developers.idfkit.com) · [EnergyPlus docs](https://docs.idfkit.com) · [Envelop](https://app.idfkit.com) · [MCP](https://mcp.idfkit.com) · [Shoebox](https://shoebox.idfkit.com) · [GitHub](https://github.com/idfkit)

Search the climate.onebuilding.org TMYx station index, then download and unpack EPW, DDY and STAT
files. The package has no filesystem access and no dependencies, so it runs in Node, a browser, a
worker or an edge runtime.

**[Documentation](https://developers.idfkit.com/weather/)** ·
[API reference](https://developers.idfkit.com/reference/typescript/weather/)

```bash
npm install @idfkit/weather
```

```ts
import { fetchWeatherFiles, loadStationIndex } from '@idfkit/weather';

const index = await loadStationIndex();
const [match] = index.search('Chicago');
const files = await fetchWeatherFiles(match.station);
```

climate.onebuilding.org sends no CORS header, so a page routes its requests through its own proxy
with the `rewriteUrl`, `baseUrl` or `fetch` options. Node-only conveniences, the bundled index and
writing files to disk, are in `@idfkit/weather/node`.

## License

MIT.
