#!/usr/bin/env python3
"""
Build the governed-resolution benchmark scenarios from the vendored upstream
packages (bench/resolution/upstream, MIT; see SOURCES.md).

Each scenario is two agents editing a real package with stated intents. For
every scenario this writes, under scenarios/<ID>/:

  scenario.json          id, kind, package, agents (id, intent, role scope, files)
  <agent>/<file>         the full file each agent writes
  reference/<file>       the resolved conflicted files a careful developer writes
  witness/<agent>.mjs    the agent's witness: checks its own intent only
  acceptance.mjs         the held-out acceptance test: both intents, both agents'
                         clean work, and baseline behaviour

Every edit is an exact substring replacement that must match exactly once, so
a changed upstream file fails loudly instead of building a different scenario.

Kinds:
  textual     the agents change the same lines; git reports a conflict
  list        git reports a conflict, but the only overlap is two additions
              to the same option list (a case union merge and syntax-aware
              merge are meant to handle)
  semantic    git merges the text cleanly, but the merged behaviour is wrong
  control     git merges the text cleanly and the merged behaviour is right
"""
import json
import pathlib
import shutil

HERE = pathlib.Path(__file__).resolve().parent
UPSTREAM = HERE / "upstream"
OUT = HERE / "scenarios"

PRELUDE = """import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const load = async (file) => import(pathToFileURL(path.join(root, file)).href);
const read = (file) => readFileSync(path.join(root, file), "utf8");
const has = (file) => existsSync(path.join(root, file));
const throwsWith = (fn, type, pattern) => {
\ttry {
\t\tfn();
\t\treturn false;
\t} catch (error) {
\t\treturn error instanceof type && (!pattern || pattern.test(error.message));
\t}
};
const failures = [];
const ok = (value, label) => {
\tif (!value) failures.push(label);
};
const m = (await load("index.js")).default;
"""

EPILOGUE = """
if (failures.length > 0) {
\tconsole.error(failures.join("\\n"));
\tprocess.exit(1);
}
"""


def script(comment, checks):
    lines = [f"// {comment}", PRELUDE]
    for expr, label in checks:
        lines.append(f"ok({expr}, {json.dumps(label)});")
    lines.append(EPILOGUE)
    return "\n".join(lines)


def edit(text, pairs, where):
    for old, new in pairs:
        count = text.count(old)
        assert count == 1, f"{where}: expected one match, found {count}: {old[:60]!r}"
        text = text.replace(old, new)
    return text


def base(pkg, name):
    return (UPSTREAM / pkg / name).read_text()


SCENARIOS = []


def scenario(**kw):
    SCENARIOS.append(kw)


# ---------------------------------------------------------------- indent-string
IS_DESTRUCT = "\t\tincludeEmptyLines = false\n\t} = options;"
IS_RETURN = "\treturn string.replace(regex, indent.repeat(count));"
IS_DTS_END = "\treadonly includeEmptyLines?: boolean;\n}"
IS_RANGE = (
    "\tif (count < 0) {\n\t\tthrow new RangeError(\n"
    "\t\t\t`Expected \\`count\\` to be at least 0, got \\`${count}\\``\n\t\t);\n\t}"
)
IS_ZERO = "\tif (count === 0) {\n\t\treturn string;\n\t}"
TRIM_DTS = (
    "\treadonly includeEmptyLines?: boolean;\n\n\t/**\n\tRemove trailing whitespace from every line.\n\n"
    "\t@default false\n\t*/\n\treadonly trimTrailing?: boolean;\n}"
)
TRIM_RETURN = (
    "\tconst result = string.replace(regex, indent.repeat(count));\n"
    "\treturn trimTrailing ? result.replace(/[ \\t]+$/gm, '') : result;"
)

