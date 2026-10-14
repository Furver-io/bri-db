# JSS - JSON SuperSet

Extended JSON serialization with support for JavaScript types not natively supported by JSON.

## Overview

JSS (JSON SuperSet) provides serialize/deserialize functionality that preserves type information for Date, Error, RegExp, Map, Set, undefined, and handles circular references.

## Usage

```javascript
import jss from 'bri/utils/jss';

const data = {
  created: new Date(),
  pattern: /test/gi,
  items: new Set([1, 2, 3]),
  lookup: new Map([['key', 'value']])
};

const encoded = jss.stringify(data);
const decoded = jss.parse(encoded);
```

## Supported Types

- **Date** - Preserved as timestamp
- **RegExp** - Preserved as string pattern with flags
- **Error** - Preserved with name, message, and stack
- **Map** - Converted to/from object entries
- **Set** - Converted to/from array
- **undefined** - Explicitly preserved
- **Circular references** - Handled via path pointers

## Decoding untrusted data

A snapshot, a WAL line and a cold-tier `.jss` file are all read back through `parse`, so
anything that can drop a file into a data folder reaches the decoder. It therefore:

- builds an `E` (Error) value only for the standard Error classes (`Error`, `TypeError`,
  `RangeError`, `SyntaxError`, `ReferenceError`, `EvalError`, `URIError`, `AggregateError`);
  any other stored name (a custom class, `Worker`, `WebSocket`) decodes to a plain `Error`
  whose `name` is that text;
- matches tags, keys and pointer paths against own properties only, so `constructor`,
  `toString` or `__proto__` reach nothing; a `__proto__` key is an ordinary key;
- writes a pointer into the decoded object that held it, never by walking a stored path;
- offers `assertNoTagKeys(value)`, which the engine calls on data a caller supplies (`add`, `set`,
  `save`): a field whose name ends in a type tag (`name<!X>`) would read back as a typed value,
  and `a` plus `a<!M>` in one document could never be read again;
- throws `JSS decode: duplicate key "a"` when `a` and `a<!M>` (two keys that decode to one
  name) appear together, and when a pointer value is not a path string.
