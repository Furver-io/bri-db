## Directory Structure

```
jss/
├── index.js
└── safe-keys.js
```

## Files

### `index.js`

Main JSS module providing extended JSON serialization.

**Exports:**
- `stringify(obj)` - Serialize object to JSS string
- `parse(str)` - Deserialize JSS string to object
- `encode(obj)` - Convert object to JSS-tagged format
- `decode(data)` - Convert JSS-tagged format to object

**Type Tags:**
- `D` - Date (stored as timestamp)
- `R` - RegExp (stored as string)
- `E` - Error (stored as [name, message, stack])
- `U` - undefined
- `M` - Map (stored as object)
- `S` - Set (stored as array)
- `P` - Pointer (circular reference path)

**Decoding untrusted text:** snapshots, WAL lines and cold-tier `.jss` files are all decoded here, so the decoder treats them as untrusted. `E` builds only the standard Error classes (`Error`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `EvalError`, `URIError`, `AggregateError`); any other name decodes to a plain `Error` whose `name` is that text. Tags, keys and pointer paths are matched against own properties only, a `__proto__` key stays an ordinary key, a pointer writes into the decoded object that held it, and a key that decodes twice (`a` and `a<!M>`) throws.

### `safe-keys.js`

Own-property helpers used by `index.js` for every name read from stored text.

**Exports:**
- `hasOwn(obj, key)` - Own-property test
- `setKey(target, key, value)` - Assign a key; `__proto__` becomes an ordinary own key
