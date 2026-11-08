/* Sincronización con la cuenta de Google del supervisor (Firebase).
   Cada grupo se guarda en usuarios/{uid}/grupos/{grupo}. Si no hay internet o no hay
   configuración, la app sigue funcionando igual, solo en este dispositivo. */
const CFG = null; // datos del proyecto de Firebase (firebaseConfig)
const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
const LS = 'rotgrupos:';
const MK = LS + 'cloudmeta';

const lsGet = k => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null } catch (e) { return null } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch (e) { } };
const getMeta = () => { const m = lsGet(MK) || {}; m.base = m.base || {}; m.dirty = m.dirty || {}; return m };
const setMeta = m => lsSet(MK, m);
let dev = lsGet(LS + 'dev'); if (!dev) { dev = Math.random().toString(36).slice(2, 10); lsSet(LS + 'dev', dev) }

const localGroups = () => { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf(LS + 'g:') === 0) out.push(k.slice((LS + 'g:').length)) } } catch (e) { } return out };
const docId = g => 'g_' + encodeURIComponent(String(g)).replace(/\./g, '%2E');

const C = { on: !!CFG, ready: false, user: null, pending: 0, last: 0, err: '' };
window.cloud = C;
const ui = () => { try { window.cloudUI && window.cloudUI() } catch (e) { } };

let A, F, auth, db, unsub = null, timers = {};

C.changed = g => {
  g = String(g);
  if (!C.on) return;
  const m = getMeta(); m.dirty[g] = 1; setMeta(m);
  if (!C.user) return;
  clearTimeout(timers[g]); timers[g] = setTimeout(() => push(g), 1500);
};
C.removed = g => {
  g = String(g);
  if (!C.on) return;
  const m = getMeta(); delete m.base[g]; delete m.dirty[g]; setMeta(m);
  if (C.user) F.deleteDoc(F.doc(db, 'usuarios', C.user.uid, 'grupos', docId(g))).catch(() => { });
};
C.signIn = async () => {
  if (!auth) return; C.err = ''; const p = new A.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
  try { await A.signInWithPopup(auth, p) }
  catch (e) {
    const c = e && e.code || '';
    if (/popup-blocked|operation-not-supported|web-storage-unsupported/.test(c)) { try { await A.signInWithRedirect(auth, p); return } catch (e2) { C.err = msg(e2); ui(); return } }
    if (/popup-closed|cancelled-popup/.test(c)) return;
    C.err = msg(e); ui();
  }
};
C.signOut = async () => { if (!auth) return; if (unsub) { unsub(); unsub = null } const m = getMeta(); m.base = {}; m.uid = null; setMeta(m); await A.signOut(auth).catch(() => { }); };

function msg(e) {
  const c = e && e.code || '';
  if (/network/.test(c)) return 'No hay internet. Inténtalo cuando tengas conexión.';
  if (/unauthorized-domain/.test(c)) return 'Falta autorizar este sitio en Firebase (Dominios autorizados).';
  if (/operation-not-allowed/.test(c)) return 'Falta activar «Google» en Firebase (Authentication).';
  return 'No se pudo entrar (' + (c || 'error') + '). Inténtalo otra vez.';
}

async function push(g) {
  if (!C.user) return;
  const o = lsGet(LS + 'g:' + g); if (!o) return;
  const rev = Date.now() + '-' + dev;
  const m = getMeta(); m.base[g] = rev; setMeta(m);
  C.pending++; ui();
  try {
    await F.setDoc(F.doc(db, 'usuarios', C.user.uid, 'grupos', docId(g)), { g: String(g), data: JSON.stringify(o), edit: o.edit || 0, rev, dev, at: F.serverTimestamp() });
    const m2 = getMeta(); if (m2.base[g] === rev) delete m2.dirty[g]; setMeta(m2);
    C.last = Date.now(); C.err = '';
  } catch (e) { C.err = 'No se pudo guardar en la nube. Se reintentará al cambiar algo.'; }
  C.pending--; ui();
}

function listen(uid) {
  let first = true;
  unsub = F.onSnapshot(F.collection(db, 'usuarios', uid, 'grupos'), snap => {
    const m = getMeta(); const remote = new Set();
    snap.forEach(d => remote.add(d.data().g));
    snap.docChanges().forEach(ch => {
      const d = ch.doc.data(); const g = d.g;
      if (ch.type === 'removed') { if (m.base[g] !== undefined) { delete m.base[g]; delete m.dirty[g]; setMeta(m); window.cloudRemove && window.cloudRemove(g) } return }
      if (d.rev === m.base[g]) return; // ya lo tenemos (o es nuestro propio cambio)
      const local = lsGet(LS + 'g:' + g);
      const mine = local && (m.dirty[g] || m.base[g] === undefined);
      if (mine && (local.edit || 0) > (d.edit || 0)) { setTimeout(() => push(g), 0); return } // lo de aquí es más nuevo
      let o; try { o = JSON.parse(d.data) } catch (e) { return }
      m.base[g] = d.rev; delete m.dirty[g]; setMeta(m);
      window.cloudApply && window.cloudApply(g, o);
    });
    if (first) {
      first = false;
      localGroups().forEach(g => { if (!remote.has(g) || getMeta().dirty[g]) push(g) });
    }
    C.last = C.last || Date.now(); ui();
  }, e => { C.err = 'Sin conexión con la nube. Tus cambios se guardan aquí y se suben al volver.'; ui() });
}

async function init() {
  try {
    const [App, Au, Fs] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')]);
    A = Au; F = Fs;
    const app = App.initializeApp(CFG);
    auth = A.getAuth(app);
    try { db = F.initializeFirestore(app, { localCache: F.persistentLocalCache() }) } catch (e) { db = F.getFirestore(app) }
    A.getRedirectResult(auth).catch(e => { C.err = msg(e); ui() });
    A.onAuthStateChanged(auth, u => {
      if (unsub) { unsub(); unsub = null }
      C.user = u ? { uid: u.uid, email: u.email || '' } : null; C.ready = true;
      if (u) { const m = getMeta(); if (m.uid !== u.uid) { m.uid = u.uid; m.base = {}; setMeta(m) } listen(u.uid) }
      ui();
    });
  } catch (e) { C.ready = true; C.err = 'No se pudo conectar con la nube (¿sin internet?). La app funciona igual en este dispositivo.'; ui() }
}
if (CFG) init();
