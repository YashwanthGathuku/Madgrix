// Witness for sub-ui ("Change the UI view and name the contract ui").
// Runs with the tree under test as its working directory; exit 0 = intent present.
import path from "node:path";
import { pathToFileURL } from "node:url";

const load = (file) => import(pathToFileURL(path.join(process.cwd(), file)).href);
const { label } = await load("src/contract.js");
const { view } = await load("src/ui/view.js");
if (!String(label).split("+").includes("ui")) process.exit(1);
if (view() !== "ui") process.exit(1);