scenario(
    id="IS-1",
    kind="textual",
    package="indent-string",
    title="Two new options change the same option list and the same return line",
    agents=[
        dict(
            id="a-trim",
            intent="Add a trimTrailing option that removes trailing whitespace from every line of the result.",
            files={
                "index.js": [(IS_DESTRUCT, "\t\tincludeEmptyLines = false,\n\t\ttrimTrailing = false,\n\t} = options;"), (IS_RETURN, TRIM_RETURN)],
                "index.d.ts": [(IS_DTS_END, TRIM_DTS)],
            },
            witness=[("m('a  \\nb', 1, {trimTrailing: true}) === ' a\\n b'", "trimTrailing strips trailing spaces")],
        ),
        dict(
            id="b-prefix",
            intent="Add a prefix option that is written before the indentation of every indented line.",
            files={
                "index.js": [
                    (IS_DESTRUCT, "\t\tincludeEmptyLines = false,\n\t\tprefix = '',\n\t} = options;"),
                    (IS_RETURN, "\treturn string.replace(regex, prefix + indent.repeat(count));"),
                ],
            },
            add={"CHANGELOG.md": "# Changelog\n\n- Add the `prefix` option.\n"},
            witness=[("m('a\\nb', 2, {prefix: '#'}) === '#  a\\n#  b'", "prefix precedes the indent")],
        ),
    ],
    reference={
        "index.js": [
            (IS_DESTRUCT, "\t\tincludeEmptyLines = false,\n\t\ttrimTrailing = false,\n\t\tprefix = '',\n\t} = options;"),
            (
                IS_RETURN,
                "\tconst result = string.replace(regex, prefix + indent.repeat(count));\n"
                "\treturn trimTrailing ? result.replace(/[ \\t]+$/gm, '') : result;",
            ),
        ]
    },
    acceptance=[
        ("m('a  \\nb', 1, {trimTrailing: true}) === ' a\\n b'", "trimTrailing"),
        ("m('a\\nb', 2, {prefix: '#'}) === '#  a\\n#  b'", "prefix"),
        ("m('a  \\nb', 1, {prefix: '#', trimTrailing: true}) === '# a\\n# b'", "both options together"),
        ("m('a\\n\\nb', 2) === '  a\\n\\n  b'", "baseline: empty lines stay empty"),
        ("m('a', 0) === 'a'", "baseline: count 0"),
        ("throwsWith(() => m('a', -1), RangeError)", "baseline: negative count throws"),
        ("read('index.d.ts').includes('trimTrailing')", "a-trim's type declaration survives"),
        ("has('CHANGELOG.md') && read('CHANGELOG.md').includes('prefix')", "b-prefix's changelog survives"),
    ],
)

scenario(
    id="IS-2",
    kind="textual",
    package="indent-string",
    title="Two agents rewrite the same count validation with different policies",
    agents=[
        dict(
            id="a-integer",
            intent="Reject a count that is not an integer with a RangeError.",
            files={
                "index.js": [
                    (
                        IS_RANGE,
                        "\tif (count < 0 || !Number.isInteger(count)) {\n\t\tthrow new RangeError(\n"
                        "\t\t\t`Expected \\`count\\` to be a non-negative integer, got \\`${count}\\``\n\t\t);\n\t}",
                    )
                ],
                "index.d.ts": [("repeated. Default: `1`.", "repeated. Default: `1`. Must be an integer.")],
            },
            witness=[("throwsWith(() => m('a', 1.5), RangeError)", "a fractional count throws")],
        ),
        dict(
            id="b-clamp",
            intent="Treat a negative count as 0 instead of throwing.",
            files={"index.js": [(IS_RANGE, "\tif (count < 0) {\n\t\tcount = 0;\n\t}")]},
            add={"CHANGELOG.md": "# Changelog\n\n- A negative `count` is treated as 0.\n"},
            witness=[("m('a', -1) === 'a'", "a negative count indents nothing")],
        ),
    ],
    reference={
        "index.js": [
            (
                IS_RANGE,
                "\tif (!Number.isInteger(count)) {\n\t\tthrow new RangeError(\n"
                "\t\t\t`Expected \\`count\\` to be an integer, got \\`${count}\\``\n\t\t);\n\t}\n\n"
                "\tif (count < 0) {\n\t\tcount = 0;\n\t}",
            )
        ]
    },
    acceptance=[
        ("throwsWith(() => m('a', 1.5), RangeError)", "fractional count throws"),
        ("m('a', -1) === 'a'", "negative count is 0"),
        ("m('a', 2) === '  a'", "baseline: count 2"),
        ("throwsWith(() => m('a', '2'), TypeError)", "baseline: string count throws"),
        ("read('index.d.ts').includes('Must be an integer.')", "a-integer's type note survives"),
        ("has('CHANGELOG.md') && read('CHANGELOG.md').includes('negative')", "b-clamp's changelog survives"),
    ],
)

