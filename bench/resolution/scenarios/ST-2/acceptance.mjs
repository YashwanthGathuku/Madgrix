// Held-out acceptance test for ST-2: Two new options meet only in the option list
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

ok(m('fooBarBaz', {maxLength: 7}) === 'foo_bar', "maxLength");
ok(m('  fooBar ', {trim: true}) === 'foo_bar', "trim");
ok(m('  fooBarBaz ', {trim: true, maxLength: 7}) === 'foo_bar', "both");
ok(m('  fooBar ') === '  foo_bar ', "baseline: no trim by default");
ok(read('index.d.ts').includes('maxLength'), "a-limit's type declaration survives");
ok(has('CHANGELOG.md') && read('CHANGELOG.md').includes('trim'), "b-trim's changelog survives");

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}
