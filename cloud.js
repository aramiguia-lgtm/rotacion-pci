/* Nube (Firebase) con equipo y roles.
   Modo «compartido»: los grupos viven en grupos/{id} y el administrador decide quién entra
   (miembros/{correo}: rol admin, supervisor o utility, y qué grupos tiene).
   Modo «personal» (antes de activar el administrador): cada cuenta guarda sus grupos en
   usuarios/{uid}/grupos, como antes. Sin internet la app sigue funcionando en el aparato. */
const CFG = {
  apiKey: "AIzaSyCOtf9CkkYSZgCQFqvHl5z8EhTeb_13sjE",
  authDomain: "rotacion-pci.firebaseapp.com",
  projectId: "rotacion-pci",
  storageBucket: "rotacion-pci.firebasestorage.app",
  messagingSenderId: "795506166176",
  appId: "1:795506166176:web:9abe7d4c74e324b473fcc5"
};
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
const normG = g => String(g == null ? '' : g).trim().replace(/^grupo\s*/i, '');
const normEmail = e => String(e || '').trim().toLowerCase();

/* Estado que lee la pantalla:
   mode: 'personal' | 'compartido' | 'sinacceso' | null (todavía revisando)
   role: 'admin' | 'supervisor' | 'utility' | null
   groups: grupos asignados (en compartido, no admin)
   canClaim: nadie ha activado el administrador todavía (sale el botón para hacerlo) */
const C = { on: true, ready: false, user: null, pending: 0, last: 0, err: '', mode: null, role: null, name: '', groups: [], canClaim: false, members: [], allGroups: [] };
window.cloud = C;
const ui = () => { try { window.cloudUI && window.cloudUI() } catch (e) { } };

let A, F, auth, db, timers = {};
let subs = [];            // escuchas activas de grupos
let subMe = null, subTeam = null, subAll = null, subPlant = null, subAv = null, subEq = null, subPx = null;
const stopGroups = () => { subs.forEach(u => { try { u() } catch (e) { } }); subs = [] };
const stopAll = () => { stopGroups(); [subAv, subEq].forEach(u => { try { u && u() } catch (e) { } }); subAv = subEq = null; C.avisos = []; if (subPlant) { try { subPlant() } catch (e) { } subPlant = null; C.plantReady = false } if (subPx) { try { subPx() } catch (e) { } subPx = null; C.pxReady = false } if (chkSub) { try { chkSub() } catch (e) { } chkSub = null; chkKey = '' }[subMe, subTeam, subAll].forEach(u => { try { u && u() } catch (e) { } }); subMe = subTeam = subAll = null };

const shared = () => C.mode === 'compartido';
const gref = g => shared() ? F.doc(db, 'grupos', docId(g)) : F.doc(db, 'usuarios', C.user.uid, 'grupos', docId(g));
const hasGroup = g => C.role === 'admin' || C.groups.indexOf(normG(g)) >= 0;
C.canWrite = g => {
  if (!C.user) return false;
  if (C.mode === 'personal') return true;
  if (!shared()) return false;
  return C.role === 'admin' || (C.role === 'supervisor' && hasGroup(g));
};
C.readOnly = () => shared() && C.role === 'utility';
C.isAdmin = () => shared() && C.role === 'admin';
C.syncs = g => !!C.user && (C.mode === 'personal' || (shared() && hasGroup(g)));

C.changed = g => {
  g = String(g);
  const m = getMeta(); m.dirty[g] = 1; setMeta(m);
  if (!C.canWrite(g)) return;
  clearTimeout(timers[g]); timers[g] = setTimeout(() => push(g), 1500);
};
C.removed = g => {
  g = String(g);
  const m = getMeta(); delete m.base[g]; delete m.dirty[g]; setMeta(m);
  if (!C.user) return;
  if (C.mode === 'personal' || C.isAdmin()) F.deleteDoc(gref(g)).catch(() => { });
};
C.canDeleteCloud = () => C.mode === 'personal' || C.isAdmin();

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
C.signOut = async () => { if (!auth) return; stopAll(); const m = getMeta(); m.base = {}; m.uid = null; m.mode = null; setMeta(m); await A.signOut(auth).catch(() => { }); };

