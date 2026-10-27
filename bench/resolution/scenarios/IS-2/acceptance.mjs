// Held-out acceptance test for IS-2: Two agents rewrite the same count validation with different policies
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

ok(throwsWith(() => m('a', 1.5), RangeError), "fractional count throws");
ok(m('a', -1) === 'a', "negative count is 0");
ok(m('a', 2) === '  a', "baseline: count 2");
ok(throwsWith(() => m('a', '2'), TypeError), "baseline: string count throws");
ok(read('index.d.ts').includes('Must be an integer.'), "a-integer's type note survives");
ok(has('CHANGELOG.md') && read('CHANGELOG.md').includes('negative'), "b-clamp's changelog survives");

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}
