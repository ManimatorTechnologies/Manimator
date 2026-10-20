// Files the scene reads (SVG text, decoded pictures, fonts), loaded before the scene is built so that building
// stays synchronous, as it is in Python.

const store = new Map();

export const resources = {
  put(kind, name, value) {
    store.set(`${kind}:${name}`, value);
  },

  has(kind, name) {
    return store.has(`${kind}:${name}`);
  },

  get(kind, name) {
    const key = `${kind}:${name}`;
    if (!store.has(key)) throw new Error(`${name} isn't loaded`);
    return store.get(key);
  },

  text(name) {
    return this.get("text", name);
  },

  clear() {
    store.clear();
  },
};
