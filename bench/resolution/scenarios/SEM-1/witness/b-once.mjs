// Witness for b-once (SEM-1): Add indentOnce(string, options) in once.js, which indents every line exactly once.
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

ok((await load('once.js')).default('a\nb') === ' a\n b', "indentOnce indents once");

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}
