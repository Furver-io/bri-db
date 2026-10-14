/**
 * @file JsonSuperSet — extended JSON serialization with typed tags (Date,
 *       Error, Map, Set, RegExp, cycles).
 *
 * Decoding treats its input as untrusted text (snapshots, WAL lines and cold-tier files
 * are all decoded here): see {@link decode} and {@link ./safe-keys.js}.
 */

import { hasOwn, setKey } from './safe-keys.js';

/**
 * Refuse a document that holds a field name ending in a type tag (`name<!X>`).
 *
 * Call this on data a caller supplies, before it is stored. Such a field is stored as
 * written and read back as a typed value (`{ "a<!D>": 5 }` becomes a Date under `a`), and
 * a document holding both `a` and `a<!M>` is refused by {@link decode}, so it could be
 * written but never read, snapshotted or deleted again. Not part of `encode`, which also
 * re-encodes text that is already tagged (the cold tier stores tagged keys on purpose).
 * Descends plain objects and arrays only (a Map's keys are never read as tags) and
 * tolerates cycles.
 * @param {*} value - Caller-supplied document or fragment
 * @returns {void}
 * @throws {Error} When a field name ends in a `<!tag>` suffix
 */
function assertNoTagKeys(value) {
  const seen = new Set();
  /**
   * Check one node and everything below it.
   * @param {*} node - Value to inspect
   * @returns {void}
   */
  function walk(node) {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    if (node instanceof Date || node instanceof Map || node instanceof Set || node instanceof Error) return;
    seen.add(node);
    for (const key of Object.keys(node)) {
      if (parseKeyWithTags(key)[1] !== undefined) {
        throw new Error(`JSS: field name "${key}" ends in a type tag (<!...>); rename the field`);
      }
      walk(node[key]);
    }
  }
  walk(value);
}

/**
 * Encode a plain object or array into JSS tagged key/value form before JSON serialization.
 * @param {object|Array} obj - Root value to encode
 * @returns {object|Array} Encoded structure using `<!tag>` key suffixes for typed leaves
 */
function encode(obj) {
  const tagLookup = {
    '[object RegExp]': 'R',
    '[object Date]': 'D',
    '[object Error]': 'E',
    '[object Undefined]': 'U',
    '[object Map]': 'M',
    '[object Set]': 'S',
  };
  const visited = new WeakMap();

  /**
   * Recursive encoder — emits typed tuples or nested plain structures for one subtree.
   * @param {*} value - Current node to encode
   * @param {string} currentPath - Path segment string used for circular-reference bookkeeping
   * @returns {Array|string|number|boolean|null|Object} Internal encode tuple / intermediate structure: typed leaf `[tag, payload]` (`tag` one of `R/D/E/U/M/S`), cycle marker `['P', path]`, heterogeneously tagged arrays `[ '[types]', vals ]`, or plain nested POJO/array shells with `''` marks for JSON-safe scalars.
   */
  function encodeValue(value, currentPath = '') {
    const type = typeof value;
    const tag = tagLookup[Object.prototype.toString.call(value)];

    if (tag !== undefined) {
      if ('D' === tag) return [tag, value.valueOf()];
      if ('E' === tag) return [tag, [value.name, value.message, value.stack]];
      if ('R' === tag) return [tag, value.toString()];
      if ('U' === tag) return [tag, null];
      if ('S' === tag) return [tag, Array.from(value)];
      if ('M' === tag) return [tag, Object.fromEntries(value)];
      return [tag, JSON.stringify(value)];
    } else if (type === 'object' && value !== null) {
      if (visited.has(value)) {
        return ['P', visited.get(value)];
      }
      visited.set(value, currentPath);
      const isArray = Array.isArray(value);
      const keys = isArray ? Array.from(Array(value.length).keys()) : Object.keys(value);
      const result = isArray ? [] : {};
      const typesFound = [];

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const childPath = currentPath ? `${currentPath}/${key}` : `${key}`;
        const [t, v] = encodeValue(value[key], childPath);
        if (isArray) {
          typesFound.push(t);
          result.push(v);
        } else if (value[key] !== undefined) {
          result[key + (t ? `<!${t}>` : '')] = v;
        }
      }

      visited.delete(value);
      if (isArray && typesFound.find((t) => !!t)) {
        return [`[${typesFound.join()}]`, result];
      }
      return ['', result];
    } else {
      return ['', value];
    }
  }

  let keys = [];
  let result = {};

  if (Array.isArray(obj)) {
    keys = Array.from(Array(obj.length).keys());
    result = [];
  } else {
    keys = Object.keys(obj);
    result = {};
  }

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (obj[key] !== undefined) {
      const [t, v] = encodeValue(obj[key], key);
      result[key + (t ? `<!${t}>` : '')] = v;
    }
  }
  return result;
}

