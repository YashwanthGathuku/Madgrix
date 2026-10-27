export default function indentString(string, count = 1, options = {}) {
	const {
		indent = ' ',
		includeEmptyLines = false,
		strict = false,
	} = options;

	if (typeof string !== 'string') {
		throw new TypeError(
			`Expected \`input\` to be a \`string\`, got \`${typeof string}\``
		);
	}

	if (typeof count !== 'number') {
		throw new TypeError(
			`Expected \`count\` to be a \`number\`, got \`${typeof count}\``
		);
	}

	if (count < 0) {
		throw new RangeError(
			`Expected \`count\` to be at least 0, got \`${count}\``
		);
	}

	if (typeof indent !== 'string') {
		throw new TypeError(
			`Expected \`options.indent\` to be a \`string\`, got \`${typeof indent}\``
		);
	}

	if (count === 0) {
		if (strict) {
			throw new RangeError('A `count` of 0 is not allowed in strict mode');
		}

		return string;
	}

	const regex = includeEmptyLines ? /^/gm : /^(?!\s*$)/gm;

	return string.replace(regex, indent.repeat(count));
}
