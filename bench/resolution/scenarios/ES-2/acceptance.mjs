// Held-out acceptance test for ES-2: One agent widens the accepted input; another rewrites the error it raises
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const load = async (file) => import(pathToFileURL(path.join(root, file)).href);
const read = (file) => readFileSync(path.join(root, file), "utf8");
const has = (file) => existsSync(path.join(root, file));
const throwsWith = (fn, type, pattern) => {
	try {
		fn();
		return false;
	} catch (error) {
		return error instanceof type && (!pattern || pattern.test(error.message));
	}
};
const failures = [];
const ok = (value, label) => {
	if (!value) failures.push(label);
};
const m = (await load("index.js")).default;

ok(m(12.5) === '12\\.5', "number");
ok(throwsWith(() => m(null), TypeError, /got object/), "message names the type");
ok(m('a.b') === 'a\\.b', "baseline");
ok(read('index.d.ts').includes('names the received type'), "a-message's type note survives");
ok(has('CHANGELOG.md') && read('CHANGELOG.md').includes('numbers'), "b-number's changelog survives");

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}
