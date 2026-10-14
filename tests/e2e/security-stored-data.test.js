/**
 * @file Security stories for data read back from a data folder.
 *
 * Domain context: a snapshot, a WAL line and a cold-tier `.jss` file are all decoded
 * by JSS when a database opens or reads. Anything able to drop a file into the data
 * folder (a restored backup, a shared volume, a synced directory) must not be able to
 * run code, change a prototype or choose which of two values a key decodes to.
 *
 * Technical context: every story goes through public entry points only
 * (`createDB`, `bri-db/utils/jss`) with hand-written files, the same way
 * the persistence tests build recovery fixtures.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createDB } from '../../client/index.js';
import { hashPointer, serializeEntry, createSetEntry } from '../../storage/wal/entry.js';
import JSS from '../../utils/jss/index.js';

/** Names of globals a hostile file may ask the decoder to construct. */
const DANGEROUS = ['Worker', 'WebSocket'];

let calls;
let saved;
let dirs;

beforeEach(() => {
  calls = [];
  saved = {};
  for (const name of DANGEROUS) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    // A spy stands in for the real constructor: building one is the attack.
    globalThis[name] = class Spy extends Error {
      constructor(...args) {
        super(args[0]);
        calls.push(name);
      }
    };
  }
  dirs = [];
});

afterEach(async () => {
  for (const name of DANGEROUS) {
    if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
    else delete globalThis[name];
  }
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  for (const holder of [Object.prototype, Map.prototype, Set.prototype, Date.prototype]) {
    delete holder.polluted;
  }
});

/**
 * Make an empty data folder that the test removes afterwards.
 * @returns {Promise<string>} Folder path
 */
async function dataFolder() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bri-security-'));
  dirs.push(dir);
  return dir;
}

/**
 * Open a database over a folder.
 * @param {string} dir - Data folder
 * @returns {Promise<Object>} Database
 */
function open(dir) {
  return createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
}

/**
 * Write a document the way a cold-tier eviction would, then reopen the folder.
 * @param {string} dir - Data folder
 * @param {string} id - Document id after the `USER_` prefix
 * @param {string} text - File body (JSS text, hostile in these stories)
 * @returns {Promise<Object>} Database opened after the file exists
 */
async function openWithColdFile(dir, id, text) {
  await fs.mkdir(path.join(dir, 'cold', 'USER'), { recursive: true });
  await fs.writeFile(path.join(dir, 'cold', 'USER', `${id}.jss`), text, 'utf8');
  return open(dir);
}

const HOSTILE_ERROR = (name) => `{"title":"kept","note<!E>":["${name}","boom","stack text"]}`;

describe('A data folder cannot make the database run code', () => {
  test.each(DANGEROUS)('a cold-tier file naming a %s error constructs nothing', async (name) => {
    const db = await openWithColdFile(await dataFolder(), 'evil1', HOSTILE_ERROR(name));
    const user = await db.get.user('USER_evil1');
    expect(user.title).toBe('kept');
    expect(calls).toEqual([]);
    await db.disconnect();
  });

  test('a snapshot carrying a Worker error constructs nothing and still loads', async () => {
    const dir = await dataFolder();
    const first = await open(dir);
    const kept = await first.add.user({ name: 'before' });
    await first._store.createSnapshot();
    await first.disconnect();

    const snapshotPath = path.join(dir, 'snapshot.jss');
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
    snapshot['planted<!E>'] = ['Worker', 'boom', 'stack text'];
    await fs.writeFile(snapshotPath, JSON.stringify(snapshot), 'utf8');

    const second = await open(dir);
    expect((await second.get.user(kept.$ID)).name).toBe('before');
    expect(calls).toEqual([]);
    await second.disconnect();
  });

  test('a WAL line carrying a WebSocket error constructs nothing', async () => {
    const dir = await dataFolder();
    await fs.mkdir(path.join(dir, 'wal'), { recursive: true });
    const json = JSON.stringify({
      action: 'SET',
      target: 'USER_walevil',
      value: JSS.stringify({ $ID: 'USER_walevil', name: 'from wal', createdAt: new Date(), updatedAt: new Date() }),
      'planted<!E>': ['WebSocket', 'boom', 'stack text']
    });
    await fs.writeFile(
      path.join(dir, 'wal', '000000001.wal'),
      `${Date.now()}|${hashPointer(null, json)}|${json}\n`,
      'utf8'
    );

    const db = await open(dir);
    expect((await db.get.user('USER_walevil')).name).toBe('from wal');
    expect(calls).toEqual([]);
    await db.disconnect();
  });
});