/**
 * Serialize an object to JSS extended JSON text.
 * @param {object|Array} obj - Root value
 * @returns {string} JSON string of encoded form
 */
function stringify(obj) {
  return JSON.stringify(encode(obj));
}

/**
 * Parse JSS extended JSON text back into JavaScript values.
 * @param {string} encoded - JSON text produced by {@link stringify}
 * @returns {object|Array|string|number|boolean|null} Root after decoding — always plain JS data plus restored builtins (Date/RegExp/Map/Set/Error), cycle repairs applied afterward via pointer replay (never leaves JSON-only wrappers at the root).
 */
function parse(encoded) {
  return decode(JSON.parse(encoded));
}

/**
 * The Error classes a stored `E` value may name. A static allow-list, never a lookup on
 * `global`: the name is text read back from a snapshot, a WAL line or a cold-tier file,
 * and `new global[name](message)` let anything able to drop a file into a data folder
 * construct any global (a `Worker` running its own code). Any other name decodes to a
 * plain `Error` whose `name` is the stored text.
 * @type {Object.<string, function(string): Error>}
 */
const ERROR_CLASSES = Object.freeze({
  Error: (m) => new Error(m),
  TypeError: (m) => new TypeError(m),
  RangeError: (m) => new RangeError(m),
  SyntaxError: (m) => new SyntaxError(m),
  ReferenceError: (m) => new ReferenceError(m),
  EvalError: (m) => new EvalError(m),
  URIError: (m) => new URIError(m),
  AggregateError: (m) => new AggregateError([], m),
});

/**
 * Split a serialized object key into base name and optional `<!tag>` suffix.
 * A linear scan: the regular expression this replaces backtracked quadratically on a key
 * such as `a<!a<!a<!...` with no closing `>`, so a few hundred KB in a stored key
 * stalled the process that loaded it. Same split: the last `<!` that has a `>` after it,
 * up to the last `>`.
 * @param {string} key - Raw object key possibly ending with `<!tag>`
 * @returns {[string, string|undefined]} Base key and tag when present
 */
function parseKeyWithTags(key) {
  const close = key.lastIndexOf('>');
  const open = close < 4 ? -1 : key.lastIndexOf('<!', close - 3);
  return open >= 1 ? [key.slice(0, open), key.slice(open + 2, close)] : [key, undefined];
}

/**
 * Detect whether the decoded object shape represents a homogeneous numeric-key array.
 * @param {object} obj - Parsed plain object before array coercion
 * @returns {boolean} True when every own key is numeric after stripping tags
 */
function checkIfArray(obj) {
  return Object.keys(obj).every(key => !isNaN(parseKeyWithTags(key)[0]));
}

/**
 * Decode JSS intermediate representation (plain object tree) into JavaScript values.
 *
 * Everything in `data` is text from storage and is untrusted: tags, keys and pointer paths
 * are matched against OWN properties only, `__proto__` stays an ordinary key, a key that
 * decodes twice (`a` and `a<!M>`) is refused, and a pointer remembers the decoded object
 * it sits in instead of walking a stored path to find it.
 * @param {object|Array} data - Parsed JSON object tree
 * @returns {object|Array|string|number|boolean|null} Root payload — object graph or array reconstructed from JSS tags; primitives only appear when the encoded payload truly rooted at a primitive (unusual for `encode`, common after recursive descent inside objects).
 * @throws {Error} When a key decodes twice, or a pointer is not a path string
 */