STRICT_ZERO = (
    "\tif (count === 0) {\n\t\tif (strict) {\n\t\t\tthrow new RangeError('A `count` of 0 is not allowed in strict mode');\n"
    "\t\t}\n\n\t\treturn string;\n\t}"
)
scenario(
    id="ST-1",
    kind="list",
    package="indent-string",
    title="Two new options meet only in the option list",
    agents=[
        dict(
            id="a-trim",
            intent="Add a trimTrailing option that removes trailing whitespace from every line of the result.",
            files={
                "index.js": [(IS_DESTRUCT, "\t\tincludeEmptyLines = false,\n\t\ttrimTrailing = false,\n\t} = options;"), (IS_RETURN, TRIM_RETURN)],
                "index.d.ts": [(IS_DTS_END, TRIM_DTS)],
            },
            witness=[("m('a  \\nb', 1, {trimTrailing: true}) === ' a\\n b'", "trimTrailing strips trailing spaces")],
        ),
        dict(
            id="b-strict",
            intent="Add a strict option: a count of 0 throws a RangeError when strict is true.",
            files={
                "index.js": [(IS_DESTRUCT, "\t\tincludeEmptyLines = false,\n\t\tstrict = false,\n\t} = options;"), (IS_ZERO, STRICT_ZERO)],
            },
            add={"CHANGELOG.md": "# Changelog\n\n- Add the `strict` option.\n"},
            witness=[("throwsWith(() => m('a', 0, {strict: true}), RangeError)", "strict rejects count 0")],
        ),
    ],
    reference={
        "index.js": [
            (IS_DESTRUCT, "\t\tincludeEmptyLines = false,\n\t\ttrimTrailing = false,\n\t\tstrict = false,\n\t} = options;"),
            (IS_ZERO, STRICT_ZERO),
            (IS_RETURN, TRIM_RETURN),
        ]
    },
    acceptance=[
        ("m('a  \\nb', 1, {trimTrailing: true}) === ' a\\n b'", "trimTrailing"),
        ("throwsWith(() => m('a', 0, {strict: true}), RangeError)", "strict"),
        ("m('a', 0) === 'a'", "baseline: count 0 without strict"),
        ("m('a  ', 1, {strict: true, trimTrailing: true}) === ' a'", "both options together"),
        ("read('index.d.ts').includes('trimTrailing')", "a-trim's type declaration survives"),
        ("has('CHANGELOG.md') && read('CHANGELOG.md').includes('strict')", "b-strict's changelog survives"),
    ],
)

scenario(
    id="SEM-1",
    kind="semantic",
    package="indent-string",
    title="One agent changes the default count; another adds a helper that relies on the old default",
    agents=[
        dict(
            id="a-default",
            intent="Indent by two by default.",
            files={
                "index.js": [("indentString(string, count = 1, options = {})", "indentString(string, count = 2, options = {})")],
                "index.d.ts": [("repeated. Default: `1`.", "repeated. Default: `2`.")],
            },
            witness=[("m('a') === '  a'", "default count is 2")],
        ),
        dict(
            id="b-once",
            intent="Add indentOnce(string, options) in once.js, which indents every line exactly once.",
            files={},
            add={
                "once.js": "import indentString from './index.js';\n\n"
                "export default function indentOnce(string, options) {\n"
                "\treturn indentString(string, undefined, options);\n}\n"
            },
            witness=[("(await load('once.js')).default('a\\nb') === ' a\\n b'", "indentOnce indents once")],
        ),
    ],
    reference=None,
    acceptance=[
        ("m('a') === '  a'", "default count is 2"),
        ("has('once.js')", "once.js exists"),
        ("(await load('once.js')).default('a\\nb') === ' a\\n b'", "indentOnce indents exactly once"),
    ],
)

