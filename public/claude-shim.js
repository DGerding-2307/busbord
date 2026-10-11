/*
 * Voertuigenbord – koppeling voor zelf hosten.
 * Biedt dezelfde window.claude.use('db' | 'downloads' | 'user') als claude.ai,
 * maar dan op de eigen server (server.js). Draait de pagina binnen claude.ai,
 * dan doet dit bestand niets.
 */
(function () {
  if (window.claude && typeof window.claude.use === 'function') return;
  window.__BUSBORD_SELFHOSTED = true;

  var API = 'api';
  var store = Object.create(null);      // pad -> document
  var listeners = new Set();
  var ready = false, waiters = [];
  var statusEl = null;

  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function setStatus(ok, text) {
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.setAttribute('role', 'status');
      statusEl.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:50;padding:6px 10px;font:600 13px/1.3 "Source Sans 3",Arial,sans-serif;background:#DC281E;color:#fff;display:none';
      (document.body || document.documentElement).appendChild(statusEl);
    }
    statusEl.textContent = text || '';
    statusEl.style.display = ok ? 'none' : 'block';
  }
  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); }
  function markReady() { if (!ready) { ready = true; waiters.splice(0).forEach(function (r) { r(); }); } }
  function whenReady() { return ready ? Promise.resolve() : new Promise(function (r) { waiters.push(r); }); }

  function applyState(docs) {
    store = Object.create(null);
    Object.keys(docs || {}).forEach(function (k) { store[k] = docs[k]; });
    markReady(); notify();
  }
  function applyChange(ch) {
    if (!ch || !ch.path) return;
    if (ch.data == null) delete store[ch.path]; else store[ch.path] = ch.data;
    notify();
  }

  // ---- verbinding: Server-Sent Events, met terugval op periodiek ophalen ----
  var pollTimer = null;
  function toLogin() { location.href = 'login.html'; }
  function poll() {
    fetch(API + '/state', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { if (r.status === 401) { toLogin(); throw new Error('401'); } if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) { applyState(j.docs); setStatus(true); })
      .catch(function () { setStatus(false, 'Geen verbinding met de server. Wijzigingen worden niet opgeslagen.'); });
  }
  function connect() {
    if (!window.EventSource) { poll(); pollTimer = setInterval(poll, 4000); return; }
    var es = new EventSource(API + '/events', { withCredentials: true });
    es.addEventListener('state', function (e) { try { applyState(JSON.parse(e.data).docs); setStatus(true); } catch (err) { console.error(err); } });
    es.addEventListener('change', function (e) { try { applyChange(JSON.parse(e.data)); } catch (err) { console.error(err); } });
    es.addEventListener('reload', function () { location.reload(); });
    es.addEventListener('logout', function () { es.close(); toLogin(); });
    es.onerror = function () {
      setStatus(false, 'Verbinding met de server verbroken. Opnieuw verbinden…');
      fetch(API + '/me', { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { if (r.status === 401) { es.close(); toLogin(); } }, function () {});
    };
    es.onopen = function () { setStatus(true); };
  }

  function post(ops) {
    return fetch(API + '/write', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: ops })
    }).then(function (r) {
      if (r.ok) return;
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) toLogin();
        var err = { code: r.status === 403 ? 'permission_denied' : r.status === 400 ? 'invalid_argument' : r.status === 413 ? 'quota_exceeded' : 'unavailable', message: j.error || ('HTTP ' + r.status) };
        poll(); throw err;
      });
    }, function () { poll(); throw { code: 'unavailable', message: 'Server niet bereikbaar' }; });
  }

  // ---- db-namespace (zelfde vorm als claude.ai) ----
  function segs(p) { return String(p).split('/').filter(Boolean); }
  function checkPath(p, even) {
    var s = segs(p);
    if (!s.length || s.some(function (x) { return !/^[A-Za-z0-9_\-.~:@+]+$/.test(x) || x === '.' || x === '..'; }) || (s.length % 2 === 0) !== even)
      throw new TypeError('Ongeldig pad: ' + p);
    return s.join('/');
  }
  function snapDoc(path) {
    var d = store[path];
    return { id: segs(path).pop(), exists: d !== undefined, data: function () { return clone(d); }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function newId() { var c = 'abcdefghijklmnopqrstuvwxyz0123456789', s = ''; for (var i = 0; i < 20; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }
  function deepMerge(a, b) {
    var out = Object.assign({}, a || {});
    Object.keys(b || {}).forEach(function (k) {
      var v = b[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
      else out[k] = v;
    });
    return out;
  }
  function cmp(op, a, b) {
    switch (op) {
      case '==': return a === b; case '!=': return a !== b; case '<': return a < b; case '<=': return a <= b;
      case '>': return a > b; case '>=': return a >= b; case 'in': return Array.isArray(b) && b.indexOf(a) >= 0;
      case 'not-in': return Array.isArray(b) && b.indexOf(a) < 0; case 'array-contains': return Array.isArray(a) && a.indexOf(b) >= 0;
    }
    return false;
  }

  function docRef(path) {
    path = checkPath(path, true);
    return {
      id: segs(path).pop(), path: path,
      get: function () { return whenReady().then(function () { return snapDoc(path); }); },
      set: function (data) { var d = clone(data); store[path] = d; notify(); return post([{ op: 'set', path: path, data: d }]); },
      update: function (data) {
        if (store[path] === undefined) return Promise.reject({ code: 'invalid_argument', message: 'Document bestaat niet' });
        store[path] = deepMerge(store[path], clone(data)); notify();
        return post([{ op: 'update', path: path, data: clone(data) }]);
      },
      delete: function () { delete store[path]; notify(); return post([{ op: 'delete', path: path }]); },
      acquire: function () { return Promise.resolve({ acquired: true }); },
      onSnapshot: function (next) {
        var last;
        var fn = function () { if (!ready) return; var d = JSON.stringify(store[path]); if (d === last) return; last = d; next(snapDoc(path)); };
        listeners.add(fn); if (ready) setTimeout(fn, 0);
        return function () { listeners.delete(fn); };
      },
      collection: function (sub) { return colRef(path + '/' + sub); }
    };
  }
  function makeQuery(col, wh, ord, lim) {
    function run() {
      var depth = segs(col).length + 1;
      var docs = Object.keys(store).filter(function (k) { return k.indexOf(col + '/') === 0 && segs(k).length === depth; })
        .map(function (k) { return snapDoc(k); });
      wh.forEach(function (w) { docs = docs.filter(function (d) { return cmp(w[1], (d.data() || {})[w[0]], w[2]); }); });
      if (ord) {
        docs.sort(function (a, b) {
          var x = (a.data() || {})[ord[0]], y = (b.data() || {})[ord[0]];
          if (x === undefined && y === undefined) return 0; if (x === undefined) return 1; if (y === undefined) return -1;
          var r = x < y ? -1 : x > y ? 1 : 0; return ord[1] === 'desc' ? -r : r;
        });
      } else docs.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
      if (lim) docs = docs.slice(0, lim);
      return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return docs.map(function (d, i) { return { type: 'added', doc: d, oldIndex: -1, newIndex: i }; }); }, metadata: { fromCache: false, hasPendingWrites: false } };
    }
    return {
      where: function (f, op, v) { return makeQuery(col, wh.concat([[f, op, v]]), ord, lim); },
      orderBy: function (f, dir) { return makeQuery(col, wh, [f, dir || 'asc'], lim); },
      limit: function (n) { return makeQuery(col, wh, ord, n); },
      get: function () { return whenReady().then(run); },
      onSnapshot: function (next) {
        var last;
        var fn = function () {
          if (!ready) return; var q = run();
          var sig = JSON.stringify(q.docs.map(function (d) { return [d.id, store[col + '/' + d.id]]; }));
          if (sig === last) return; last = sig; next(q);
        };
        listeners.add(fn); if (ready) setTimeout(fn, 0);
        return function () { listeners.delete(fn); };
      }
    };
  }
  function colRef(path) {
    path = checkPath(path, false);
    var q = makeQuery(path, [], null, 0);
    q.path = path;
    q.doc = function (id) { return docRef(path + '/' + (id || newId())); };
    q.add = function (data) { var r = q.doc(); return r.set(data).then(function () { return r; }); };
    return q;
  }
  var db = Object.freeze({ doc: docRef, collection: colRef });

  // ---- downloads: gewoon een bestand laten opslaan ----
  var downloads = Object.freeze({
    save: function (req) {
      try {
        var blob = req.data instanceof Blob ? req.data : new Blob([req.data]);
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = req.filename || 'bestand';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        return Promise.resolve({ status: 'saved' });
      } catch (e) { return Promise.reject({ code: 'unavailable', message: String(e) }); }
    }
  });

  // ---- user: de ingelogde gebruiker van de eigen server ----
  var meP = null;
  function getMe() {
    if (!meP) meP = fetch(API + '/me', { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { if (r.status === 401) { toLogin(); throw new Error('401'); } return r.json(); });
    return meP;
  }
  window.__BB_ME = getMe;
  var user = Object.freeze({
    isOwner: function () { return true; }, canEdit: function () { return true; },
    can: function () { return getMe().then(function (u) { return u.rol !== 'waarnemer'; }); },
    id: function () { return getMe().then(function (u) { return u.id; }); },
    me: function () { return getMe().then(function (u) { return { id: u.id, name: u.naam }; }); },
    profiles: function () { return Promise.resolve({}); }
  });

  var caps = { db: db, downloads: downloads, user: user };
  window.claude = Object.freeze({ use: function (name) { return Promise.resolve(caps[name] || null); } });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connect); else connect();
})();