function decode(data) {
  const result = checkIfArray(data) ? [] : {};
  const pointers2Res = [];
  const tagLookup = {
    R: (s) => new RegExp(s),
    D: (n) => new Date(n),
    P: (sourceToPointAt, parent, key) => {
      if (typeof sourceToPointAt !== 'string') {
        throw new Error('JSS decode: a pointer (<!P>) value must be a path string');
      }
      pointers2Res.push([sourceToPointAt, parent, key]);
      return null;
    },
    E: ([name, message, stack]) => {
      const known = typeof name === 'string' && hasOwn(ERROR_CLASSES, name);
      const err = known ? ERROR_CLASSES[name](message) : new Error(message);
      if (!known) err.name = typeof name === 'string' ? name : 'Error';
      if (typeof stack === 'string') err.stack = stack;
      return err;
    },
    U: () => undefined,
    S: (a) => new Set(a),
    M: (o) => new Map(Object.entries(o))
  };
  const visited = new Map();

  /**
   * Decode the entries of one JSON object into `target`, refusing duplicate decoded names.
   * @param {Object|Array} target - Decoded object or array being filled
   * @param {object} val - Raw JSON object
   * @returns {Object|Array} `target`
   */
  function decodeEntries(target, val) {
    for (const key of Object.keys(val)) {
      const [name, tag] = parseKeyWithTags(key);
      if (hasOwn(target, name)) throw new Error(`JSS decode: duplicate key "${name}"`);
      setKey(target, name, decodeValue(tag, val[key], target, name));
    }
    return target;
  }

  /**
   * Decode one keyed entry — restores typed leaves and walks nested objects.
   * @param {string|undefined} tag - Type tag from key suffix or tuple metadata
   * @param {*} val - Raw JSON subtree for this property
   * @param {Object|Array} parent - Decoded object or array this value goes into
   * @param {string|number} key - This value's key (or index) in `parent`
   * @returns {string|number|boolean|null|undefined|Date|RegExp|Error|Map|Set|Array|Object} Value represented by this `(tag, val)` pair after delegating to `tagLookup`, tuple-expanding heterogeneous arrays, or recursively decoding nested POJO fragments (cycles deferred until pointer fix-up).
   */
  function decodeValue(tag, val, parent, key) {
    if (hasOwn(tagLookup, tag)) {
      return tagLookup[tag](val, parent, key);
    } else if (Array.isArray(val)) {
      const typeTags = tag && tag.startsWith('[') ? tag.slice(1, -1).split(',') : [];
      const result = [];
      for (let i = 0; i < val.length; i++) {
        result.push(decodeValue(typeTags[i], val[i], result, i));
      }
      return result;
    } else if ('object' === typeof val && val !== null) {
      if (visited.has(val)) {
        return visited.get(val);
      }
      visited.set(val, {});
      const result = decodeEntries({}, val);
      visited.set(val, result);
      return result;
    } else {
      return val;
    }
  }

  decodeEntries(result, data);
  pointers2Res.forEach(changeAttributeReference.bind(null, result));
  return result;
}

/**
 * Resolve one pointer placeholder after the main decode pass — wires cyclic graphs.
 * The stored path is followed through OWN properties of decoded objects only, so
 * `constructor` or `__proto__` segments reach nothing; a path that leads nowhere
 * resolves to `undefined`. The write lands on the decoded object that held the pointer.
 * @param {object} obj - Root decoded object
 * @param {[string, Object|Array, string|number]} pointer - `[refPath, parent, key]`
 * @returns {object} Same root object with the attribute rewired to its reference target
 */
function changeAttributeReference(obj, [refPath, parent, key]) {
  let ref = obj;
  for (const step of refPath.split('/')) {
    ref = ref !== null && typeof ref === 'object' && hasOwn(ref, step) ? ref[step] : undefined;
  }
  setKey(parent, key, ref);
  return obj;
}

export default { parse, stringify, encode, decode, assertNoTagKeys };
