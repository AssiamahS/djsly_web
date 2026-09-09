/* djsly library — tracks persisted in IndexedDB (file blob + analysis) so they survive reloads, also on iPhone */
const DB = 'djsly', STORE = 'tracks';
function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: 'id' }); s.createIndex('added', 'added'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction(STORE, mode); const req = fn(t.objectStore(STORE)); t.oncomplete = () => res(req?.result); t.onerror = () => rej(t.error); }); };
export const Library = {
  async list() { const rows = await tx('readonly', s => s.getAll()); return rows.map(({ blob, ...m }) => m).sort((a, b) => a.added - b.added); },
  async get(id) { return tx('readonly', s => s.get(id)); },
  async add(file, meta) {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const name = file.name.replace(/\.[^.]+$/, ''); const m = name.match(/^(.*?)\s+-\s+(.*)$/);
    const row = { id, name, artist: m ? m[1] : '', title: m ? m[2] : name, size: file.size, type: file.type, added: Date.now(), blob: file, hotcues: Array(8).fill(null), ...meta };
    await tx('readwrite', s => s.put(row)); const { blob, ...rest } = row; return rest;
  },
  async update(id, patch) { const row = await this.get(id); if (!row) return; await tx('readwrite', s => s.put({ ...row, ...patch })); },
  async remove(id) { await tx('readwrite', s => s.delete(id)); },
};