function msg(e) {
  const c = e && e.code || '';
  if (/network|unavailable/.test(c)) return 'No hay conexión con la nube. Revisa el internet o si la red del trabajo la bloquea.';
  if (/unauthorized-domain/.test(c)) return 'Falta autorizar este sitio en Firebase (Dominios autorizados).';
  if (/operation-not-allowed/.test(c)) return 'Falta activar «Google» en Firebase (Authentication).';
  if (/permission-denied/.test(c)) return 'La nube no dio permiso. Si acabas de activar el administrador, revisa que pegaste las reglas nuevas en Firebase.';
  return 'Algo falló con la nube (' + (c || 'error') + '). Inténtalo otra vez.';
}

async function push(g) {
  if (!C.canWrite(g)) return;
  const o = lsGet(LS + 'g:' + g); if (!o) return;
  const rev = Date.now() + '-' + dev;
  const m = getMeta(); m.base[g] = rev; setMeta(m);
  C.pending++; ui();
  try {
    await F.setDoc(gref(g), { g: String(g), data: JSON.stringify(o), edit: o.edit || 0, rev, dev, por: C.user.email || '', at: F.serverTimestamp() });
    const m2 = getMeta(); if (m2.base[g] === rev) delete m2.dirty[g]; setMeta(m2);
    C.last = Date.now(); C.err = '';
  } catch (e) { C.err = 'No se pudo guardar en la nube (' + (e && e.code || 'error') + '). Se reintentará al cambiar algo.'; }
  C.pending--; ui();
}

/* Llegó un grupo de la nube: se aplica, salvo que lo de aquí sea un cambio más nuevo sin subir. */
function incoming(d) {
  const m = getMeta(); const g = String(d.g);
  if (d.rev === m.base[g]) return;
  const local = lsGet(LS + 'g:' + g);
  const mine = local && m.base[g] !== undefined && m.dirty[g] && C.canWrite(g);
  if (mine && (local.edit || 0) > (d.edit || 0)) { setTimeout(() => push(g), 0); return }
  let o; try { o = JSON.parse(d.data) } catch (e) { return }
  m.base[g] = d.rev; delete m.dirty[g]; setMeta(m);
  window.cloudApply && window.cloudApply(g, o);
}
function gone(g) {
  g = String(g); const m = getMeta();
  if (m.base[g] !== undefined) { delete m.base[g]; delete m.dirty[g]; setMeta(m); window.cloudRemove && window.cloudRemove(g) }
}
const onErr = e => { C.err = msg(e); ui() };

/* Escucha toda una colección (personal, o el administrador en compartido). */
function listenCol(ref) {
  let first = true;
  const u = F.onSnapshot(ref, snap => {
    const remote = new Set();
    snap.forEach(d => remote.add(String(d.data().g)));
    snap.docChanges().forEach(ch => { const d = ch.doc.data(); if (ch.type === 'removed') gone(d.g); else incoming(d) });
    if (first) {
      first = false;
      localGroups().forEach(g => { if ((!remote.has(g) || getMeta().dirty[g]) && C.canWrite(g)) push(g) });
    }
    C.allGroups = Array.from(remote).sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
    C.last = C.last || Date.now(); C.err = ''; ui();
  }, onErr);
  subs.push(u);
}
/* Escucha solo los grupos asignados (supervisor o utility). */
function listenMine() {
  stopGroups();
  C.groups.forEach(g => {
    let first = true;
    const u = F.onSnapshot(F.doc(db, 'grupos', docId(g)), d => {
      if (d.exists()) incoming(d.data());
      else if (first && lsGet(LS + 'g:' + g) && C.canWrite(g)) push(g);
      first = false; C.last = C.last || Date.now(); C.err = ''; ui();
    }, onErr);
    subs.push(u);
  });
}

