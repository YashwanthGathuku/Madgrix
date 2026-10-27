// Held-out acceptance test for CTRL-1: One agent documents the count; another adds a helper that passes its count explicitly
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

ok(throwsWith(() => m('a', -2), RangeError, /a negative number/), "message");
ok((await load('once.js')).default('a\nb') === ' a\n b', "indentOnce");
ok(m('a', 2) === '  a', "baseline");

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}
