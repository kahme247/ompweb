/** One IDB store: queued transactions, read-your-writes, unique adds, and atomic commit/abort. */
export function fakeIndexedDB() {
  const idb = { entries: new Map(), hold: false, held: [], upgraded: false, failWrites: false, failReads: false };
  const transactions = [];
  let active = false;
  idb.release = () => {
    for (const commit of idb.held.splice(0)) commit();
  };
  const startNext = () => {
    if (active || transactions.length === 0) return;
    active = true;
    transactions.shift()();
  };
  const db = {
    createObjectStore() {},
    close() {},
    transaction(_store, mode = "readonly") {
      const requests = [];
      let data;
      let pending = 0;
      let finished = false;
      let writing = false;
      const finish = () => {
        active = false;
        startNext();
      };
      const abort = (error = new DOMException("Transaction aborted", "AbortError")) => {
        if (finished) return;
        finished = true;
        transaction.error = error;
        transaction.onabort?.();
        finish();
      };
      const commit = () => {
        if (finished) return;
        if (idb.failWrites && writing) return abort(new DOMException("Commit failed", "QuotaExceededError"));
        finished = true;
        if (writing) {
          idb.entries.clear();
          for (const [id, value] of data) idb.entries.set(id, value);
        }
        transaction.oncomplete?.();
        finish();
      };
      let committing = false;
      const settle = () => queueMicrotask(() => {
        if (pending > 0 || finished || committing) return;
        committing = true;
        if (idb.hold) idb.held.push(commit);
        else commit();
      });
      const request = (operation, write = false) => {
        if (finished || committing) throw new DOMException("Transaction inactive", "TransactionInactiveError");
        if (write && mode !== "readwrite") throw new DOMException("Readonly transaction", "ReadOnlyError");
        const request = {};
        pending++;
        const run = () => queueMicrotask(() => {
          if (finished) return;
          pending--;
          try {
            if (idb.failReads && !write) throw new DOMException("Read failed", "UnknownError");
            request.result = operation();
            writing ||= write;
          } catch (error) {
            request.error = error;
            request.onerror?.();
            abort(error);
            return;
          }
          request.onsuccess?.();
          settle();
        });
        if (data) run();
        else requests.push(run);
        return request;
      };
      const transaction = {
        abort: () => abort(),
        objectStore: () => ({
          put: (value) => {
            const copy = structuredClone(value);
            return request(() => { data.set(copy.id, copy); return copy.id; }, true);
          },
          add: (value) => {
            const copy = structuredClone(value);
            return request(() => {
              if (data.has(copy.id)) throw new DOMException("Key already exists", "ConstraintError");
              data.set(copy.id, copy);
              return copy.id;
            }, true);
          },
          delete: (id) => request(() => { data.delete(id); }, true),
          get: (id) => request(() => structuredClone(data.get(id))),
          getAll: () => request(() => [...data].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => structuredClone(value))),
        }),
      };
      transactions.push(() => {
        data = new Map([...idb.entries].map(([id, value]) => [id, structuredClone(value)]));
        for (const run of requests) run();
        settle();
      });
      queueMicrotask(startNext);
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
