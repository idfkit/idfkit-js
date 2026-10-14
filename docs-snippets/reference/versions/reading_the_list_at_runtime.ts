// --8<-- [start:example]
import { schemas } from '@idfkit/core/node';

const bundle = schemas();
(await bundle.versions()).length; // 18
await bundle.latest(); // '26.2.0'
// --8<-- [end:example]