scenario(
    id="CTRL-1",
    kind="control",
    package="indent-string",
    title="One agent documents the count; another adds a helper that passes its count explicitly",
    agents=[
        dict(
            id="a-docs",
            intent="Name the received value in the negative-count RangeError.",
            files={
                "index.js": [
                    (
                        "`Expected \\`count\\` to be at least 0, got \\`${count}\\``",
                        "`Expected \\`count\\` to be at least 0, got \\`${count}\\` (a negative number)`",
                    )
                ],
            },
            witness=[("throwsWith(() => m('a', -2), RangeError, /a negative number/)", "the message names a negative number")],
        ),
        dict(
            id="b-once",
            intent="Add indentOnce(string, options) in once.js, which indents every line exactly once.",
            files={},
            add={
                "once.js": "import indentString from './index.js';\n\n"
                "export default function indentOnce(string, options) {\n"
                "\treturn indentString(string, 1, options);\n}\n"
            },
            witness=[("(await load('once.js')).default('a\\nb') === ' a\\n b'", "indentOnce indents once")],
        ),
    ],
    reference=None,
    acceptance=[
        ("throwsWith(() => m('a', -2), RangeError, /a negative number/)", "message"),
        ("(await load('once.js')).default('a\\nb') === ' a\\n b'", "indentOnce"),
        ("m('a', 2) === '  a'", "baseline"),
    ],
)

# ---------------------------------------------------------- escape-string-regexp
ES_CLASS = "\t\t.replace(/[|\\\\{}()[\\]^$+*?.]/g, '\\\\$&')"
ES_DASH = "\t\t.replace(/-/g, '\\\\x2d');"
ES_IF = "\tif (typeof string !== 'string') {"
ES_THROW = "\t\tthrow new TypeError('Expected a string');"
ES_DTS = "@example"

scenario(
    id="ES-1",
    kind="textual",
    package="escape-string-regexp",
    title="Two agents each add an escape to the same replace chain",
    agents=[
        dict(
            id="a-slash",
            intent="Also escape / so the result is safe inside a regular expression literal.",
            files={
                "index.js": [(ES_CLASS, "\t\t.replace(/[|\\\\{}()[\\]^$+*?./]/g, '\\\\$&')")],
                "index.d.ts": [(ES_DTS, "A `/` is escaped too, so the result can go inside a regular expression literal.\n\n@example")],
            },
            witness=[("m('a/b') === 'a\\\\/b'", "slash is escaped")],
        ),
        dict(
            id="b-nul",
            intent="Escape NUL characters as \\x00.",
            files={"index.js": [(ES_DASH, "\t\t.replace(/-/g, '\\\\x2d')\n\t\t.replace(/\\0/g, '\\\\x00');")]},
            add={"CHANGELOG.md": "# Changelog\n\n- Escape NUL as `\\x00`.\n"},
            witness=[("m('\\0') === '\\\\x00'", "NUL is escaped")],
        ),
    ],
    reference={
        "index.js": [
            (ES_CLASS, "\t\t.replace(/[|\\\\{}()[\\]^$+*?./]/g, '\\\\$&')"),
            (ES_DASH, "\t\t.replace(/-/g, '\\\\x2d')\n\t\t.replace(/\\0/g, '\\\\x00');"),
        ]
    },
    acceptance=[
        ("m('a/b') === 'a\\\\/b'", "slash"),
        ("m('\\0') === '\\\\x00'", "NUL"),
        ("m('a.b-c') === 'a\\\\.b\\\\x2dc'", "baseline: dot and dash"),
        ("new RegExp(m('a/b-c\\0.d'), 'u').test('a/b-c\\0.d')", "result is a valid unicode pattern that matches the input"),
        ("read('index.d.ts').includes('regular expression literal')", "a-slash's type note survives"),
        ("has('CHANGELOG.md') && read('CHANGELOG.md').includes('NUL')", "b-nul's changelog survives"),
    ],
)

