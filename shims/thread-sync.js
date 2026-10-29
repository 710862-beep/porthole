/* Standalone asynchronous JS synchronization model. NOT a Wasm CPU scheduler
 * or a binary Win32 ABI. The guest bridge must suspend/resume CPUs explicitly.
 */
(function (global) {
  'use strict';
  const P = global.Porthole = global.Porthole || {};
  const WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 258, WAIT_FAILED = 0xffffffff, INFINITE = 0xffffffff;
  class ThreadSync {
    constructor() { this.objects = new Map(); this.next = 1; this.waiters = new Set(); this.critical = new Map(); this.tls = new Map(); this.nextTls = 0; this.lastError = 0; }
    _error(code, value = false) { this.lastError = code; return value; }
    _add(object) { const handle = this.next++; this.objects.set(handle, object); return handle; }
    CreateEvent(manualReset = false, initialState = false) { return this._add({ type: 'event', manualReset: !!manualReset, signaled: !!initialState }); }
    SetEvent(handle) { const o = this.objects.get(handle); if (o?.type !== 'event') return this._error(6); o.signaled = true; this._notify(); return true; }
    ResetEvent(handle) { const o = this.objects.get(handle); if (o?.type !== 'event') return this._error(6); o.signaled = false; return true; }
    CreateSemaphore(initial, maximum) {
      if (!Number.isInteger(initial) || !Number.isInteger(maximum) || initial < 0 || maximum < 1 || initial > maximum || maximum > 0x7fffffff) return this._error(87, 0);
      return this._add({ type: 'semaphore', count: initial, maximum });
    }
    ReleaseSemaphore(handle, count = 1) {
      const o = this.objects.get(handle);
      if (o?.type !== 'semaphore') return this._error(6);
      if (!Number.isInteger(count) || count < 1) return this._error(87);
      if (o.count + count > o.maximum) return this._error(298);
      const previous = o.count; o.count += count; this._notify(); return { previous };
    }
    CloseHandle(handle) { if (!this.objects.delete(handle)) return this._error(6); this._notify(); return true; }
    _ready(o) { return o.type === 'semaphore' ? o.count > 0 : o.signaled; }
    _consume(o) { if (o.type === 'semaphore') o.count--; else if (!o.manualReset) o.signaled = false; }
    WaitForSingleObject(handle, timeout = INFINITE) { return this.WaitForMultipleObjects([handle], false, timeout); }
    WaitForMultipleObjects(handles, all = false, timeout = INFINITE) {
      if (!Array.isArray(handles) || !handles.length || handles.length > 64 || new Set(handles).size !== handles.length || !Number.isInteger(timeout) || timeout < 0 || timeout > INFINITE) return Promise.resolve(this._error(87, WAIT_FAILED));
      return new Promise(resolve => {
        let timer;
        const finish = value => { clearTimeout(timer); this.waiters.delete(check); resolve(value); };
        const check = () => {
          const objects = handles.map(h => this.objects.get(h));
          if (objects.some(o => !o)) { this._error(6); finish(WAIT_FAILED); return; }
          // All readiness tests and consumption occur in the same JS turn.
          if (all) { if (objects.every(o => this._ready(o))) { objects.forEach(o => this._consume(o)); finish(WAIT_OBJECT_0); } }
          else { const index = objects.findIndex(o => this._ready(o)); if (index >= 0) { this._consume(objects[index]); finish(WAIT_OBJECT_0 + index); } }
        };
        this.waiters.add(check); check();
        if (!this.waiters.has(check)) return;
        if (!timeout) { finish(WAIT_TIMEOUT); return; }
        if (timeout !== INFINITE) {
          // Node clamps delays above INT32_MAX; split long finite waits.
          const until = performance.now() + timeout;
          const expire = () => { const remaining = until - performance.now(); if (remaining <= 0) finish(WAIT_TIMEOUT); else timer = setTimeout(expire, Math.min(remaining, 0x7fffffff)); };
          expire();
        }
      });
    }
    _notify() { for (const check of [...this.waiters]) check(); }
    InitializeCriticalSection(key) { if (this.critical.has(key)) return this._error(87); this.critical.set(key, { owner: null, depth: 0, queue: [] }); return true; }
    EnterCriticalSection(key, threadId) {
      const c = this.critical.get(key);
      if (!c || !Number.isInteger(threadId) || threadId < 0) return Promise.reject(new Error('Invalid critical section/thread'));
      if (c.owner === null || c.owner === threadId) { c.owner = threadId; c.depth++; return Promise.resolve(true); }
      return new Promise(resolve => c.queue.push({ threadId, resolve }));
    }
    LeaveCriticalSection(key, threadId) {
      const c = this.critical.get(key); if (!c || c.owner !== threadId) return this._error(288);
      if (--c.depth === 0) { const next = c.queue.shift(); c.owner = next ? next.threadId : null; if (next) { c.depth = 1; next.resolve(true); } }
      return true;
    }
    DeleteCriticalSection(key) { const c = this.critical.get(key); if (!c || c.depth || c.queue.length) return this._error(170); return this.critical.delete(key); }
    TlsAlloc() { const slot = this.nextTls++; this.tls.set(slot, new Map()); return slot; }
    TlsSetValue(slot, threadId, value) { const values = this.tls.get(slot); if (!values) return this._error(87); values.set(threadId, value); return true; }
    TlsGetValue(slot, threadId) { const values = this.tls.get(slot); if (!values) return this._error(87, 0); this.lastError = 0; return values.get(threadId) ?? 0; }
    TlsFree(slot) { return this.tls.delete(slot) || this._error(87); }
    dispose() { this.objects.clear(); this._notify(); for (const c of this.critical.values()) for (const w of c.queue) w.resolve(false); this.critical.clear(); this.tls.clear(); }
  }
  Object.assign(P, { ThreadSync, THREAD_WAIT: { WAIT_OBJECT_0, WAIT_TIMEOUT, WAIT_FAILED, INFINITE } });
})(globalThis);