describe('Decoding an error value', () => {
  test.each([
    ['Error', Error],
    ['TypeError', TypeError],
    ['RangeError', RangeError],
    ['SyntaxError', SyntaxError],
    ['ReferenceError', ReferenceError],
    ['EvalError', EvalError],
    ['URIError', URIError]
  ])('a %s still comes back as that class with its message and stack', (name, Klass) => {
    const err = new Klass('same message');
    const back = JSS.parse(JSS.stringify({ err })).err;
    expect(back).toBeInstanceOf(Klass);
    expect(back.name).toBe(name);
    expect(back.message).toBe('same message');
    expect(back.stack).toBe(err.stack);
  });

  test('an AggregateError comes back as an AggregateError', () => {
    const back = JSS.parse(JSS.stringify({ err: new AggregateError([], 'many') })).err;
    expect(back).toBeInstanceOf(AggregateError);
    expect(back.message).toBe('many');
  });

  test.each(['Worker', 'WebSocket', 'Function', 'Object', 'constructor', '__proto__', 'toString', 'MyAppError'])(
    'the name %s becomes the text of a plain Error and builds nothing',
    (name) => {
      const back = JSS.decode({ 'err<!E>': [name, 'msg', 'trace'] }).err;
      expect(Object.getPrototypeOf(back)).toBe(Error.prototype);
      expect(back.name).toBe(name);
      expect(back.message).toBe('msg');
      expect(back.stack).toBe('trace');
      expect(calls).toEqual([]);
    }
  );

  test('a name that is not text becomes a plain Error and a missing stack is left alone', () => {
    const back = JSS.decode({ 'err<!E>': [{ toString: 'x' }, 'msg'] }).err;
    expect(back.name).toBe('Error');
    expect(back.message).toBe('msg');
    expect(typeof back.stack).toBe('string');
  });
});