function setMode(mode) {
  const m = getMeta();
  if (m.mode !== mode) { m.base = {}; m.mode = mode; setMeta(m) }
  C.mode = mode;
}

/* Quitaron a esta persona o le quitaron un grupo: se borra de este aparato lo que venía de la nube. */
function dropLocal(keep) {
  const m = getMeta();
  Object.keys(m.base).forEach(g => { if (!keep || keep.indexOf(g) < 0) gone(g) });
}

async function decide(u) {
  const email = normEmail(u.email);
  let cfg;
  try { cfg = await F.getDoc(F.doc(db, 'config', 'inicio')) }
  catch (e) {
    // Reglas viejas (sin equipo): se sigue como antes, cada uno con su cuenta.
    setMode('personal'); C.role = null; C.canClaim = false;
    listenCol(F.collection(db, 'usuarios', u.uid, 'grupos')); ui(); return;
  }
  if (!cfg.exists()) {
    setMode('personal'); C.role = null; C.canClaim = true;
    listenCol(F.collection(db, 'usuarios', u.uid, 'grupos')); ui(); return;
  }
  C.canClaim = false;
  subMe = F.onSnapshot(F.doc(db, 'miembros', email), d => {
    stopGroups(); if (subTeam) { subTeam(); subTeam = null }
    if (!d.exists()) {
      const was = C.mode === 'compartido' || getMeta().mode === 'compartido';
      C.role = null; C.groups = []; C.name = '';
      if (subPlant) { try { subPlant() } catch (e) { } subPlant = null; C.plantReady = false }
      if (subPx) { try { subPx() } catch (e) { } subPx = null; C.pxReady = false }
      if (was) dropLocal(null);
      setMode('sinacceso'); ui(); return;
    }
    const x = d.data();
    setMode('compartido');
    C.role = x.rol; C.name = x.nombre || '';
    listenPlant(); listenPx(); listenAvisos();
    C.groups = (x.grupos || []).map(normG).filter(Boolean);
    if (C.role === 'admin') {
      listenCol(F.collection(db, 'grupos'));
      subTeam = F.onSnapshot(F.collection(db, 'miembros'), s => {
        C.members = []; s.forEach(m => C.members.push(Object.assign({ email: m.id }, m.data())));
        const sups = C.members.filter(m => m.rol === 'admin' || m.rol === 'supervisor').map(m => ({ email: m.email, nombre: m.nombre || m.email })).sort((a, b) => a.email.localeCompare(b.email));
        if (JSON.stringify(sups) !== JSON.stringify(C.sups)) F.setDoc(F.doc(db, 'config', 'equipo'), { sups }).catch(() => { });
        C.members.sort((a, b) => (a.rol === 'admin' ? -1 : 0) - (b.rol === 'admin' ? -1 : 0) || String(a.nombre || a.email).localeCompare(String(b.nombre || b.email), 'es'));
        ui();
      }, onErr);
    } else {
      dropLocal(C.groups);
      listenMine();
    }
    ui();
  }, onErr);
}

/* ---------- Administrador ---------- */
const memberDoc = (email, rol, nombre, grupos) => {
  const gs = Array.from(new Set((grupos || []).map(normG).filter(Boolean)));
  return { rol, nombre: String(nombre || '').trim(), grupos: gs, docs: gs.map(docId), por: C.user.email || '', at: F.serverTimestamp() };
};

