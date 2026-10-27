// Held-out acceptance test for SEM-2: One agent changes the default separator; another adds a snake_case helper that relies on it
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

ok(m('fooBar') === 'foo-bar', "default separator");
ok((await load('snake.js')).default('fooBar') === 'foo_bar', "snake case");

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}