scenario(
    id="ES-2",
    kind="textual",
    package="escape-string-regexp",
    title="One agent widens the accepted input; another rewrites the error it raises",
    agents=[
        dict(
            id="a-message",
            intent="Name the received type in the TypeError message.",
            files={
                "index.js": [(ES_THROW, "\t\tthrow new TypeError(`Expected a string, got ${typeof string}`);")],
                "index.d.ts": [(ES_DTS, "Throws a `TypeError` that names the received type when the input is not a string.\n\n@example")],
            },
            witness=[("throwsWith(() => m(null), TypeError, /got object/)", "the message names the type")],
        ),
        dict(
            id="b-number",
            intent="Accept numbers by converting them to strings.",
            files={
                "index.js": [
                    (
                        ES_IF + "\n" + ES_THROW,
                        "\tif (typeof string === 'number') {\n\t\tstring = String(string);\n\t} else if (typeof string !== 'string') {\n"
                        "\t\tthrow new TypeError('Expected a string or a number');",
                    )
                ]
            },
            add={"CHANGELOG.md": "# Changelog\n\n- Accept numbers.\n"},
            witness=[("m(12.5) === '12\\\\.5'", "a number is converted")],
        ),
    ],
    reference={
        "index.js": [
            (
                ES_IF + "\n" + ES_THROW,
                "\tif (typeof string === 'number') {\n\t\tstring = String(string);\n\t} else if (typeof string !== 'string') {\n"
                "\t\tthrow new TypeError(`Expected a string or a number, got ${typeof string}`);",
            )
        ]
    },
    acceptance=[
        ("m(12.5) === '12\\\\.5'", "number"),
        ("throwsWith(() => m(null), TypeError, /got object/)", "message names the type"),
        ("m('a.b') === 'a\\\\.b'", "baseline"),
        ("read('index.d.ts').includes('names the received type')", "a-message's type note survives"),
        ("has('CHANGELOG.md') && read('CHANGELOG.md').includes('numbers')", "b-number's changelog survives"),
    ],
)

# ------------------------------------------------------------------- decamelize
DC_DESTRUCT = "\t\tpreserveConsecutiveUppercase = false,\n\t} = {},"
DC_AFTER_CHECK = (
    "\t\t\t'The `text` and `separator` arguments should be of type `string`',\n\t\t);\n\t}\n\n"
)
DC_EARLY = "\t\treturn preserveConsecutiveUppercase ? text : text.toLowerCase();"
DC_RET_DEC = "\t\treturn decamelized;"
DC_RET_WORDS = "\treturn words.join(separator);"
DC_DTS = "\treadonly preserveConsecutiveUppercase?: boolean;\n};"