/* Activa el modo con equipo: tú quedas de administrador y tus grupos pasan a la nube compartida. */
C.claimAdmin = async nombre => {
  if (!C.user) return 'Primero entra con Google.';
  const email = normEmail(C.user.email);
  try {
    const b = F.writeBatch(db);
    b.set(F.doc(db, 'miembros', email), memberDoc(email, 'admin', nombre, []));
    b.set(F.doc(db, 'config', 'inicio'), { admin: email, at: F.serverTimestamp() });
    await b.commit();
  } catch (e) { return msg(e) }
  // Copia los grupos que tenías en tu cuenta personal a la nube compartida.
  try {
    const old = await F.getDocs(F.collection(db, 'usuarios', C.user.uid, 'grupos'));
    const jobs = []; old.forEach(d => { const x = d.data(); if (x && x.g != null) jobs.push(F.setDoc(F.doc(db, 'grupos', docId(x.g)), x)) });
    await Promise.all(jobs);
  } catch (e) { }
  stopAll(); setMode('compartido'); await decide(auth.currentUser);
  return 'ok';
};
C.saveMember = async (email, rol, nombre, grupos) => {
  email = normEmail(email);
  if (!C.isAdmin()) return 'Solo el administrador puede hacer esto.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'Escribe un correo válido.';
  if (['admin', 'supervisor', 'utility'].indexOf(rol) < 0) return 'Elige un rol.';
  if (email === normEmail(C.user.email) && rol !== 'admin') return 'No puedes quitarte a ti mismo de administrador.';
  try { await F.setDoc(F.doc(db, 'miembros', email), memberDoc(email, rol, nombre, grupos)); return 'ok' } catch (e) { return msg(e) }
};
C.delMember = async email => {
  email = normEmail(email);
  if (!C.isAdmin()) return 'Solo el administrador puede hacer esto.';
  if (email === normEmail(C.user.email)) return 'No puedes quitarte a ti mismo.';
  try { await F.deleteDoc(F.doc(db, 'miembros', email)); return 'ok' } catch (e) { return msg(e) }
};
/* Cambiaron el número de un grupo: se actualiza a quién está asignado. */
C.renamed = async (og, g) => {
  if (!C.isAdmin()) return;
  og = normG(og); g = normG(g);
  C.members.forEach(m => {
    const gs = (m.grupos || []).map(normG);
    if (gs.indexOf(og) >= 0) F.setDoc(F.doc(db, 'miembros', m.email), memberDoc(m.email, m.rol, m.nombre, gs.map(x => x === og ? g : x))).catch(() => { });
  });
};

/* ---------- Planta compartida: máquinas y puestos iguales para los 4 grupos ---------- */
C.plant = lsGet(LS + 'planta'); C.plantReady = false; C.plantErr = ''; C.plantRev = '';
C.canEditPlant = () => shared() && (C.role === 'admin' || C.role === 'supervisor');
function listenPlant() {
  if (subPlant) return;
  subPlant = F.onSnapshot(F.doc(db, 'planta', 'main'), d => {
    C.plantErr = '';
    if (!d.exists()) { C.plant = null; C.plantReady = true; window.plantSeed && window.plantSeed(); ui(); return }
    const x = d.data(); C.plant = x; C.plantReady = true; lsSet(LS + 'planta', x);
    window.plantApply && window.plantApply(x); ui();
  }, e => { C.plantErr = /permission/.test(e && e.code || '') ? 'Falta activar la planta compartida en Firebase (reglas).' : msg(e); C.plantReady = false; ui() });
}
C.pushPlant = async data => {
  if (!C.canEditPlant() || !C.plantReady) return 'no';
  const rev = Date.now() + '-' + dev; C.plantRev = rev;
  const x = Object.assign({}, data, { rev, por: C.user.email || '', nombre: C.name || '', ms: Date.now(), at: F.serverTimestamp() });
  try { await F.setDoc(F.doc(db, 'planta', 'main'), x); C.plant = Object.assign({}, x, { at: null }); lsSet(LS + 'planta', C.plant); ui(); return 'ok' }
  catch (e) { C.plantErr = msg(e); ui(); return C.plantErr }
};

