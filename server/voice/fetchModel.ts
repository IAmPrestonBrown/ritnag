// `npm run voice:model` — download the speaker model ahead of time (e.g. before venue wifi).
import { resolve } from "node:path";
import { ensureModel } from "./sherpa";

const path = await ensureModel(resolve(import.meta.dirname, "../../data/models"));
console.log(`voice model ready: ${path}`);
