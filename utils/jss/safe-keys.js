/**
 * @file Property access for names read back from storage.
 *
 * Domain context: a snapshot, WAL line or cold-tier file chooses tags, object keys and
 * pointer path segments. A plain `obj[name]` on such a name reaches inherited members
 * (`constructor`, `toString`, `__proto__`) and a plain `obj[name] = v` with `__proto__`
 * replaces a prototype. Everywhere the JSS decoder indexes an object with stored text it
 * goes through these two helpers.
 *
 * Technical context: pure functions with no runtime dependencies.
 */

/**
 * Own-property test that cannot be fooled by a key such as `hasOwnProperty`.
 * @param {Object} obj - Object to look in
 * @param {*} key - Property name (read from storage)
 * @returns {boolean} True when `key` is an own property of `obj`
 */
export const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Set a stored key on an object. `__proto__` becomes an ordinary own key (as
 * `JSON.parse` makes it) instead of replacing the object's prototype.
 * @param {Object|Array} target - Object being filled
 * @param {string|number} key - Key read from storage
 * @param {*} value - Value to store
 * @returns {void}
 */
export function setKey(target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    target[key] = value;
  }
}
