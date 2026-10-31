// ============================================================================
//  FinanzApp Web — lógica principal
//  HTML + Firestore (sincronización en tiempo real + offline), estilo del
//  inventario del lab. Sin build: se sirve tal cual en GitHub Pages.
// ============================================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  addDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

import { firebaseConfig } from './config.js';

// ---------------------------------------------------------------------------
//  Inicialización de Firebase
// ---------------------------------------------------------------------------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Caché persistente en el dispositivo = funciona offline y sincroniza al volver.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

// ---------------------------------------------------------------------------
//  Estado en memoria (se llena desde los listeners en tiempo real de Firestore)
// ---------------------------------------------------------------------------
const state = {
  uid: null,
  email: null,
  profiles: [],
  categories: [],
  transactions: [],
  currentProfileId: null,
  unsub: [], // funciones para cancelar los listeners al cerrar sesión
};

const $ = (sel) => document.querySelector(sel);

// Efecto ripple de Material: delegado a elementos interactivos.
const RIPPLE_SEL = '.btn, .fab, .nav-item, .tx-item, .settings-row, .icon-btn, .segmented button';
document.addEventListener('pointerdown', (e) => {
  const host = e.target.closest(RIPPLE_SEL);
  if (!host) return;
  const rect = host.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const span = document.createElement('span');
  span.className = 'ripple';
  span.style.width = span.style.height = `${size}px`;
  span.style.left = `${e.clientX - rect.left - size / 2}px`;
  span.style.top = `${e.clientY - rect.top - size / 2}px`;
  if (getComputedStyle(host).position === 'static') host.classList.add('ripple-host');
  host.appendChild(span);
  span.addEventListener('animationend', () => span.remove());
});
const fmt = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});
const money = (n) => fmt.format(Math.round(n || 0));
const todayIso = () => new Date().toISOString().slice(0, 10);

// Categorías por defecto que se crean la primera vez que entras.
const DEFAULT_CATEGORIES = [
  { name: 'Salario', type: 'income', profileType: 'personal', color: '#16A34A' },
  { name: 'Otros ingresos', type: 'income', profileType: 'personal', color: '#22C55E' },
  { name: 'Alimentación', type: 'expense', profileType: 'personal', color: '#F59E0B' },
  { name: 'Transporte', type: 'expense', profileType: 'personal', color: '#3B82F6' },
  { name: 'Entretenimiento', type: 'expense', profileType: 'personal', color: '#A855F7' },
  { name: 'Salud', type: 'expense', profileType: 'personal', color: '#EF4444' },
  { name: 'Hogar', type: 'expense', profileType: 'personal', color: '#14B8A6' },
  { name: 'Otros', type: 'expense', profileType: 'personal', color: '#6B7280' },
  { name: 'Ventas', type: 'income', profileType: 'business', color: '#059669' },
  { name: 'Servicios', type: 'income', profileType: 'business', color: '#10B981' },
  { name: 'Mercancía', type: 'expense', profileType: 'business', color: '#F59E0B' },
  { name: 'Arriendo', type: 'expense', profileType: 'business', color: '#8B5CF6' },
  { name: 'Nómina', type: 'expense', profileType: 'business', color: '#3B82F6' },
  { name: 'Otros', type: 'expense', profileType: 'business', color: '#6B7280' },
];

// Rutas de colecciones bajo el usuario actual.
const col = (name) => collection(db, 'users', state.uid, name);

// ---------------------------------------------------------------------------
//  Autenticación
// ---------------------------------------------------------------------------
let authMode = 'signin'; // o 'signup'

function authErrorMessage(code) {
  const map = {
    'auth/invalid-email': 'El correo no es válido.',
    'auth/user-not-found': 'No existe una cuenta con ese correo.',
    'auth/wrong-password': 'Contraseña incorrecta.',
    'auth/invalid-credential': 'Correo o contraseña incorrectos.',
    'auth/email-already-in-use': 'Ya existe una cuenta con ese correo.',
    'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
    'auth/network-request-failed': 'Sin conexión. Revisa tu internet.',
  };
  return map[code] || 'Ocurrió un error. Intenta de nuevo.';
}

