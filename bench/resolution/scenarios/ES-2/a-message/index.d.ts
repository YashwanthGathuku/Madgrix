/**
Escape RegExp special characters.

You can also use this to escape a string that is inserted into the middle of a regex, for example, into a character class.

Throws a `TypeError` that names the received type when the input is not a string.

@example
```
import escapeStringRegexp from 'escape-string-regexp';

const escapedString = escapeStringRegexp('How much $ for a 🦄?');
//=> 'How much \\$ for a 🦄\\?'

new RegExp(escapedString);
```
*/
export default function escapeStringRegexp(string: string): string;
