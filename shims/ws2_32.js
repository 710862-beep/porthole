/* Async JS socket facade, not a guest ABI. No implicit proxy/TCP-over-fetch.
 * The embedding host supplies an authorized byte-stream transport and policy.
 * Browser use requires an explicit bridge; denied by default.
 */
(function (global) {
  'use strict';
  const P = global.Porthole = global.Porthole || {};
  class WinSockShim {
    constructor({ transport = null, authorize = () => false } = {}) {
      this.transport = transport; this.authorize = authorize; this.refs = 0; this.lastError = 0; this.next = 1; this.sockets = new Map();
    }
    _error(code, result = -1) { this.lastError = code; return result; }
    _allowed(host, port) { try { return this.authorize(host, port) === true; } catch { return false; } }
    WSAGetLastError() { return this.lastError; }
    WSAStartup(version = 0x202) { if (version !== 0x202) return 10092; this.refs++; return 0; }
    WSACleanup() { if (!this.refs) return this._error(10093); if (--this.refs === 0) for (const handle of [...this.sockets.keys()]) this.closesocket(handle); return 0; }
    socket(family = 2, type = 1, protocol = 6) {
      if (!this.refs) return this._error(10093);
      if (family !== 2 || type !== 1 || ![0, 6].includes(protocol)) return this._error(10043);
      const handle = this.next++; this.sockets.set(handle, { connection: null, state: 'new' }); return handle;
    }
    async getaddrinfo(host, port) {
      if (!this.refs) return this._error(10093, null);
      if (typeof host !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535) return this._error(10022, null);
      if (!this._allowed(host, port)) return this._error(10013, null);
      if (!this.transport?.resolve) return this._error(10045, null);
      try { return await this.transport.resolve(host, port); } catch { return this._error(11001, null); }
    }
    async gethostbyname(host) { const addresses = await this.getaddrinfo(host, 80); return addresses ? { name: host, addresses } : null; }
    freeaddrinfo() { /* JS owns result lifetime; no binary pointers exposed. */ }
    async connect(handle, host, port) {
      if (!this.refs) return this._error(10093);
      const s = this.sockets.get(handle); if (!s) return this._error(10038);
      if (s.state !== 'new') return this._error(s.state === 'connecting' ? 10037 : 10056);
      if (typeof host !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535) return this._error(10022);
      if (!this._allowed(host, port)) return this._error(10013);
      if (!this.transport?.connect) return this._error(10045);
      s.state = 'connecting';
      try {
        const connection = await this.transport.connect(host, port);
        if (this.sockets.get(handle) !== s) { connection.close(); return this._error(10038); }
        s.connection = connection; s.state = 'connected'; return 0;
      } catch { s.state = 'new'; return this._error(10061); }
    }
    async send(handle, bytes, flags = 0) {
      const s = this.sockets.get(handle); if (!s) return this._error(10038);
      if (!s.connection) return this._error(10057);
      if (!(bytes instanceof Uint8Array) || flags !== 0) return this._error(10022);
      try {
        const count = await s.connection.send(bytes.slice());
        if (!Number.isInteger(count) || count < 0 || count > bytes.length) return this._error(10022);
        return count;
      } catch { return this._error(10054); }
    }
    async recv(handle, maximum, flags = 0) {
      const s = this.sockets.get(handle); if (!s) return this._error(10038, null);
      if (!s.connection) return this._error(10057, null);
      if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1048576 || flags !== 0) return this._error(10022, null);
      try {
        const bytes = await s.connection.recv(maximum);
        if (!(bytes instanceof Uint8Array) || bytes.length > maximum) return this._error(10022, null);
        return bytes.slice(); // empty means real stream EOF, not fabricated success
      } catch { return this._error(10054, null); }
    }
    closesocket(handle) {
      const s = this.sockets.get(handle); if (!s) return this._error(10038);
      this.sockets.delete(handle); s.state = 'closed';
      try { s.connection?.close(); return 0; } catch { return this._error(10054); }
    }
  }
  P.WinSockShim = WinSockShim;
})(globalThis);
