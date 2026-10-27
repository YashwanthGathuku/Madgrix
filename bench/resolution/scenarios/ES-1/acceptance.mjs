// Held-out acceptance test for ES-1: Two agents each add an escape to the same replace chain
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

ok(m('a/b') === 'a\\/b', "slash");
ok(m('\0') === '\\x00', "NUL");
ok(m('a.b-c') === 'a\\.b\\x2dc', "baseline: dot and dash");
ok(new RegExp(m('a/b-c\0.d'), 'u').test('a/b-c\0.d'), "result is a valid unicode pattern that matches the input");
ok(read('index.d.ts').includes('regular expression literal'), "a-slash's type note survives");
ok(has('CHANGELOG.md') && read('CHANGELOG.md').includes('NUL'), "b-nul's changelog survives");

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}
