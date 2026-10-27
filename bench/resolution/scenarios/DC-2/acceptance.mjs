// Held-out acceptance test for DC-2: Two new options change the option list and every return
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

ok(m('fooBar', {prefix: 'x_'}) === 'x_foo_bar', "prefix");
ok(m('fooBar', {suffix: '_y'}) === 'foo_bar_y', "suffix");
ok(m('fooBar', {prefix: 'x_', suffix: '_y'}) === 'x_foo_bar_y', "both");
ok(m('A', {prefix: 'p', suffix: 's'}) === 'pas', "single character path");
ok(m('dataForUSACounties', {preserveConsecutiveUppercase: true, prefix: 'p_'}) === 'p_data_for_USA_counties', "preserve path");
ok(read('index.d.ts').includes('readonly prefix'), "a-prefix's type declaration survives");
ok(has('CHANGELOG.md') && read('CHANGELOG.md').includes('suffix'), "b-suffix's changelog survives");

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}
