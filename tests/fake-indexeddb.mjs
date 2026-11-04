/** One outbox store keyed by id. Requests answer asynchronously; writes become visible only at transaction commit. */
export function fakeIndexedDB() {
  const idb = { entries: new Map(), hold: false, held: [], upgraded: false, failWrites: false, failReads: false };
  idb.release = () => {
    for (const commit of idb.held.splice(0)) commit();
  };
  const db = {
    createObjectStore() {},
    close() {},
    transaction() {
      const writes = [];
      let pending = 0;
      let finished = false;
      const commit = () => {
        if (idb.failWrites && writes.length) return transaction.onabort?.();
        for (const write of writes) write();
        transaction.oncomplete?.();
      };
      const settle = () => queueMicrotask(() => {
        if (pending > 0 || finished) return;
        finished = true;
        if (idb.hold) idb.held.push(commit);
        else commit();
      });
      const request = (result, write) => {
        const request = {};
        pending++;
        queueMicrotask(() => {
          pending--;
          if (idb.failReads && !write) {
            finished = true;
            request.onerror?.();
            transaction.onabort?.();
            return;
          }
          if (write) writes.push(write);
          request.result = result();
          request.onsuccess?.();
          settle();
        });
        return request;
      };
      const transaction = {
        objectStore: () => ({
          put: (value) => {
            const copy = structuredClone(value);
            return request(() => copy.id, () => idb.entries.set(copy.id, copy));
          },
          delete: (id) => request(() => undefined, () => idb.entries.delete(id)),
          get: (id) => request(() => structuredClone(idb.entries.get(id))),
          getAll: () => request(() => [...idb.entries.values()].map((value) => structuredClone(value))),
        }),
      };
      settle();
      return transaction;
    },
  };
  idb.open = () => {
    const request = { result: db };
    queueMicrotask(() => {
      if (!idb.upgraded) request.onupgradeneeded?.();
      idb.upgraded = true;
      request.onsuccess?.();
    });
    return request;
  };
  return idb;
}
