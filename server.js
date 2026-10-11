#!/usr/bin/env node
/*
 * Voertuigenbord logistiek – eigen server
 * Geen extra pakketten nodig: alleen Node.js 18 of nieuwer.
 *
 *   node server.js
 *
 * Instellingen via omgevingsvariabelen:
 *   PORT=8080                 poort (standaard 8080)
 *   HOST=0.0.0.0              adres om op te luisteren
 *   DATA_DIR=./data           map voor de gegevens (busbord.json, users.json, back-ups)
 *   BUSBORD_USER=...          gebruikersnaam van de eerste beheerder (alleen bij de allereerste start)
 *   BUSBORD_PASSWORD=...      wachtwoord van de eerste beheerder (alleen bij de allereerste start)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'busbord.json');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESS_FILE = path.join(DATA_DIR, 'sessions.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const FILE_DIR = path.join(DATA_DIR, 'files');
const MAX_FILE = 20 * 1024 * 1024;
const BOOT_USER = process.env.BUSBORD_USER || 'admin';
const BOOT_PASS = process.env.BUSBORD_PASSWORD || '';
const MAX_BODY = 2 * 1024 * 1024;
const SESSION_DAYS = 30;
const ROLES = ['admin', 'coordinator', 'centralist', 'chauffeur', 'waarnemer'];

const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const rid = (n = 10) => crypto.randomBytes(n).toString('hex');
function writeJSON(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

// ---------- opslag ----------
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(FILE_DIR, { recursive: true });
let docs = {};
function load() {
  for (const f of [DATA_FILE, SEED_FILE]) {
    try {
      if (fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        docs = j.docs || j;
        console.log(`Gegevens geladen uit ${path.basename(f)} (${Object.keys(docs).length} documenten)`);
        return;
      }
    } catch (e) { console.error(`Kon ${f} niet lezen:`, e.message); }
  }
  console.log('Lege opslag gestart.');
}
load();

// Oude opbouw (buses/, ritten/, log/, config/main) omzetten naar één evenement.
function migrate() {
  const keys = Object.keys(docs);
  const old = keys.filter(k => /^(buses|ritten|log|config)\//.test(k));
  if (!old.length) return false;
  const cfg = docs['config/main'] || {};
  const dates = new Set([cfg.datum, ...(cfg.dagen || []).map(d => d && d.datum)].filter(Boolean));
  for (const k of old) if (k.startsWith('ritten/') && docs[k].datum) dates.add(docs[k].datum);
  const sorted = [...dates].sort();
  let id = 'e4mijl2026';
  while (docs['events/' + id]) id = 'e' + rid(4);
  docs['events/' + id] = {
    naam: 'Menzis 4 Mijl van Groningen', locatie: 'Osloweg', plaats: 'Groningen', basis: 'Osloweg, Groningen',
    van: sorted[0] || cfg.datum || today(), tot: sorted[sorted.length - 1] || cfg.datum || today(),
    meldkamer: '', standaardDuur: cfg.standaardDuur || 20, aangemaakt: Date.now()
  };
  for (const k of old) {
    if (!k.startsWith('config/')) {
      const d = docs[k];
      if (k.startsWith('ritten/') && !d.datum) d.datum = cfg.datum || sorted[0] || today();
      docs['ev/' + id + '/' + k] = d;
    }
    delete docs[k];
  }
  console.log(`Oude gegevens omgezet naar evenement "${docs['events/' + id].naam}" (${id}).`);
  return true;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { writeJSON(DATA_FILE, { docs, savedAt: new Date().toISOString() }); }
    catch (e) { console.error('Opslaan mislukt:', e.message); }
  }, 250);
}
function backup() {
  try {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    fs.writeFileSync(path.join(BACKUP_DIR, `busbord-${stamp}.json`), JSON.stringify({ docs }));
    fs.writeFileSync(path.join(BACKUP_DIR, `users-${stamp}.json`), JSON.stringify({ users }));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 400))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  } catch (e) { console.error('Back-up mislukt:', e.message); }
}
let dirty = false;
setInterval(() => { if (dirty) { dirty = false; backup(); } }, 10 * 60 * 1000);

// ---------- gebruikers ----------
let users = [];
try { if (fs.existsSync(USERS_FILE)) users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users || []; }
catch (e) { console.error('Kon users.json niet lezen:', e.message); }
function saveUsers() { try { writeJSON(USERS_FILE, { users }); } catch (e) { console.error('Gebruikers opslaan mislukt:', e.message); } }
if (!users.length) {
  const pass = BOOT_PASS || rid(5);
  users.push({ id: 'u' + rid(5), naam: 'Beheerder', gebruikersnaam: BOOT_USER, wachtwoord: pass, rol: 'admin', evenementen: [], voertuig: {}, actief: true, aangemaakt: Date.now() });
  saveUsers();
  console.log(`Eerste beheerder aangemaakt: gebruikersnaam "${BOOT_USER}"${BOOT_PASS ? ' (wachtwoord uit BUSBORD_PASSWORD)' : `, wachtwoord "${pass}"`}.`);
}
const userById = id => users.find(u => u.id === id);
const userByName = n => users.find(u => String(u.gebruikersnaam).toLowerCase() === String(n || '').trim().toLowerCase());
const WEAK = ['verander-dit-wachtwoord', 'wachtwoord', 'password', 'welkom', 'welkom01', 'rodekruis', 'admin', '123456', '12345678', 'qwerty'];
const weakPw = pw => { pw = String(pw || ''); return pw.length < 8 || WEAK.includes(pw.toLowerCase()); };
const publicUser = u => ({ id: u.id, naam: u.naam, gebruikersnaam: u.gebruikersnaam, rol: u.rol, evenementen: u.evenementen || [], voertuig: u.voertuig || {}, telefoon: u.telefoon || '' });

if (migrate()) save();

// ---------- sessies ----------
let sessions = {};
try { if (fs.existsSync(SESS_FILE)) sessions = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8')) || {}; } catch (_) { sessions = {}; }
let sessTimer = null;
function saveSessions() { clearTimeout(sessTimer); sessTimer = setTimeout(() => { try { writeJSON(SESS_FILE, sessions); } catch (_) {} }, 1000); }
function pruneSessions() {
  const max = SESSION_DAYS * 86400000, now = Date.now();
  for (const [t, s] of Object.entries(sessions)) if (now - s.t > max || !userById(s.uid)) delete sessions[t];
  saveSessions();
}
pruneSessions();
setInterval(pruneSessions, 3600 * 1000);
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function sessionOf(req) {
  const tok = cookies(req).bb_sess;
  const s = tok && sessions[tok];
  if (!s) return null;
  const u = userById(s.uid);
  if (!u || u.actief === false) return null;
  if (Date.now() - s.t > 3600000) { s.t = Date.now(); saveSessions(); }
  markOnline(u.id);
  return { token: tok, user: u };
}
function endSessions(uid, keep) {
  for (const [t, s] of Object.entries(sessions)) if (s.uid === uid && t !== keep) delete sessions[t];
  saveSessions();
  for (const c of [...clients]) if (c.uid === uid && c.token !== keep) { try { send(c.res, 'logout', {}); c.res.end(); } catch (_) {} clients.delete(c); }
}
const fails = new Map();   // ip -> {n, t}
function tooMany(ip, max) { const f = fails.get(ip); return !!f && f.n >= (max || 8) && Date.now() - f.t < 5 * 60000; }
setInterval(() => { const now = Date.now(); for (const [k, f] of fails) if (now - f.t > 15 * 60000) fails.delete(k); }, 5 * 60000);
// vergelijk geheimen met vaste duur, ook bij verschillende lengte
function sameSecret(a, b) {
  const h = x => crypto.createHash('sha256').update(String(x)).digest();
  return crypto.timingSafeEqual(h(a), h(b)) && String(a) === String(b);
}
function failed(ip) { const f = fails.get(ip) || { n: 0, t: 0 }; if (Date.now() - f.t > 10 * 60000) f.n = 0; f.n++; f.t = Date.now(); fails.set(ip, f); }

// ---------- rechten ----------
function where(p) {
  const s = String(p).split('/');
  if (s[0] === 'events' && s.length === 2) return { kind: 'event', E: s[1] };
  if (s[0] === 'ev' && s.length === 4) return { kind: s[2], E: s[1], id: s[3] };
  return { kind: 'other' };
}
const seesEvent = (u, E) => u.rol === 'admin' || (u.evenementen || []).includes(E);
function visible(u, p, data) {
  const w = where(p);
  if (w.kind === 'other') return u.rol === 'admin';
  if (!seesEvent(u, w.E)) return false;
  if (u.rol !== 'chauffeur' || w.kind === 'event') return true;
  const own = (u.voertuig || {})[w.E];
  if (!own) return false;
  if (w.kind === 'buses') return w.id === own;
  if (w.kind === 'ritten' || w.kind === 'log') return !!data && data.busId === own;
  return false;
}
function stateFor(u) { const out = {}; for (const [k, v] of Object.entries(docs)) if (visible(u, k, v)) out[k] = v; return out; }

const MOVE_FIELDS = new Set(['fase', 'wv', 'wa', 'rs', 'wr', 'wvd', 'wad', 'rsd', 'wrd']);
function refuse(u, o) {
  const r = u.rol, w = where(o.path), cur = docs[o.path], keys = Object.keys(o.data || {});
  if (r === 'waarnemer') return 'Als waarnemer kun je alleen meekijken.';
  if (w.kind === 'other') return r === 'admin' ? null : 'Geen rechten.';
  if (w.kind === 'event') {
    if (o.op === 'delete') return r === 'admin' ? null : 'Alleen een admin kan een evenement verwijderen.';
    if (r === 'admin') return null;
    if (r === 'coordinator') return (cur === undefined || seesEvent(u, w.E)) ? null : 'Geen toegang tot dit evenement.';
    return 'Alleen een admin of coördinator kan evenementen beheren.';
  }
  if (!seesEvent(u, w.E)) return 'Geen toegang tot dit evenement.';
  if (!docs['events/' + w.E]) return 'Dit evenement bestaat niet (meer).';
  if (r === 'admin' || r === 'coordinator') return null;
  if (r === 'centralist') {
    if (o.op === 'delete') return 'Als centralist kun je niets verwijderen.';
    if (w.kind === 'ritten') return null;
    if (w.kind === 'buses') return (o.op === 'update' && keys.every(k => k === 'status' || k === 'notitie')) ? null : 'Als centralist kun je van een voertuig alleen de status en notitie wijzigen.';
    if (w.kind === 'log') return (o.op === 'set' && cur === undefined) ? null : 'Als centralist kun je logregels toevoegen, niet wijzigen.';
    return 'Geen rechten.';
  }
  if (r === 'chauffeur') {
    const own = (u.voertuig || {})[w.E];
    if (!own) return 'Je bent nog niet aan een voertuig gekoppeld.';
    if (o.op === 'delete') return 'Als chauffeur kun je niets verwijderen.';
    if (w.kind === 'ritten') {
      if (cur === undefined) return (o.op === 'set' && o.data.busId === own) ? null : 'Je kunt alleen ritten voor je eigen voertuig aanmaken.';
      if (cur.busId !== own) return 'Dit is niet een rit van jouw voertuig.';
      return (o.op === 'update' && keys.every(k => MOVE_FIELDS.has(k))) ? null : 'Als chauffeur kun je een rit alleen doorzetten.';
    }
    if (w.kind === 'buses') return (w.id === own && o.op === 'update' && keys.every(k => k === 'status')) ? null : 'Geen rechten.';
    if (w.kind === 'log') return (o.op === 'set' && cur === undefined && o.data.busId === own) ? null : 'Geen rechten.';
    return 'Geen rechten.';
  }
  return 'Geen rechten.';
}

const FASE_IDS = ['gepland', 'onderweg', 'aangekomen', 'retour', 'afgerond'];
const SOORT_IDS = ['personen', 'materiaal', 'beide'];
const STATUS_IDS = ['vrij', 'bezet', 'terug'];
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
// geeft een foutmelding terug als een document niet klopt
function badData(kind, data, depth) {
  depth = depth || 0;
  if (depth > 5) return 'Te diep genest';
  for (const [k, v] of Object.entries(data)) {
    if (BAD_KEYS.has(k) || k.length > 60) return 'Ongeldige veldnaam';
    if (typeof v === 'string' && v.length > 4000) return `Veld ${k} is te lang`;
    if (v && typeof v === 'object') { if (Array.isArray(v) ? v.length > 200 : false) return 'Te veel waarden'; const e = badData(null, Array.isArray(v) ? Object.assign({}, v) : v, depth + 1); if (e) return e; }
  }
  if (depth) return null;
  const chk = (k, ok) => (data[k] === undefined || ok(data[k])) ? null : `Ongeldige waarde voor ${k}`;
  const t = v => v === '' || (typeof v === 'string' && TIME.test(v));
  const d = v => v === '' || v === null || (typeof v === 'string' && DATE.test(v));
  if (kind === 'ritten') {
    for (const k of ['gv', 'ga', 'gr', 'wv', 'wa', 'rs', 'wr']) { const e = chk(k, t); if (e) return e; }
    for (const k of ['datum', 'wvd', 'wad', 'rsd', 'wrd']) { const e = chk(k, d); if (e) return e; }
    return chk('fase', v => FASE_IDS.includes(v)) || chk('soort', v => SOORT_IDS.includes(v)) ||
      chk('bestellijst', v => v === null || (typeof v === 'object' && /^[a-f0-9]{24}$/.test(v.id) && typeof (v.naam || '') === 'string')) ||
      chk('geenRetour', v => typeof v === 'boolean') || chk('busId', v => typeof v === 'string' && (v === '' || SEG.test(v)));
  }
  if (kind === 'buses') return chk('status', v => STATUS_IDS.includes(v));
  if (kind === 'log') return chk('soort', v => v === 'auto' || v === 'notitie') || chk('busId', v => typeof v === 'string' && (v === '' || SEG.test(v)));
  if (kind === 'event') return chk('van', d) || chk('tot', d) || chk('standaardDuur', v => Number.isFinite(+v) && +v > 0 && +v < 1000);
  return null;
}
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function validDocPath(p) {
  if (typeof p !== 'string' || p.length > 1000) return false;
  const s = p.split('/');
  return s.length % 2 === 0 && s.length <= 16 && s.every(x => SEG.test(x) && x !== '.' && x !== '..');
}
function deepMerge(a, b) {
  const out = Object.assign({}, a || {});
  for (const k of Object.keys(b || {})) {
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

// ---------- live verbindingen ----------
const clients = new Set();   // {res, uid, token}
function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcastChange(p, data, prev) {
  for (const c of clients) {
    const u = userById(c.uid); if (!u) continue;
    try {
      if (data != null && visible(u, p, data)) send(c.res, 'change', { path: p, data });
      else if (prev !== undefined && visible(u, p, prev)) send(c.res, 'change', { path: p, data: null });
    } catch (_) {}
  }
}
function broadcastState(onlyUid) {
  for (const c of clients) {
    if (onlyUid && c.uid !== onlyUid) continue;
    const u = userById(c.uid); if (!u) continue;
    try { send(c.res, 'state', { docs: stateFor(u) }); } catch (_) {}
  }
}
function tellUser(uid, event) { for (const c of clients) if (c.uid === uid) { try { send(c.res, event, {}); } catch (_) {} } }
setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch (_) {} } }, 25000);

// ---------- pushmeldingen (Web Push, zonder extra pakketten) ----------
const https = require('https');
const PUSH_FILE = path.join(DATA_DIR, 'push.json');
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.api\.chromium\.org$/];
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
let push = { vapid: null, subs: [] };
try { if (fs.existsSync(PUSH_FILE)) push = Object.assign(push, JSON.parse(fs.readFileSync(PUSH_FILE, 'utf8'))); } catch (e) { console.error('Kon push.json niet lezen:', e.message); }
if (!push.vapid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  push.vapid = { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
  savePush();
}
function savePush() { try { writeJSON(PUSH_FILE, push); } catch (e) { console.error('Push opslaan mislukt:', e.message); } }
const vapidKey = crypto.createPrivateKey(push.vapid.privateKey);
const jwtCache = new Map();
function vapidJWT(aud, sub) {
  const c = jwtCache.get(aud);
  if (c && c.exp - 3600 > Date.now() / 1000) return c.t;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const data = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' + b64u(JSON.stringify({ aud, exp, sub }));
  const sig = crypto.sign('sha256', Buffer.from(data), { key: vapidKey, dsaEncoding: 'ieee-p1363' });
  const t = data + '.' + b64u(sig);
  jwtCache.set(aud, { t, exp });
  return t;
}
// versleutelen volgens RFC 8291 (aes128gcm)
function encryptPayload(sub, text) {
  const uaPublic = unb64u(sub.keys.p256dh), authSecret = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, body]);
}
function sendPush(sub, payload) {
  return new Promise(resolve => {
    let u; try { u = new URL(sub.endpoint); } catch (_) { return resolve(0); }
    const body = encryptPayload(sub, JSON.stringify(payload));
    const req = https.request(u, {
      method: 'POST', timeout: 10000,
      headers: { 'TTL': '600', 'Urgency': 'high', 'Topic': String(payload.tag || 'rit').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'rit', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
        'Authorization': `vapid t=${vapidJWT(u.origin, push.contact || 'mailto:beheer@voertuigenbord.invalid')}, k=${push.vapid.publicKey}` }
    }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    req.end(body);
  }).then(code => {
    if (code === 404 || code === 410) { push.subs = push.subs.filter(s => s.endpoint !== sub.endpoint); savePush(); }
    else if (code && code >= 400) console.error('Pushmelding geweigerd (' + code + ') door', new URL(sub.endpoint).host);
    return code;
  });
}
// wie was de afgelopen 60 minuten online
const onlineAt = new Map();
const markOnline = uid => onlineAt.set(uid, Date.now());
setInterval(() => { for (const c of clients) markOnline(c.uid); }, 60000);
const ONLINE_MS = 60 * 60000;
const STAP = { gepland: 'Teruggezet naar gepland', onderweg: 'Vertrokken', aangekomen: 'Aangekomen', retour: 'Retour gestart', afgerond: 'Afgerond' };
function delayOf(r, f) {
  const toM = v => { const m = /^(\d{1,2}):(\d{2})$/.exec(v || ''); return m ? +m[1] * 60 + +m[2] : null; };
  const dd = (a, b) => Math.round((new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 86400000);
  const k = { onderweg: 'wv', aangekomen: 'wa', afgerond: 'wr' }[f]; if (!k || !r.datum) return null;
  const st = toM(r[k]); const plan = toM(f === 'onderweg' ? r.gv : f === 'aangekomen' ? r.ga : (r.geenRetour ? r.ga : r.gr));
  if (st == null || plan == null) return null;
  return st + (r[k + 'd'] ? dd(r[k + 'd'], r.datum) * 1440 : 0) - plan;
}
const fmtDelay = d => { const a = Math.abs(d); return a < 60 ? a + ' min' : a < 1440 ? Math.floor(a / 60) + ' u ' + (a % 60) + ' min' : Math.floor(a / 1440) + (Math.floor(a / 1440) === 1 ? ' dag' : ' dagen'); };
function notifyFase(p, prev, ride, actor) {
  if (!push.subs.length || !ride || (prev && prev.fase === ride.fase) || (!prev && (ride.fase || 'gepland') === 'gepland')) return;
  const w = where(p); const ev = docs['events/' + w.E] || {}; const bus = docs['ev/' + w.E + '/buses/' + ride.busId] || {};
  const f = ride.fase || 'gepland'; const d = delayOf(ride, f);
  const payload = {
    title: `Rit ${ride.nr} · ${STAP[f] || f}`,
    body: [[bus.naam, ride.bestemming && '→ ' + ride.bestemming].filter(Boolean).join(' '), [ev.naam, 'door ' + actor.naam, d == null ? '' : d > 0 ? '+' + fmtDelay(d) + ' te laat' : d < 0 ? fmtDelay(-d) + ' eerder' : 'op tijd'].filter(Boolean).join(' · ')].filter(Boolean).join('\n'),
    tag: 'rit-' + w.E + '-' + w.id, url: './#rit=' + w.E + '~' + w.id, t: Date.now(), laat: d != null && d >= 5
  };
  const now = Date.now();
  for (const s of push.subs) {
    if (s.uid === actor.id) continue;
    const u = userById(s.uid);
    if (!u || u.actief === false || now - (onlineAt.get(u.id) || 0) > ONLINE_MS || !visible(u, p, ride)) continue;
    if (process.env.PUSH_DEBUG) console.log('PUSH naar', u.gebruikersnaam, '|', payload.title, '|', payload.body.replace(/\n/g, ' / '));
    sendPush(s, payload);
  }
}

// ---------- http ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const OPEN_FILES = new Set(['/login.html', '/icon.svg', '/manifest.webmanifest', '/sw.js', '/icon-192.png', '/icon-512.png', '/badge-96.png', '/apple-touch-icon.png']);
function json(res, code, obj, headers) { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers || {})); res.end(JSON.stringify(obj)); }
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('te groot'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('te groot'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function bodyJSON(req, res) {
  if (!/application\/json/i.test(req.headers['content-type'] || '')) { json(res, 415, { error: 'Verwacht JSON' }); return null; }
  try { return JSON.parse(await readBody(req)); }
  catch (e) { json(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'Te groot' : 'Ongeldige JSON' }); return null; }
}
const isHttps = req => req.socket.encrypted || /https/i.test(String(req.headers['x-forwarded-proto'] || ''));
function sessCookie(req, tok, maxAge) {
  return `bb_sess=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}
// het laatste adres in X-Forwarded-For is door de eigen proxy toegevoegd; de eerste kan de bezoeker zelf verzinnen
const ipOf = req => { const x = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean); return x.length ? x[x.length - 1] : String(req.socket.remoteAddress || ''); };

function lastAdmin(exceptId) { return !users.some(u => u.id !== exceptId && u.rol === 'admin' && u.actief !== false); }
function cleanUser(input, existing) {
  const u = Object.assign({}, existing || {});
  const str = (v, n) => String(v ?? '').trim().slice(0, n);
  u.naam = str(input.naam, 80);
  u.gebruikersnaam = str(input.gebruikersnaam, 60);
  u.telefoon = str(input.telefoon, 30);
  if (input.wachtwoord !== undefined && input.wachtwoord !== null && String(input.wachtwoord) !== '') u.wachtwoord = String(input.wachtwoord).slice(0, 120);
  u.rol = ROLES.includes(input.rol) ? input.rol : (u.rol || 'waarnemer');
  u.evenementen = Array.isArray(input.evenementen) ? [...new Set(input.evenementen.map(String).filter(e => docs['events/' + e]))] : (u.evenementen || []);
  u.voertuig = {};
  if (input.voertuig && typeof input.voertuig === 'object') for (const [e, b] of Object.entries(input.voertuig)) if (b && u.evenementen.includes(e)) u.voertuig[e] = String(b);
  u.actief = input.actief !== false;
  if (!u.naam) return { error: 'Vul een naam in.' };
  if (!/^[A-Za-z0-9._@\-]{2,60}$/.test(u.gebruikersnaam)) return { error: 'Gebruikersnaam: 2 tot 60 tekens, alleen letters, cijfers en . _ - @' };
  if (!u.wachtwoord || String(u.wachtwoord).length < 4) return { error: 'Wachtwoord moet minstens 4 tekens zijn.' };
  const other = userByName(u.gebruikersnaam);
  if (other && other.id !== u.id) return { error: 'Deze gebruikersnaam bestaat al.' };
  return { user: u };
}

function resetEvent(E, mode, u) {
  const pre = 'ev/' + E + '/';
  let n = 0;
  for (const k of Object.keys(docs)) {
    if (!k.startsWith(pre)) continue;
    const kind = k.split('/')[2];
    if (mode === 'alles' || kind === 'log') { delete docs[k]; n++; continue; }
    if (kind === 'ritten') docs[k] = Object.assign({}, docs[k], { fase: 'gepland', wv: '', wa: '', rs: '', wr: '' });
    if (kind === 'buses') docs[k] = Object.assign({}, docs[k], { status: 'vrij' });
  }
  const lid = 'l' + Date.now().toString(36) + rid(2);
  const d = new Date();
  docs[pre + 'log/' + lid] = { busId: '', soort: 'auto', tekst: mode === 'alles' ? 'Evenement leeggemaakt' : 'Alle ritten teruggezet naar gepland, logboek gewist', tijd: String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'), t: Date.now(), gebruiker: u.naam, gebruikerId: u.id };
  return n;
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  try { await handle(req, res); }
  catch (e) {
    console.error('Fout bij', req.method, req.url, e && e.stack || e);
    try { if (!res.headersSent) json(res, 500, { error: 'Er ging iets mis op de server.' }); else res.end(); } catch (_) {}
  }
});
process.on('unhandledRejection', e => console.error('Onverwachte fout:', e));
process.on('uncaughtException', e => console.error('Onverwachte fout:', e));
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (_) { res.writeHead(400); return res.end(); }

  if (p === '/healthz') return json(res, 200, { ok: true, docs: Object.keys(docs).length, users: users.length, clients: clients.size });

  // inloggen
  if (p === '/api/login' && req.method === 'POST') {
    const b = await bodyJSON(req, res); if (!b) return;
    const ipOnly = ipOf(req) + '|*';
    const userKey = 'gebruiker|' + String(b.gebruikersnaam || '').trim().toLowerCase().slice(0, 60);
    const ip = ipOf(req) + '|' + String(b.gebruikersnaam || '').trim().toLowerCase().slice(0, 60);
    if (tooMany(ip) || tooMany(ipOnly, 30) || tooMany(userKey, 20)) return json(res, 429, { error: 'Te veel pogingen. Wacht vijf minuten.' });
    const u = userByName(b.gebruikersnaam);
    const ok = !!u && u.actief !== false && typeof b.wachtwoord === 'string' && sameSecret(b.wachtwoord, u.wachtwoord);
    if (!ok) { failed(ip); failed(ipOnly); failed(userKey); return json(res, 401, { error: 'Gebruikersnaam of wachtwoord klopt niet.' }); }
    fails.delete(ip);
    const tok = rid(24);
    sessions[tok] = { uid: u.id, t: Date.now() }; saveSessions();
    u.laatstIngelogd = Date.now(); saveUsers();
    return json(res, 200, { ok: true, user: publicUser(u) }, { 'Set-Cookie': sessCookie(req, tok, SESSION_DAYS * 86400) });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    const s = sessionOf(req);
    if (s) { delete sessions[s.token]; saveSessions(); for (const c of [...clients]) if (c.token === s.token) { try { c.res.end(); } catch (_) {} clients.delete(c); } }
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessCookie(req, '', 0) });
  }

  // inloggen met qr-code: /q/<code>
  const qm = p.match(/^\/q\/([a-f0-9]{32})$/);
  if (qm || p.startsWith('/q/')) {
    const ip = ipOf(req) + '|qr';
    const u = qm && !tooMany(ip) ? users.find(x => x.qrToken && x.qrToken === qm[1] && x.actief !== false) : null;
    if (!u) { failed(ip); res.writeHead(302, { Location: '../login.html#qr-ongeldig', 'Cache-Control': 'no-store' }); return res.end(); }
    fails.delete(ip);
    const tok = rid(24);
    sessions[tok] = { uid: u.id, t: Date.now(), via: 'qr' }; saveSessions();
    u.laatstIngelogd = Date.now(); saveUsers();
    res.writeHead(302, { Location: '../', 'Set-Cookie': sessCookie(req, tok, SESSION_DAYS * 86400), 'Cache-Control': 'no-store' });
    return res.end();
  }

  const sess = sessionOf(req);
  if (!sess) {
    if (p.startsWith('/api/')) return json(res, 401, { error: 'Niet ingelogd' });
    if (!OPEN_FILES.has(p)) { const up = '../'.repeat(Math.max(0, p.split('/').length - 2)); res.writeHead(302, { Location: (up || './') + 'login.html', 'Cache-Control': 'no-store' }); return res.end(); }
  }
  const me = sess && sess.user;

  // API
  if (p === '/api/me' && req.method === 'GET') return json(res, 200, Object.assign(publicUser(me), { zwakWachtwoord: weakPw(me.wachtwoord) }));
  if (p === '/api/state' && req.method === 'GET') return json(res, 200, { docs: stateFor(me) });
  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    send(res, 'state', { docs: stateFor(me) });
    const c = { res, uid: me.id, token: sess.token };
    clients.add(c);
    req.on('close', () => clients.delete(c));
    return;
  }
  if (p === '/api/write' && req.method === 'POST') {
    const body = await bodyJSON(req, res); if (!body) return;
    const ops = Array.isArray(body.ops) ? body.ops : [body];
    for (const o of ops) {
      if (!o || !['set', 'update', 'delete'].includes(o.op) || !validDocPath(o.path)) return json(res, 400, { error: 'Ongeldige bewerking of pad' });
      if (o.op !== 'delete' && (!o.data || typeof o.data !== 'object' || Array.isArray(o.data))) return json(res, 400, { error: 'Document moet een object zijn' });
      if (o.op === 'update' && docs[o.path] === undefined) return json(res, 400, { error: 'Document bestaat niet' });
      const bad = o.op !== 'delete' && badData(where(o.path).kind, o.data);
      if (bad) return json(res, 400, { error: bad });
      const why = refuse(me, o);
      if (why) return json(res, 403, { error: why });
    }
    let usersChanged = false;
    for (const o of ops) {
      const w = where(o.path), prev = docs[o.path];
      if (w.kind === 'log' && o.op === 'set') o.data = Object.assign({}, o.data, { gebruiker: me.naam, gebruikerId: me.id });
      if (w.kind === 'ritten' && o.op !== 'delete') o.data = Object.assign({}, o.data, { laatstDoor: { id: me.id, naam: me.naam, t: Date.now() } });
      if (w.kind === 'event' && prev === undefined && me.rol !== 'admin' && !(me.evenementen || []).includes(w.E)) { me.evenementen = [...(me.evenementen || []), w.E]; usersChanged = true; }
      if (o.op === 'set') docs[o.path] = o.data;
      else if (o.op === 'update') docs[o.path] = deepMerge(docs[o.path], o.data);
      else delete docs[o.path];
      if (w.kind === 'event' && o.op === 'delete') {
        for (const k of Object.keys(docs)) if (k.startsWith('ev/' + w.E + '/')) delete docs[k];
        for (const u of users) { u.evenementen = (u.evenementen || []).filter(e => e !== w.E); if (u.voertuig) delete u.voertuig[w.E]; }
        usersChanged = true;
        broadcastState();
      } else broadcastChange(o.path, o.op === 'delete' ? null : docs[o.path], prev);
      if (w.kind === 'ritten' && o.op !== 'delete') { try { notifyFase(o.path, prev, docs[o.path], me); } catch (e) { console.error('Pushmelding mislukt:', e.message); } }
    }
    if (usersChanged) saveUsers();
    dirty = true; save();
    return json(res, 200, { ok: true });
  }
  // pushmeldingen
  if (p === '/api/push/key' && req.method === 'GET') return json(res, 200, { key: push.vapid.publicKey });
  if (p === '/api/push/subscribe' && req.method === 'POST') {
    const b = await bodyJSON(req, res); if (!b) return;
    const sub = b.sub || {};
    let host = ''; try { const u = new URL(sub.endpoint); if (u.protocol === 'https:') host = u.hostname; } catch (_) {}
    if (!host || !PUSH_HOSTS.some(rx => rx.test(host))) return json(res, 400, { error: 'Onbekende pushdienst' });
    if (!sub.keys || unb64u(sub.keys.p256dh || '').length !== 65 || unb64u(sub.keys.auth || '').length < 16) return json(res, 400, { error: 'Ongeldig abonnement' });
    push.subs = push.subs.filter(s => s.endpoint !== sub.endpoint);
    const mine = push.subs.filter(s => s.uid === me.id);
    if (mine.length >= 10) push.subs = push.subs.filter(s => s !== mine[0]);
    push.subs.push({ uid: me.id, endpoint: String(sub.endpoint), keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, naam: String(b.naam || '').slice(0, 80), t: Date.now() });
    if (!push.contact) { const host = req.headers['x-forwarded-host'] || req.headers.host; if (host && isHttps(req)) push.contact = 'https://' + String(host).split(',')[0].trim(); }
    savePush();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/push/unsubscribe' && req.method === 'POST') {
    const b = await bodyJSON(req, res); if (!b) return;
    push.subs = push.subs.filter(s => !(s.uid === me.id && s.endpoint === b.endpoint)); savePush();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/push/test' && req.method === 'POST') {
    const b = await bodyJSON(req, res); if (!b) return;
    const subs = push.subs.filter(s => s.uid === me.id && (!b.endpoint || s.endpoint === b.endpoint));
    if (!subs.length) return json(res, 400, { error: 'Dit apparaat is niet aangemeld voor meldingen.' });
    const codes = await Promise.all(subs.map(s => sendPush(s, { title: 'Testmelding Voertuigenbord', body: 'Meldingen werken op dit apparaat.', tag: 'test', url: './', t: Date.now() })));
    const ok = codes.filter(c => c >= 200 && c < 300).length;
    return json(res, ok ? 200 : 502, ok ? { ok: true, verstuurd: ok } : { error: 'De pushdienst nam de melding niet aan (' + codes.join(', ') + ').' });
  }

  if (p === '/api/reset' && req.method === 'POST') {
    if (me.rol !== 'admin') return json(res, 403, { error: 'Alleen een admin kan resetten.' });
    const b = await bodyJSON(req, res); if (!b) return;
    if (!docs['events/' + b.event] || !['ritten', 'alles'].includes(b.mode)) return json(res, 400, { error: 'Onbekend evenement of soort reset' });
    backup();
    const n = resetEvent(b.event, b.mode, me);
    broadcastState(); dirty = true; save();
    return json(res, 200, { ok: true, verwijderd: n });
  }

  // bijlagen (pdf, bijvoorbeeld een bestellijst)
  if (p === '/api/files' && req.method === 'POST') {
    if (me.rol === 'waarnemer') return json(res, 403, { error: 'Als waarnemer kun je geen bestanden toevoegen.' });
    if (!/application\/pdf/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Alleen pdf-bestanden' });
    let buf;
    try { buf = await readRaw(req, MAX_FILE); } catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'Het bestand is groter dan 20 MB.' : 'Uploaden mislukt' }); }
    if (buf.length < 5 || buf.slice(0, 5).toString('latin1') !== '%PDF-') return json(res, 400, { error: 'Dit is geen geldig pdf-bestand.' });
    let used = 0;
    try { for (const f of fs.readdirSync(FILE_DIR)) used += fs.statSync(path.join(FILE_DIR, f)).size; } catch (_) {}
    if (used + buf.length > 2 * 1024 * 1024 * 1024) return json(res, 507, { error: 'De opslag voor bijlagen is vol (2 GB). Ruim oude bestellijsten op.' });
    const id = rid(12);
    try { fs.writeFileSync(path.join(FILE_DIR, id + '.pdf'), buf); } catch (e) { return json(res, 500, { error: 'Opslaan mislukt' }); }
    return json(res, 200, { ok: true, id, grootte: buf.length });
  }
  const fm = p.match(/^\/api\/files\/([a-f0-9]{24})$/);
  if (fm && req.method === 'GET') {
    const file = path.join(FILE_DIR, fm[1] + '.pdf');
    if (!fs.existsSync(file)) return json(res, 404, { error: 'Bestand niet gevonden' });
    const naam = String(url.searchParams.get('naam') || 'bestellijst.pdf').replace(/[^\w .()\-]/g, '_').slice(0, 120);
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${naam}"`, 'Cache-Control': 'private, max-age=86400', 'Content-Security-Policy': 'sandbox' });
    return fs.createReadStream(file).pipe(res);
  }

  // gebruikersbeheer (alleen admin)
  if (p === '/api/users' || p.startsWith('/api/users/')) {
    if (me.rol !== 'admin') return json(res, 403, { error: 'Alleen een admin kan gebruikers beheren.' });
    if (p === '/api/users' && req.method === 'GET') return json(res, 200, { users });
    if (p === '/api/users' && req.method === 'POST') {
      const b = await bodyJSON(req, res); if (!b) return;
      const existing = b.id ? userById(b.id) : null;
      if (b.id && !existing) return json(res, 404, { error: 'Gebruiker niet gevonden' });
      const r = cleanUser(b, existing || { id: 'u' + rid(5), aangemaakt: Date.now() });
      if (r.error) return json(res, 400, { error: r.error });
      const u = r.user;
      if (existing && existing.rol === 'admin' && (u.rol !== 'admin' || !u.actief) && lastAdmin(u.id)) return json(res, 400, { error: 'Er moet minstens één actieve admin blijven.' });
      const pwChanged = existing && existing.wachtwoord !== u.wachtwoord;
      if (existing) Object.assign(existing, u); else users.push(u);
      saveUsers(); dirty = true;
      if (existing) {
        if (!u.actief || pwChanged) endSessions(u.id, u.id === me.id ? sess.token : null);
        tellUser(u.id, 'reload');
      }
      return json(res, 200, { ok: true, user: u });
    }
    const qr = p.match(/^\/api\/users\/([A-Za-z0-9]+)\/qr$/);
    if (qr && (req.method === 'POST' || req.method === 'DELETE')) {
      const u = userById(qr[1]); if (!u) return json(res, 404, { error: 'Gebruiker niet gevonden' });
      u.qrToken = req.method === 'POST' ? rid(16) : '';
      saveUsers(); dirty = true;
      return json(res, 200, { ok: true, token: u.qrToken });
    }
    const m = p.match(/^\/api\/users\/([A-Za-z0-9]+)$/);
    if (m && req.method === 'DELETE') {
      const u = userById(m[1]); if (!u) return json(res, 404, { error: 'Gebruiker niet gevonden' });
      if (u.id === me.id) return json(res, 400, { error: 'Je kunt jezelf niet verwijderen.' });
      if (u.rol === 'admin' && lastAdmin(u.id)) return json(res, 400, { error: 'Er moet minstens één actieve admin blijven.' });
      users = users.filter(x => x.id !== u.id); saveUsers(); endSessions(u.id); dirty = true;
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Onbekend' });
  }
  if (p.startsWith('/api/')) return json(res, 404, { error: 'Onbekend' });

  // statische bestanden
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Niet gevonden'); }
    const html = /\.(html|js|webmanifest)$/.test(p);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': html ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Voertuigenbord draait op http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`${users.length} gebruiker(s), ${Object.keys(docs).filter(k => k.startsWith('events/')).length} evenement(en).`);
  backup();
});
function shutdown() {
  clearTimeout(saveTimer);
  try { writeJSON(DATA_FILE, { docs, savedAt: new Date().toISOString() }); } catch (_) {}
  try { writeJSON(SESS_FILE, sessions); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