/* ---------- Calibración Plastrac: una tabla para los 4 grupos ---------- */
C.px = lsGet(LS + 'plastrac'); C.pxReady = false; C.pxErr = '';
function listenPx() {
  if (subPx) return;
  subPx = F.onSnapshot(F.doc(db, 'planta', 'plastrac'), d => {
    C.pxErr = ''; C.pxReady = true;
    if (!d.exists()) { window.pxSeed && window.pxSeed(); ui(); return }
    C.px = d.data(); lsSet(LS + 'plastrac', C.px); window.pxApply && window.pxApply(C.px); ui();
  }, e => { C.pxErr = msg(e); C.pxReady = false; ui() });
}
C.pushPx = async rows => {
  if (!C.canEditPlant() || !C.pxReady) return 'no';
  const x = { rows, por: C.user.email || '', nombre: C.name || '', ms: Date.now() };
  try { await F.setDoc(F.doc(db, 'planta', 'plastrac'), x); C.px = x; lsSet(LS + 'plastrac', x); ui(); return 'ok' }
  catch (e) { C.pxErr = msg(e); ui(); return C.pxErr }
};

/* ---------- Avisos a supervisores: quedan hasta que todos los marquen como vistos ---------- */
C.avisos = []; C.sups = [];
C.isSup = () => shared() && (C.role === 'admin' || C.role === 'supervisor');
const ekey = e => normEmail(e).replace(/[.]/g, ',');
function listenAvisos() {
  if (subAv || !C.isSup()) return;
  subEq = F.onSnapshot(F.doc(db, 'config', 'equipo'), d => { C.sups = d.exists() ? (d.data().sups || []) : []; ui() }, () => { });
  subAv = F.onSnapshot(F.collection(db, 'avisos'), s => {
    const A = []; s.forEach(d => A.push(Object.assign({ id: d.id }, d.data())));
    C.avisos = A.sort((a, b) => (b.ms || 0) - (a.ms || 0)); window.avisosIn && window.avisosIn(); ui();
  }, e => { C.avErr = /permission/.test(e && e.code || '') ? 'Falta activar los avisos en Firebase (reglas).' : ''; ui() });
}
C.myKey = () => C.user ? ekey(C.user.email) : '';
C.avPending = a => (a.para || []).filter(p => !(a.vistos || {})[ekey(p.email)]);
C.sendAviso = async txt => {
  if (!C.isSup()) return 'Solo supervisores y administrador.';
  const me = normEmail(C.user.email);
  let para = (C.sups || []).slice(); if (!para.some(p => p.email === me)) para.push({ email: me, nombre: C.name || me });
  const id = Date.now() + '-' + dev;
  try { await F.setDoc(F.doc(db, 'avisos', id), { txt, por: me, nombre: C.name || me, ms: Date.now(), para, vistos: { [ekey(me)]: { n: C.name || me, t: Date.now() } } }); return 'ok' } catch (e) { return msg(e) }
};
C.seeAviso = async id => {
  const a = (C.avisos || []).find(x => x.id === id); if (!a) return;
  const k = C.myKey(); a.vistos = a.vistos || {}; a.vistos[k] = { n: C.name || C.user.email, t: Date.now() };
  try {
    if (!C.avPending(a).length) await F.deleteDoc(F.doc(db, 'avisos', id));
    else await F.setDoc(F.doc(db, 'avisos', id), { vistos: { [k]: a.vistos[k] } }, { merge: true });
  } catch (e) { C.err = msg(e) }
  ui();
};
C.delAviso = async id => { try { await F.deleteDoc(F.doc(db, 'avisos', id)) } catch (e) { C.err = msg(e) } ui() };