scenario(
    id="DC-1",
    kind="textual",
    package="decamelize",
    title="Two agents insert different input checks at the same place",
    agents=[
        dict(
            id="a-trim",
            intent="Trim surrounding whitespace from the input.",
            files={
                "index.js": [(DC_AFTER_CHECK, DC_AFTER_CHECK + "\ttext = text.trim();\n\n")],
                "index.d.ts": [("@param string - The camelcase string to decamelize.", "@param string - The camelcase string to decamelize. Surrounding whitespace is removed.")],
            },
            witness=[("m('  fooBar ') === 'foo_bar'", "input is trimmed")],
        ),
        dict(
            id="b-empty-separator",
            intent="Reject an empty separator with a TypeError.",
            files={
                "index.js": [
                    (
                        DC_AFTER_CHECK,
                        DC_AFTER_CHECK + "\tif (separator === '') {\n\t\tthrow new TypeError('The `separator` argument should not be empty');\n\t}\n\n",
                    )
                ]
            },
            add={"CHANGELOG.md": "# Changelog\n\n- An empty separator throws.\n"},
            witness=[("throwsWith(() => m('fooBar', {separator: ''}), TypeError)", "empty separator throws")],
        ),
    ],
    reference={
        "index.js": [
            (
                DC_AFTER_CHECK,
                DC_AFTER_CHECK
                + "\ttext = text.trim();\n\n"
                + "\tif (separator === '') {\n\t\tthrow new TypeError('The `separator` argument should not be empty');\n\t}\n\n",
            )
        ]
    },
    acceptance=[
        ("m('  fooBar ') === 'foo_bar'", "trim"),
        ("throwsWith(() => m('fooBar', {separator: ''}), TypeError)", "empty separator"),
        ("m('fooBar', {separator: '-'}) === 'foo-bar'", "baseline: separator"),
        ("m('testGUILabel', {preserveConsecutiveUppercase: true}) === 'test_GUI_label'", "baseline: preserve"),
        ("read('index.d.ts').includes('Surrounding whitespace is removed.')", "a-trim's type note survives"),
        ("has('CHANGELOG.md') && read('CHANGELOG.md').includes('empty separator')", "b's changelog survives"),
    ],
)

scenario(
    id="DC-2",
    kind="textual",
    package="decamelize",
    title="Two new options change the option list and every return",
    agents=[
        dict(
            id="a-prefix",
            intent="Add a prefix option that is prepended to the result.",
            files={
                "index.js": [
                    (DC_DESTRUCT, "\t\tpreserveConsecutiveUppercase = false,\n\t\tprefix = '',\n\t} = {},"),
                    (DC_EARLY, "\t\treturn prefix + (preserveConsecutiveUppercase ? text : text.toLowerCase());"),
                    (DC_RET_DEC, "\t\treturn prefix + decamelized;"),
                    (DC_RET_WORDS, "\treturn prefix + words.join(separator);"),
                ],
                "index.d.ts": [(DC_DTS, "\treadonly preserveConsecutiveUppercase?: boolean;\n\n\t/**\n\tPrepended to the result.\n\t*/\n\treadonly prefix?: string;\n};")],
            },
            witness=[("m('fooBar', {prefix: 'x_'}) === 'x_foo_bar'", "prefix is prepended")],
        ),
        dict(
            id="b-suffix",
            intent="Add a suffix option that is appended to the result.",
            files={
                "index.js": [
                    (DC_DESTRUCT, "\t\tpreserveConsecutiveUppercase = false,\n\t\tsuffix = '',\n\t} = {},"),
                    (DC_EARLY, "\t\treturn (preserveConsecutiveUppercase ? text : text.toLowerCase()) + suffix;"),
                    (DC_RET_DEC, "\t\treturn decamelized + suffix;"),
                    (DC_RET_WORDS, "\treturn words.join(separator) + suffix;"),
                ]
            },
            add={"CHANGELOG.md": "# Changelog\n\n- Add the `suffix` option.\n"},
            witness=[("m('fooBar', {suffix: '_y'}) === 'foo_bar_y'", "suffix is appended")],
        ),
    ],
    reference={
        "index.js": [
            (DC_DESTRUCT, "\t\tpreserveConsecutiveUppercase = false,\n\t\tprefix = '',\n\t\tsuffix = '',\n\t} = {},"),
            (DC_EARLY, "\t\treturn prefix + (preserveConsecutiveUppercase ? text : text.toLowerCase()) + suffix;"),
            (DC_RET_DEC, "\t\treturn prefix + decamelized + suffix;"),
            (DC_RET_WORDS, "\treturn prefix + words.join(separator) + suffix;"),
        ]
    },
    acceptance=[
        ("m('fooBar', {prefix: 'x_'}) === 'x_foo_bar'", "prefix"),
        ("m('fooBar', {suffix: '_y'}) === 'foo_bar_y'", "suffix"),
        ("m('fooBar', {prefix: 'x_', suffix: '_y'}) === 'x_foo_bar_y'", "both"),
        ("m('A', {prefix: 'p', suffix: 's'}) === 'pas'", "single character path"),
        ("m('dataForUSACounties', {preserveConsecutiveUppercase: true, prefix: 'p_'}) === 'p_data_for_USA_counties'", "preserve path"),
        ("read('index.d.ts').includes('readonly prefix')", "a-prefix's type declaration survives"),
        ("has('CHANGELOG.md') && read('CHANGELOG.md').includes('suffix')", "b-suffix's changelog survives"),
    ],
)