$('#auth-toggle').addEventListener('click', () => {
  authMode = authMode === 'signin' ? 'signup' : 'signin';
  $('#auth-submit').textContent = authMode === 'signin' ? 'Entrar' : 'Crear cuenta';
  $('#auth-toggle').textContent =
    authMode === 'signin' ? '¿No tienes cuenta? Regístrate' : '¿Ya tienes cuenta? Inicia sesión';
  $('#auth-error').classList.add('hidden');
});

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const errEl = $('#auth-error');
  const btn = $('#auth-submit');
  errEl.classList.add('hidden');
  btn.disabled = true;
  try {
    if (authMode === 'signin') {
      await signInWithEmailAndPassword(auth, email, password);
    } else {
      await createUserWithEmailAndPassword(auth, email, password);
    }
  } catch (err) {
    errEl.textContent = authErrorMessage(err.code);
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

$('#signout-btn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  // Limpia listeners de la sesión anterior.
  state.unsub.forEach((fn) => fn());
  state.unsub = [];

  if (!user) {
    state.uid = null;
    showScreen('auth');
    return;
  }

  state.uid = user.uid;
  state.email = user.email;
  $('#account-email').textContent = user.email;
  showScreen('app');
  await ensureSeedData();
  subscribeAll();
});

function showScreen(name) {
  $('#splash').classList.add('hidden');
  $('#auth').classList.toggle('hidden', name !== 'auth');
  $('#app').classList.toggle('hidden', name !== 'app');
}

// ---------------------------------------------------------------------------
//  Semilla inicial: perfil "Personal" + categorías por defecto
// ---------------------------------------------------------------------------
async function ensureSeedData() {
  // Lee una sola vez de forma rápida vía listener temporal no sirve aquí;
  // usamos una lectura directa con un snapshot puntual mediante onSnapshot once.
  const profilesSnap = await getOnce(col('profiles'));
  if (!profilesSnap.empty) return;

  const batch = writeBatch(db);
  const personalRef = doc(col('profiles'));
  batch.set(personalRef, { name: 'Personal', type: 'personal', createdAt: serverTimestamp() });
  for (const c of DEFAULT_CATEGORIES) {
    batch.set(doc(col('categories')), { ...c, createdAt: serverTimestamp() });
  }
  await batch.commit();
}

