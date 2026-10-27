// Held-out acceptance test for ST-1: Two new options meet only in the option list
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

ok(m('a  \nb', 1, {trimTrailing: true}) === ' a\n b', "trimTrailing");
ok(throwsWith(() => m('a', 0, {strict: true}), RangeError), "strict");
ok(m('a', 0) === 'a', "baseline: count 0 without strict");
ok(m('a  ', 1, {strict: true, trimTrailing: true}) === ' a', "both options together");
ok(read('index.d.ts').includes('trimTrailing'), "a-trim's type declaration survives");
ok(has('CHANGELOG.md') && read('CHANGELOG.md').includes('strict'), "b-strict's changelog survives");

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}