/* ---------- Plan de trabajo: los checks viven aparte para que los de solo ver puedan marcarlos ---------- */
let chkSub = null, chkKey = '';
C.checks = {}; C.checksOn = false;
C.watchChecks = (g, dia) => {
  g = String(g);
  const ok = shared() && hasGroup(g);
  const key = ok ? g + '|' + dia : '';
  if (key === chkKey) return ok;
  if (chkSub) { try { chkSub() } catch (e) { } chkSub = null }
  chkKey = key; C.checks = {}; C.checksOn = ok;
  if (!ok) return false;
  chkSub = F.onSnapshot(F.doc(db, 'checks', docId(g), 'dias', dia), d => { C.checks = d.exists() ? (d.data().c || {}) : {}; ui() }, onErr);
  return true;
};
C.setCheck = async (g, dia, k, val) => {
  if (!(shared() && hasGroup(g))) return 'Sin acceso a este grupo.';
  if (val) C.checks[k] = val; else delete C.checks[k];
  try { await F.setDoc(F.doc(db, 'checks', docId(g), 'dias', dia), { c: { [k]: val ? val : F.deleteField() } }, { merge: true }); return 'ok' }
  catch (e) { return msg(e) }
};

/* ---------- Botones manuales ---------- */
C.pull = async g => {
  g = String(g);
  if (!C.syncs(g)) return C.user ? 'Este grupo no está en tu cuenta.' : 'Primero entra con Google.';
  try {
    const d = await F.getDocFromServer(gref(g));
    if (!d.exists()) return 'En la nube todavía no hay datos de este grupo. Súbelos desde el aparato que tiene los datos buenos.';
    const x = d.data(); let o; try { o = JSON.parse(x.data) } catch (e) { return 'Los datos de la nube están dañados.' }
    const m = getMeta(); m.base[g] = x.rev; delete m.dirty[g]; setMeta(m);
    window.cloudApply && window.cloudApply(g, o, true);
    C.last = Date.now(); C.err = ''; ui();
    return 'ok';
  } catch (e) { return msg(e) }
};
C.pushNow = async g => {
  g = String(g);
  if (!C.canWrite(g)) return C.readOnly() ? 'Tu acceso es solo para ver.' : 'No tienes permiso para cambiar este grupo en la nube.';
  clearTimeout(timers[g]); C.err = '';
  await push(g);
  return C.err ? C.err : 'ok';
};
C.sync = async g => {
  g = String(g);
  if (!C.syncs(g)) return C.user ? 'Este grupo no está en tu cuenta.' : 'Primero entra con Google.';
  try {
    const d = await F.getDocFromServer(gref(g));
    const local = lsGet(LS + 'g:' + g);
    const r = d.exists() ? d.data() : null;
    const dirty = !!getMeta().dirty[g];
    if (C.canWrite(g) && (!r || (local && dirty && (local.edit || 0) > (r.edit || 0)))) { const x = await C.pushNow(g); return x === 'ok' ? 'up' : x }
    if (!r) return 'En la nube todavía no hay datos de este grupo.';
    return (await C.pull(g)) === 'ok' ? 'down' : 'No se pudo traer de la nube.';
  } catch (e) { return msg(e) }
};

async function init() {
  try {
    const [App, Au, Fs] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')]);
    A = Au; F = Fs;
    const app = App.initializeApp(CFG);
    auth = A.getAuth(app);
    // Las redes del trabajo con proxy cortan la conexión en vivo: se usa «long polling».
    try { db = F.initializeFirestore(app, { localCache: F.persistentLocalCache(), experimentalForceLongPolling: true }) } catch (e) { db = F.getFirestore(app) }
    A.getRedirectResult(auth).catch(e => { C.err = msg(e); ui() });
    A.onAuthStateChanged(auth, u => {
      stopAll();
      C.user = u ? { uid: u.uid, email: u.email || '' } : null; C.ready = true;
      C.mode = null; C.role = null; C.groups = []; C.members = []; C.canClaim = false;
      if (u) { const m = getMeta(); if (m.uid !== u.uid) { m.uid = u.uid; m.base = {}; m.mode = null; setMeta(m) } decide(u).catch(onErr) }
      ui();
    });
  } catch (e) { C.ready = true; C.err = 'No se pudo conectar con la nube (¿sin internet?). La app funciona igual en este dispositivo.'; ui() }
}
init();
