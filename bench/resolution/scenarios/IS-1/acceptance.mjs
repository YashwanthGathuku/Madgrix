// Held-out acceptance test for IS-1: Two new options change the same option list and the same return line
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
ok(m('a\nb', 2, {prefix: '#'}) === '#  a\n#  b', "prefix");
ok(m('a  \nb', 1, {prefix: '#', trimTrailing: true}) === '# a\n# b', "both options together");
ok(m('a\n\nb', 2) === '  a\n\n  b', "baseline: empty lines stay empty");
ok(m('a', 0) === 'a', "baseline: count 0");
ok(throwsWith(() => m('a', -1), RangeError), "baseline: negative count throws");
ok(read('index.d.ts').includes('trimTrailing'), "a-trim's type declaration survives");
ok(has('CHANGELOG.md') && read('CHANGELOG.md').includes('prefix'), "b-prefix's changelog survives");

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}
