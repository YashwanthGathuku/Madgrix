import decamelize from './index.js';

export default function toSnakeCase(text) {
	return decamelize(text, {separator: '_'});
}