// Lectura puntual usando un listener que se cancela al primer resultado.
function getOnce(ref) {
  return new Promise((resolve, reject) => {
    const unsub = onSnapshot(
      ref,
      (snap) => {
        unsub();
        resolve(snap);
      },
      (err) => {
        unsub();
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
//  Listeners en tiempo real
// ---------------------------------------------------------------------------
function subscribeAll() {
  state.unsub.push(
    onSnapshot(col('profiles'), (snap) => {
      state.profiles = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (!state.currentProfileId || !state.profiles.find((p) => p.id === state.currentProfileId)) {
        const saved = localStorage.getItem('finanzapp.profile');
        state.currentProfileId =
          (saved && state.profiles.find((p) => p.id === saved)?.id) || state.profiles[0]?.id || null;
      }
      renderProfiles();
      render();
    }),
  );

  state.unsub.push(
    onSnapshot(col('categories'), (snap) => {
      state.categories = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }),
  );

  state.unsub.push(
    onSnapshot(col('transactions'), (snap) => {
      state.transactions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      // Indicador de sincronización: si el snapshot viene de caché, aún no subió.
      setSyncBadge(snap.metadata.fromCache ? 'syncing' : 'ok');
      render();
    }),
  );
}

function setSyncBadge(status) {
  const el = $('#sync-badge');
  el.classList.remove('offline', 'syncing');
  if (!navigator.onLine) {
    el.classList.add('offline');
    el.textContent = 'cloud_off';
    el.title = 'Sin conexión — se sincronizará al volver';
  } else if (status === 'syncing') {
    el.classList.add('syncing');
    el.textContent = 'cloud_sync';
    el.title = 'Sincronizando…';
  } else {
    el.textContent = 'cloud_done';
    el.title = 'Sincronizado';
  }
}
window.addEventListener('online', () => setSyncBadge('ok'));
window.addEventListener('offline', () => setSyncBadge('offline'));

// ---------------------------------------------------------------------------
//  Helpers de datos
// ---------------------------------------------------------------------------
function currentProfile() {
  return state.profiles.find((p) => p.id === state.currentProfileId) || null;
}
function profileTransactions() {
  return state.transactions
    .filter((t) => t.profileId === state.currentProfileId)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
function profileCategories() {
  const p = currentProfile();
  if (!p) return [];
  return state.categories
    .filter((c) => c.profileType === p.type)
    .sort((a, b) => a.name.localeCompare(b.name));
}
function categoryById(id) {
  return state.categories.find((c) => c.id === id) || null;
}

// ---------------------------------------------------------------------------
//  Render
// ---------------------------------------------------------------------------
function render() {
  renderDashboard();
  renderTransactions();
  renderCategoriesList();
}

function renderProfiles() {
  const sel = $('#profile-select');
  sel.innerHTML = '';
  for (const p of state.profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === state.currentProfileId) opt.selected = true;
    sel.appendChild(opt);
  }

  const list = $('#profiles-list');
  list.innerHTML = '';
  for (const p of state.profiles) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.innerHTML = `<div><span class="name">${esc(p.name)}</span>
      <span class="chip">${p.type === 'business' ? 'Negocio' : 'Personal'}</span></div>`;
    if (state.profiles.length > 1) {
      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.innerHTML = '<span class="material-symbols-rounded">delete</span>';
      del.onclick = () => deleteProfile(p);
      row.appendChild(del);
    }
    list.appendChild(row);
  }
}

function renderDashboard() {
  const txs = profileTransactions();
  const balance = txs.reduce((s, t) => s + (t.type === 'income' ? t.amount : -t.amount), 0);
  $('#balance-amount').textContent = money(balance);

  const month = todayIso().slice(0, 7);
  const monthTxs = txs.filter((t) => (t.date || '').startsWith(month));
  const income = monthTxs.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expense = monthTxs.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  $('#month-income').textContent = money(income);
  $('#month-expense').textContent = money(expense);

  // Desglose de gastos del mes por categoría.
  const byCat = {};
  for (const t of monthTxs.filter((t) => t.type === 'expense')) {
    byCat[t.categoryId] = (byCat[t.categoryId] || 0) + t.amount;
  }
  const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const wrap = $('#category-breakdown');
  wrap.innerHTML = '';
  if (entries.length === 0) {
    wrap.innerHTML = '<p class="muted" style="text-align:center">Sin gastos este mes.</p>';
  }
  for (const [catId, amount] of entries) {
    const cat = categoryById(catId);
    const pct = expense > 0 ? Math.round((amount / expense) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'cat-bar-row';
    row.innerHTML = `
      <div class="cat-bar-head"><span>${esc(cat?.name || 'Sin categoría')}</span><strong>${money(amount)}</strong></div>
      <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${pct}%;background:${cat?.color || '#6B7280'}"></div></div>`;
    wrap.appendChild(row);
  }
}

function renderTransactions() {
  const txs = profileTransactions();
  const list = $('#tx-list');
  list.innerHTML = '';
  $('#tx-empty').classList.toggle('hidden', txs.length > 0);
  for (const t of txs) {
    const cat = categoryById(t.categoryId);
    const item = document.createElement('div');
    item.className = 'tx-item';
    item.innerHTML = `
      <span class="tx-icon" style="background:${cat?.color || '#6B7280'}">
        <span class="material-symbols-rounded">${t.type === 'income' ? 'arrow_upward' : 'arrow_downward'}</span>
      </span>
      <div class="tx-main">
        <div class="tx-cat">${esc(cat?.name || 'Sin categoría')}</div>
        <div class="tx-meta">${esc(t.date || '')}${t.note ? ' · ' + esc(t.note) : ''}</div>
      </div>
      <span class="tx-amount ${t.type}">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</span>`;
    item.onclick = () => openTxActions(t);
    list.appendChild(item);
  }
}

function renderCategoriesList() {
  const list = $('#categories-list');
  if (!list) return;
  list.innerHTML = '';
  for (const c of profileCategories()) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.innerHTML = `<div><span class="name">${esc(c.name)}</span>
      <span class="chip" style="background:${c.color}22;color:${c.color}">${c.type === 'income' ? 'Ingreso' : 'Gasto'}</span></div>`;
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.innerHTML = '<span class="material-symbols-rounded">delete</span>';
    del.onclick = () => deleteDoc(doc(col('categories'), c.id));
    row.appendChild(del);
    list.appendChild(row);
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// ---------------------------------------------------------------------------
//  Navegación (tabs)
// ---------------------------------------------------------------------------
document.querySelectorAll('.nav-item').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const view = tab.dataset.view;
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $(`#view-${view}`).classList.remove('hidden');
    $('#fab').classList.toggle('hidden', view === 'settings');
  });
});

$('#profile-select').addEventListener('change', (e) => {
  state.currentProfileId = e.target.value;
  localStorage.setItem('finanzapp.profile', state.currentProfileId);
  render();
});

// ---------------------------------------------------------------------------
//  Modal genérico
// ---------------------------------------------------------------------------
function openModal(title, bodyNode) {
  $('#modal-title').textContent = title;
  const body = $('#modal-body');
  body.innerHTML = '';
  body.appendChild(bodyNode);
  $('#modal-backdrop').classList.remove('hidden');
}
function closeModal() {
  $('#modal-backdrop').classList.add('hidden');
}
$('#modal-close').addEventListener('click', closeModal);
$('#modal-backdrop').addEventListener('click', (e) => {
  if (e.target === $('#modal-backdrop')) closeModal();
});

// ---------------------------------------------------------------------------
//  Agregar movimiento
// ---------------------------------------------------------------------------
$('#fab').addEventListener('click', openTxForm);

function openTxForm() {
  if (!currentProfile()) return;
  let txType = 'expense';
  const node = document.createElement('div');
  node.innerHTML = `
    <div class="segmented">
      <button type="button" data-t="income">Ingreso</button>
      <button type="button" data-t="expense">Gasto</button>
    </div>
    <label class="stacked">Monto<input type="number" id="f-amount" inputmode="numeric" min="0" step="any" placeholder="0" /></label>
    <label class="stacked">Categoría<select id="f-category"></select></label>
    <label class="stacked">Fecha<input type="date" id="f-date" value="${todayIso()}" /></label>
    <label class="stacked">Nota (opcional)<input type="text" id="f-note" maxlength="120" /></label>
    <p id="f-error" class="error hidden"></p>
    <button id="f-save" class="btn btn-filled btn-block">Guardar</button>`;

  const segBtns = node.querySelectorAll('.segmented button');
  const fillCats = () => {
    const sel = node.querySelector('#f-category');
    sel.innerHTML = '';
    for (const c of profileCategories().filter((c) => c.type === txType)) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      sel.appendChild(o);
    }
  };
  const setType = (t) => {
    txType = t;
    segBtns.forEach((b) => {
      b.classList.remove('active-income', 'active-expense');
      if (b.dataset.t === t) b.classList.add(t === 'income' ? 'active-income' : 'active-expense');
    });
    fillCats();
  };
  segBtns.forEach((b) => b.addEventListener('click', () => setType(b.dataset.t)));
  setType('expense');

  node.querySelector('#f-save').addEventListener('click', async () => {
    const amount = parseFloat(node.querySelector('#f-amount').value);
    const categoryId = node.querySelector('#f-category').value;
    const date = node.querySelector('#f-date').value || todayIso();
    const note = node.querySelector('#f-note').value.trim();
    const err = node.querySelector('#f-error');
    if (!amount || amount <= 0) {
      err.textContent = 'Ingresa un monto mayor a 0.';
      err.classList.remove('hidden');
      return;
    }
    if (!categoryId) {
      err.textContent = 'Crea una categoría primero (en Ajustes).';
      err.classList.remove('hidden');
      return;
    }
    await addDoc(col('transactions'), {
      profileId: state.currentProfileId,
      type: txType,
      amount,
      categoryId,
      date,
      note,
      createdAt: serverTimestamp(),
    });
    closeModal();
  });

  openModal('Nuevo movimiento', node);
}

function openTxActions(t) {
  const cat = categoryById(t.categoryId);
  const node = document.createElement('div');
  node.innerHTML = `
    <div class="settings-row">
      <div><span class="name">${esc(cat?.name || 'Sin categoría')}</span>
      <div class="sub">${esc(t.date)} · ${t.type === 'income' ? 'Ingreso' : 'Gasto'}</div></div>
      <strong class="tx-amount ${t.type}">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</strong>
    </div>
    ${t.note ? `<p class="muted">${esc(t.note)}</p>` : ''}
    <button class="btn btn-danger btn-block" id="tx-del"><span class="material-symbols-rounded">delete</span>Eliminar movimiento</button>`;
  node.querySelector('#tx-del').addEventListener('click', async () => {
    await deleteDoc(doc(col('transactions'), t.id));
    closeModal();
  });
  openModal('Movimiento', node);
}

// ---------------------------------------------------------------------------
//  Perfiles y categorías (Ajustes)
// ---------------------------------------------------------------------------
$('#add-profile-btn').addEventListener('click', () => {
  let type = 'personal';
  const node = document.createElement('div');
  node.innerHTML = `
    <label class="stacked">Nombre<input type="text" id="p-name" maxlength="40" placeholder="Mi negocio" /></label>
    <div class="segmented">
      <button type="button" data-t="personal" class="active-neutral">Personal</button>
      <button type="button" data-t="business">Negocio</button>
    </div>
    <p id="p-error" class="error hidden"></p>
    <button class="btn btn-filled btn-block" id="p-save">Crear perfil</button>`;
  const btns = node.querySelectorAll('.segmented button');
  btns.forEach((b) =>
    b.addEventListener('click', () => {
      type = b.dataset.t;
      btns.forEach((x) => x.classList.remove('active-neutral'));
      b.classList.add('active-neutral');
    }),
  );
  node.querySelector('#p-save').addEventListener('click', async () => {
    const name = node.querySelector('#p-name').value.trim();
    const err = node.querySelector('#p-error');
    if (!name) {
      err.textContent = 'Ponle un nombre al perfil.';
      err.classList.remove('hidden');
      return;
    }
    await addDoc(col('profiles'), { name, type, createdAt: serverTimestamp() });
    closeModal();
  });
  openModal('Nuevo perfil', node);
});

async function deleteProfile(p) {
  const hasTx = state.transactions.some((t) => t.profileId === p.id);
  const msg = hasTx
    ? `El perfil "${p.name}" tiene movimientos. ¿Eliminar el perfil y TODOS sus movimientos?`
    : `¿Eliminar el perfil "${p.name}"?`;
  if (!confirm(msg)) return;
  const batch = writeBatch(db);
  state.transactions
    .filter((t) => t.profileId === p.id)
    .forEach((t) => batch.delete(doc(col('transactions'), t.id)));
  batch.delete(doc(col('profiles'), p.id));
  await batch.commit();
  if (state.currentProfileId === p.id) state.currentProfileId = null;
}

$('#add-category-btn').addEventListener('click', () => {
  const p = currentProfile();
  if (!p) return;
  let type = 'expense';
  const node = document.createElement('div');
  node.innerHTML = `
    <label class="stacked">Nombre<input type="text" id="c-name" maxlength="40" placeholder="Ej. Materiales" /></label>
    <div class="segmented">
      <button type="button" data-t="income">Ingreso</button>
      <button type="button" data-t="expense" class="active-expense">Gasto</button>
    </div>
    <label class="stacked">Color<input type="color" id="c-color" value="#6B7280" /></label>
    <p id="c-error" class="error hidden"></p>
    <button class="btn btn-filled btn-block" id="c-save">Crear categoría</button>`;
  const btns = node.querySelectorAll('.segmented button');
  btns.forEach((b) =>
    b.addEventListener('click', () => {
      type = b.dataset.t;
      btns.forEach((x) => x.classList.remove('active-income', 'active-expense'));
      b.classList.add(type === 'income' ? 'active-income' : 'active-expense');
    }),
  );
  node.querySelector('#c-save').addEventListener('click', async () => {
    const name = node.querySelector('#c-name').value.trim();
    const color = node.querySelector('#c-color').value;
    const err = node.querySelector('#c-error');
    if (!name) {
      err.textContent = 'Ponle un nombre a la categoría.';
      err.classList.remove('hidden');
      return;
    }
    await addDoc(col('categories'), { name, type, profileType: p.type, color, createdAt: serverTimestamp() });
    closeModal();
  });
  openModal('Nueva categoría', node);
});

// Arranque: si Firebase no está configurado, avisa claramente.
if (firebaseConfig.apiKey === 'PEGA_AQUI_TU_API_KEY') {
  $('#splash').innerHTML =
    '<div style="padding:24px;text-align:center;color:#6b7280">Falta configurar Firebase.<br>Edita <code>js/config.js</code> con las claves de tu proyecto.</div>';
}
