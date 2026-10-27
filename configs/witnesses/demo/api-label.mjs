// Witness for sub-api ("Change the API handler and name the contract api").
// Runs with the tree under test as its working directory; exit 0 = intent present.
import path from "node:path";
import { pathToFileURL } from "node:url";

const load = (file) => import(pathToFileURL(path.join(process.cwd(), file)).href);
const { label } = await load("src/contract.js");
const { handler } = await load("src/api/handler.js");
if (!String(label).split("+").includes("api")) process.exit(1);
if (handler() !== "api") process.exit(1);
