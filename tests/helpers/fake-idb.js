// fake-idb.js — in-memory IndexedDB, just enough for the stores in this repo:
// open/upgrade, multi-store transactions, put/get/getAll/delete, atomic commit,
// abort, and an injectable failure.
//
//   const idb = fakeIdb({ failOn: ({ store, op, n }) => error | null })
//
// `failOn` runs on every put/delete (n counts them across the transaction).
// Returning an Error fails that request asynchronously and aborts the
// transaction: nothing the transaction wrote is committed, like the real thing.
// `idb.data` is Map<storeName, Map<key, value>> of committed state.

export function quotaError() {
  const e = new Error('quota')
  e.name = 'QuotaExceededError'
  return e
}

export function fakeIdb({ failOn = null } = {}) {
  const data = new Map()
  const keyPaths = new Map()
  const later = fn => queueMicrotask(fn)

  function makeTx(names, mode) {
    const tx = { error: null }
    const work = new Map(names.map(n => [n, new Map(data.get(n))]))
    let n = 0, pending = 0, finished = false
    const settle = () => {
      if (finished || pending) return
      setTimeout(() => {
        if (finished || pending) return
        finished = true
        if (mode === 'readwrite') for (const [name, m] of work) data.set(name, m)
        tx.oncomplete?.()
      }, 0)
    }
    const abort = error => {
      if (finished) return
      finished = true
      tx.error = error
      tx.onabort?.()
    }
    const req = fn => {
      const r = {}
      pending++
      later(() => {
        pending--
        if (finished) return
        try { r.result = fn() } catch (e) { r.error = e; r.onerror?.(); abort(e); return }
        r.onsuccess?.()
        settle()
      })
      return r
    }
    const write = (store, op, fn) => req(() => {
      const err = failOn?.({ store, op, n: ++n })
      if (err) throw err
      return fn()
    })
    tx.abort = () => abort(new Error('aborted'))
    tx.objectStore = name => {
      if (!work.has(name)) throw new Error(`no store ${name} in transaction`)
      const m = work.get(name), kp = keyPaths.get(name)
      return {
        put: (value, key) => write(name, 'put', () => { const k = kp ? value[kp] : key; m.set(k, value); return k }),
        delete: key => write(name, 'delete', () => { m.delete(key) }),
        get: key => req(() => m.get(key)),
        getAll: () => req(() => [...m.values()])
      }
    }
    settle()
    return tx
  }

  const db = {
    objectStoreNames: { contains: name => data.has(name) },
    createObjectStore(name, opts) { data.set(name, new Map()); keyPaths.set(name, opts?.keyPath ?? null) },
    transaction(names, mode = 'readonly') { return makeTx([].concat(names), mode) }
  }
  return {
    data,
    open() {
      const r = { result: db }
      later(() => { r.onupgradeneeded?.({ target: r }); r.onsuccess?.() })
      return r
    }
  }
}
