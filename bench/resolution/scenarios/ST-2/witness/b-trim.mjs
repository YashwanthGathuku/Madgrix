// Witness for b-trim (ST-2): Add a trim option that removes surrounding whitespace from the input first.
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

ok(m('  fooBar ', {trim: true}) === 'foo_bar', "input is trimmed");

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}
