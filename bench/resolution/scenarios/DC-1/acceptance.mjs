// Held-out acceptance test for DC-1: Two agents insert different input checks at the same place
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

ok(m('  fooBar ') === 'foo_bar', "trim");
ok(throwsWith(() => m('fooBar', {separator: ''}), TypeError), "empty separator");
ok(m('fooBar', {separator: '-'}) === 'foo-bar', "baseline: separator");
ok(m('testGUILabel', {preserveConsecutiveUppercase: true}) === 'test_GUI_label', "baseline: preserve");
ok(read('index.d.ts').includes('Surrounding whitespace is removed.'), "a-trim's type note survives");
ok(has('CHANGELOG.md') && read('CHANGELOG.md').includes('empty separator'), "b's changelog survives");

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}
