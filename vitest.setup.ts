// Node 26 exposes an experimental global `localStorage` placeholder which can
// shadow JSDOM's implementation with `undefined`. Keep SDK tests deterministic
// across supported and development Node versions without changing production
// code or writing browser state to disk.
if (typeof window !== 'undefined' && !window.localStorage) {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(String(key), String(value)); },
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
}