scenario(
    id="ST-2",
    kind="list",
    package="decamelize",
    title="Two new options meet only in the option list",
    agents=[
        dict(
            id="a-limit",
            intent="Add a maxLength option that truncates the result.",
            files={
                "index.js": [
                    (DC_DESTRUCT, "\t\tpreserveConsecutiveUppercase = false,\n\t\tmaxLength = Number.POSITIVE_INFINITY,\n\t} = {},"),
                    (DC_RET_WORDS, "\treturn words.join(separator).slice(0, maxLength);"),
                ],
                "index.d.ts": [(DC_DTS, "\treadonly preserveConsecutiveUppercase?: boolean;\n\n\t/**\n\tTruncate the result.\n\t*/\n\treadonly maxLength?: number;\n};")],
            },
            witness=[("m('fooBarBaz', {maxLength: 7}) === 'foo_bar'", "result is truncated")],
        ),
        dict(
            id="b-trim",
            intent="Add a trim option that removes surrounding whitespace from the input first.",
            files={
                "index.js": [
                    (DC_DESTRUCT, "\t\tpreserveConsecutiveUppercase = false,\n\t\ttrim = false,\n\t} = {},"),
                    (DC_AFTER_CHECK, DC_AFTER_CHECK + "\tif (trim) {\n\t\ttext = text.trim();\n\t}\n\n"),
                ]
            },
            add={"CHANGELOG.md": "# Changelog\n\n- Add the `trim` option.\n"},
            witness=[("m('  fooBar ', {trim: true}) === 'foo_bar'", "input is trimmed")],
        ),
    ],
    reference={
        "index.js": [
            (DC_DESTRUCT, "\t\tpreserveConsecutiveUppercase = false,\n\t\tmaxLength = Number.POSITIVE_INFINITY,\n\t\ttrim = false,\n\t} = {},"),
            (DC_AFTER_CHECK, DC_AFTER_CHECK + "\tif (trim) {\n\t\ttext = text.trim();\n\t}\n\n"),
            (DC_RET_WORDS, "\treturn words.join(separator).slice(0, maxLength);"),
        ]
    },
    acceptance=[
        ("m('fooBarBaz', {maxLength: 7}) === 'foo_bar'", "maxLength"),
        ("m('  fooBar ', {trim: true}) === 'foo_bar'", "trim"),
        ("m('  fooBarBaz ', {trim: true, maxLength: 7}) === 'foo_bar'", "both"),
        ("m('  fooBar ') === '  foo_bar '", "baseline: no trim by default"),
        ("read('index.d.ts').includes('maxLength')", "a-limit's type declaration survives"),
        ("has('CHANGELOG.md') && read('CHANGELOG.md').includes('trim')", "b-trim's changelog survives"),
    ],
)