describe('Decoded data cannot change a prototype', () => {
  test('a __proto__ pointer does not make the entity inherit properties', () => {
    const decoded = JSS.parse('{"doc":{"payload":{"isAdmin":true},"__proto__<!P>":"doc/payload"}}');
    expect(decoded.doc.isAdmin).toBeUndefined();
    expect(Object.getPrototypeOf(decoded.doc)).toBe(Object.prototype);
  });

  test('a single-segment __proto__ pointer does not make the root inherit properties', () => {
    const decoded = JSS.parse('{"payload":{"isAdmin":true},"__proto__<!P>":"payload"}');
    expect(decoded.isAdmin).toBeUndefined();
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  test('a plain __proto__ key stays an ordinary key', () => {
    const decoded = JSS.parse('{"name":"n","__proto__":{"isAdmin":true}}');
    expect(decoded.isAdmin).toBeUndefined();
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.keys(decoded)).toEqual(['name', '__proto__']);
    expect(Object.keys(decoded.__proto__)).toEqual(['isAdmin']);
  });

  test('a pointer cannot hand back a built-in constructor or prototype', () => {
    const decoded = JSS.parse('{"a<!P>":"constructor","b":{"c<!P>":"constructor/prototype"}}');
    expect(decoded.a).toBeUndefined();
    expect(decoded.b.c).toBeUndefined();
  });

  test('a pointer routed through a duplicate key pollutes no built-in prototype', () => {
    const hostile =
      '{"a":{"__proto__":{"__proto__":{"polluted<!P>":"x"}}},"a<!M>":{},"x":"payload"}';
    expect(() => JSS.parse(hostile)).toThrow(/duplicate key "a"/);
    expect({}.polluted).toBeUndefined();
    expect(new Map().polluted).toBeUndefined();
  });

  test('a cold-tier file using that pointer is refused and pollutes nothing', async () => {
    const hostile =
      '{"a":{"__proto__":{"__proto__":{"polluted<!P>":"x"}}},"a<!M>":{},"x":"payload"}';
    const db = await openWithColdFile(await dataFolder(), 'evil2', hostile);
    await expect(db.get.user('USER_evil2')).rejects.toThrow(/duplicate key/);
    expect({}.polluted).toBeUndefined();
    expect(Map.prototype.polluted).toBeUndefined();
    await db.disconnect();
  });
});

describe('A key cannot decode to two values', () => {
  test('a plain key and a tagged key of the same name are refused', () => {
    expect(() => JSS.parse('{"a":1,"a<!D>":5}')).toThrow(/duplicate key "a"/);
    expect(() => JSS.parse('{"doc":{"a":1,"a<!D>":5}}')).toThrow(/duplicate key "a"/);
  });

  test('a WAL line with such a key is skipped like any corrupt line', async () => {
    const dir = await dataFolder();
    await fs.mkdir(path.join(dir, 'wal'), { recursive: true });
    const bad = '{"action":"SET","target":"USER_dup","value":"{}","target<!D>":5}';
    const good = serializeEntry(createSetEntry('USER_good', JSS.stringify({ $ID: 'USER_good', name: 'good' })));
    await fs.writeFile(
      path.join(dir, 'wal', '000000001.wal'),
      `${Date.now()}|${hashPointer(null, bad)}|${bad}\n${good}\n`,
      'utf8'
    );
    const db = await open(dir);
    expect(await db.get.user('USER_dup')).toBeNull();
    expect((await db.get.user('USER_good')).name).toBe('good');
    await db.disconnect();
  });
});

describe('Tags and keys are read as data', () => {
  test.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])(
    'a key tagged <!%s> is an ordinary value, not a call into Object.prototype',
    (tag) => {
      const decoded = JSS.parse(`{"v<!${tag}>":{"k":1},"w<!${tag}>":[1,2],"x<!${tag}>":5}`);
      expect(decoded).toEqual({ v: { k: 1 }, w: [1, 2], x: 5 });
    }
  );

  test('a very long key of unmatched tag openers decodes in linear time', () => {
    const key = 'a<!'.repeat(600);
    const started = Date.now();
    const decoded = JSS.parse(JSON.stringify({ [key]: 1 }));
    expect(decoded[key]).toBe(1);
    expect(Date.now() - started).toBeLessThan(100);
  });

  test('a key ending in an empty tag keeps its text', () => {
    expect(JSS.parse('{"a<!>":1}')).toEqual({ 'a<!>': 1 });
  });
});

describe('Pointers that lead nowhere', () => {
  test('a path through a missing key, a null or a text value resolves to undefined', () => {
    const decoded = JSS.parse('{"n":null,"s":"text","p1<!P>":"missing/deeper","p2<!P>":"n/x","p3<!P>":"s/length"}');
    expect(decoded.p1).toBeUndefined();
    expect(decoded.p2).toBeUndefined();
    expect(decoded.p3).toBeUndefined();
  });

  test('a pointer that is not a path string is refused', () => {
    expect(() => JSS.parse('{"p<!P>":["a","b"]}')).toThrow(/path string/);
  });
});

describe('Existing behaviour is unchanged', () => {
  test('cycles, shared nodes and typed values still round-trip', () => {
    const a = { name: 'A', when: new Date(5), tags: new Set([1, 2]), map: new Map([['k', 'v']]), re: /x/i };
    a.self = a;
    a.list = [a, undefined, new Date(7)];
    const back = JSS.parse(JSS.stringify({ a }));
    expect(back.a.name).toBe('A');
    expect(back.a.self.name).toBe('A');
    expect(back.a.list[0].name).toBe('A');
    expect(back.a.list[1]).toBeUndefined();
    expect(back.a.list[2]).toEqual(new Date(7));
    expect(back.a.when).toEqual(new Date(5));
    expect(back.a.map.get('k')).toBe('v');
  });

  test('decode ties duplicate object references to the same instance', () => {
    const shared = { k: 1 };
    const out = JSS.decode({ left: shared, nest: { right: shared } });
    expect(out.left).toBe(out.nest.right);
    expect(out.left.k).toBe(1);
  });

  test('arrays at the root and numeric keys stay arrays', () => {
    expect(JSS.parse(JSS.stringify(['a', 'b']))).toEqual(['a', 'b']);
  });
});