scenario(
    id="SEM-2",
    kind="semantic",
    package="decamelize",
    title="One agent changes the default separator; another adds a snake_case helper that relies on it",
    agents=[
        dict(
            id="a-dash",
            intent="Use - as the default separator.",
            files={"index.js": [("\t\tseparator = '_',", "\t\tseparator = '-',")], "index.d.ts": [("\t@default '_'", "\t@default '-'")]},
            witness=[("m('fooBar') === 'foo-bar'", "default separator is -")],
        ),
        dict(
            id="b-snake",
            intent="Add toSnakeCase(text) in snake.js, which returns snake_case.",
            files={},
            add={"snake.js": "import decamelize from './index.js';\n\nexport default function toSnakeCase(text) {\n\treturn decamelize(text);\n}\n"},
            witness=[("(await load('snake.js')).default('fooBar') === 'foo_bar'", "snake case uses _")],
        ),
    ],
    reference=None,
    acceptance=[
        ("m('fooBar') === 'foo-bar'", "default separator"),
        ("(await load('snake.js')).default('fooBar') === 'foo_bar'", "snake case"),
    ],
)

scenario(
    id="CTRL-2",
    kind="control",
    package="decamelize",
    title="One agent rewords an error; another adds a snake_case helper that names its separator",
    agents=[
        dict(
            id="a-message",
            intent="Say which argument has the wrong type in the TypeError.",
            files={
                "index.js": [
                    (
                        "\t\t\t'The `text` and `separator` arguments should be of type `string`',",
                        "\t\t\t`The \\`text\\` and \\`separator\\` arguments should be of type \\`string\\`, got ${typeof text} and ${typeof separator}`,",
                    )
                ]
            },
            witness=[("throwsWith(() => m(1), TypeError, /got number and string/)", "message names both types")],
        ),
        dict(
            id="b-snake",
            intent="Add toSnakeCase(text) in snake.js, which returns snake_case.",
            files={},
            add={"snake.js": "import decamelize from './index.js';\n\nexport default function toSnakeCase(text) {\n\treturn decamelize(text, {separator: '_'});\n}\n"},
            witness=[("(await load('snake.js')).default('fooBar') === 'foo_bar'", "snake case uses _")],
        ),
    ],
    reference=None,
    acceptance=[
        ("throwsWith(() => m(1), TypeError, /got number and string/)", "message"),
        ("(await load('snake.js')).default('fooBar') === 'foo_bar'", "snake case"),
        ("m('fooBar') === 'foo_bar'", "baseline"),
    ],
)


def build():
    if OUT.exists():
        shutil.rmtree(OUT)
    for s in SCENARIOS:
        d = OUT / s["id"]
        pkg = s["package"]
        agents = []
        for agent in s["agents"]:
            written = []
            for name, pairs in agent["files"].items():
                text = edit(base(pkg, name), pairs, f"{s['id']}/{agent['id']}/{name}")
                (d / agent["id"] / name).parent.mkdir(parents=True, exist_ok=True)
                (d / agent["id"] / name).write_text(text)
                written.append(name)
            for name, text in agent.get("add", {}).items():
                (d / agent["id"] / name).parent.mkdir(parents=True, exist_ok=True)
                (d / agent["id"] / name).write_text(text)
                written.append(name)
            (d / "witness").mkdir(parents=True, exist_ok=True)
            (d / "witness" / f"{agent['id']}.mjs").write_text(
                script(f"Witness for {agent['id']} ({s['id']}): {agent['intent']}", agent["witness"])
            )
            agents.append({"id": agent["id"], "intent": agent["intent"], "files": sorted(written)})
        if s["reference"]:
            for name, pairs in s["reference"].items():
                (d / "reference").mkdir(parents=True, exist_ok=True)
                (d / "reference" / name).write_text(edit(base(pkg, name), pairs, f"{s['id']}/reference/{name}"))
        (d / "acceptance.mjs").write_text(script(f"Held-out acceptance test for {s['id']}: {s['title']}", s["acceptance"]))
        meta = {
            "id": s["id"],
            "kind": s["kind"],
            "package": pkg,
            "title": s["title"],
            "agents": agents,
            "reference": sorted((s["reference"] or {}).keys()),
        }
        (d / "scenario.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"built {len(SCENARIOS)} scenarios in {OUT}")


if __name__ == "__main__":
    build()
