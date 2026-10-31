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
  updateDoc,
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
  products: [],
  orders: [],
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
      updateBusinessTabs();
      render();
    }),
  );

  state.unsub.push(
    onSnapshot(col('products'), (snap) => {
      state.products = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }),
  );

  state.unsub.push(
    onSnapshot(col('orders'), (snap) => {
      state.orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
      // Indicador de sincronización: hay cambios locales sin confirmar aún.
      setSyncBadge(snap.metadata.hasPendingWrites ? 'syncing' : 'ok');
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
function profileProducts() {
  return state.products
    .filter((p) => p.profileId === state.currentProfileId)
    .sort((a, b) => a.name.localeCompare(b.name));
}
function isLowStock(p) {
  return p.minStock > 0 && p.stock <= p.minStock;
}
function profileOrders() {
  return state.orders
    .filter((o) => o.profileId === state.currentProfileId)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// Estados de pedido y transiciones permitidas (no se retrocede).
const ORDER_STATUS = {
  pending: { label: 'Pendiente', next: ['processing', 'shipped', 'delivered'] },
  processing: { label: 'En proceso', next: ['shipped', 'delivered'] },
  shipped: { label: 'Enviado', next: ['delivered'] },
  delivered: { label: 'Entregado', next: [] },
  cancelled: { label: 'Cancelado', next: [] },
};

// ---------------------------------------------------------------------------
//  Render
// ---------------------------------------------------------------------------
function render() {
  renderDashboard();
  renderTransactions();
  renderCategoriesList();
  renderInventory();
  renderOrders();
}

/** Muestra/oculta las pestañas de negocio (Inventario, Ventas). */
function updateBusinessTabs() {
  const isBusiness = currentProfile()?.type === 'business';
  $('#nav-inventory').classList.toggle('hidden', !isBusiness);
  $('#nav-sales').classList.toggle('hidden', !isBusiness);
  // Si estamos en una vista de negocio y cambiamos a un perfil personal, al tablero.
  const inBusinessView =
    !$('#view-inventory').classList.contains('hidden') || !$('#view-sales').classList.contains('hidden');
  if (!isBusiness && inBusinessView) switchView('dashboard');
}

function renderInventory() {
  const products = profileProducts();
  const list = $('#inv-list');
  if (!list) return;
  list.innerHTML = '';
  $('#inv-empty').classList.toggle('hidden', products.length > 0);
  for (const p of products) {
    const low = isLowStock(p);
    const item = document.createElement('div');
    item.className = 'tx-item';
    item.innerHTML = `
      <span class="tx-icon" style="background:${p.kind === 'material' ? '#8B5CF6' : '#1b61d1'}">
        <span class="material-symbols-rounded">${p.kind === 'material' ? 'category' : 'inventory_2'}</span>
      </span>
      <div class="tx-main">
        <div class="tx-cat">${esc(p.name)}</div>
        <div class="tx-meta">
          Stock: <strong class="${low ? 'low-stock' : ''}">${p.stock}</strong>${low ? ' ⚠️' : ''}
          ${p.price > 0 ? ' · ' + money(p.price) : ''}
        </div>
      </div>
      <span class="material-symbols-rounded" style="color:var(--on-surface-variant)">chevron_right</span>`;
    item.onclick = () => openProductActions(p);
    list.appendChild(item);
  }
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
function switchView(view) {
  document.querySelectorAll('.nav-item').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${view}`).classList.remove('hidden');
  $('#fab').classList.toggle('hidden', view === 'settings');
}
document.querySelectorAll('.nav-item').forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});

$('#profile-select').addEventListener('change', (e) => {
  state.currentProfileId = e.target.value;
  localStorage.setItem('finanzapp.profile', state.currentProfileId);
  updateBusinessTabs();
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
$('#fab').addEventListener('click', () => {
  if (!$('#view-inventory').classList.contains('hidden')) openProductForm();
  else if (!$('#view-sales').classList.contains('hidden')) openOrderForm();
  else openTxForm();
});

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
//  Inventario (productos)
// ---------------------------------------------------------------------------
function openProductForm(existing) {
  if (!currentProfile()) return;
  let kind = existing?.kind || 'product';
  const node = document.createElement('div');
  node.innerHTML = `
    <label class="stacked">Nombre<input type="text" id="pr-name" maxlength="60" value="${existing ? esc(existing.name) : ''}" placeholder="Ej. Caja grande" /></label>
    <div class="segmented">
      <button type="button" data-k="product">Producto</button>
      <button type="button" data-k="material">Material</button>
    </div>
    <label class="stacked">Stock ${existing ? 'actual' : 'inicial'}<input type="number" id="pr-stock" inputmode="numeric" min="0" step="any" value="${existing ? existing.stock : ''}" placeholder="0" /></label>
    <label class="stacked">Precio de venta (opcional)<input type="number" id="pr-price" inputmode="numeric" min="0" step="any" value="${existing?.price || ''}" placeholder="0" /></label>
    <label class="stacked">Stock mínimo para alerta (opcional)<input type="number" id="pr-min" inputmode="numeric" min="0" step="any" value="${existing?.minStock || ''}" placeholder="0" /></label>
    <p id="pr-error" class="error hidden"></p>
    <button class="btn btn-filled btn-block" id="pr-save">${existing ? 'Guardar cambios' : 'Crear producto'}</button>`;
  const kbtns = node.querySelectorAll('.segmented button');
  const setKind = (k) => {
    kind = k;
    kbtns.forEach((b) => b.classList.toggle('active-neutral', b.dataset.k === k));
  };
  kbtns.forEach((b) => b.addEventListener('click', () => setKind(b.dataset.k)));
  setKind(kind);

  node.querySelector('#pr-save').addEventListener('click', async () => {
    const name = node.querySelector('#pr-name').value.trim();
    const stock = parseFloat(node.querySelector('#pr-stock').value) || 0;
    const price = parseFloat(node.querySelector('#pr-price').value) || 0;
    const minStock = parseFloat(node.querySelector('#pr-min').value) || 0;
    const err = node.querySelector('#pr-error');
    if (!name) {
      err.textContent = 'Ponle un nombre al producto.';
      err.classList.remove('hidden');
      return;
    }
    if (existing) {
      await updateDoc(doc(col('products'), existing.id), {
        name, kind, stock, price, minStock, updatedAt: serverTimestamp(),
      });
    } else {
      await addDoc(col('products'), {
        profileId: state.currentProfileId, name, kind, stock, price, minStock,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
    }
    closeModal();
  });
  openModal(existing ? 'Editar producto' : 'Nuevo producto', node);
}

function openProductActions(p) {
  const low = isLowStock(p);
  const node = document.createElement('div');
  node.innerHTML = `
    <div class="settings-row">
      <div><span class="name">${esc(p.name)}</span>
      <span class="chip">${p.kind === 'material' ? 'Material' : 'Producto'}</span>
      <div class="sub">Stock: ${p.stock}${low ? ' ⚠️ bajo' : ''}${p.price > 0 ? ' · ' + money(p.price) : ''}</div></div>
    </div>
    <label class="stacked">Reabastecer (cantidad a sumar)<input type="number" id="rs-qty" inputmode="numeric" min="0" step="any" placeholder="0" /></label>
    <label class="stacked">Costo de la compra (opcional, lo registra como gasto)<input type="number" id="rs-cost" inputmode="numeric" min="0" step="any" placeholder="0" /></label>
    <button class="btn btn-filled btn-block" id="rs-do"><span class="material-symbols-rounded">add_box</span>Reabastecer</button>
    <button class="btn btn-tonal btn-block" id="pr-edit"><span class="material-symbols-rounded">edit</span>Editar producto</button>
    <button class="btn btn-danger btn-block" id="pr-del"><span class="material-symbols-rounded">delete</span>Eliminar</button>`;

  node.querySelector('#rs-do').addEventListener('click', async () => {
    const qty = parseFloat(node.querySelector('#rs-qty').value) || 0;
    const cost = parseFloat(node.querySelector('#rs-cost').value) || 0;
    if (qty <= 0) return;
    await updateDoc(doc(col('products'), p.id), {
      stock: (p.stock || 0) + qty, updatedAt: serverTimestamp(),
    });
    if (cost > 0) {
      const cat =
        state.categories.find((c) => c.profileType === 'business' && c.name === 'Mercancía') ||
        state.categories.find((c) => c.profileType === 'business' && c.type === 'expense');
      if (cat) {
        await addDoc(col('transactions'), {
          profileId: state.currentProfileId, type: 'expense', amount: cost, categoryId: cat.id,
          date: todayIso(), note: `Reabastecer ${p.name} (+${qty})`, createdAt: serverTimestamp(),
        });
      }
    }
    closeModal();
  });
  node.querySelector('#pr-edit').addEventListener('click', () => {
    closeModal();
    openProductForm(p);
  });
  node.querySelector('#pr-del').addEventListener('click', async () => {
    if (!confirm(`¿Eliminar el producto "${p.name}"?`)) return;
    await deleteDoc(doc(col('products'), p.id));
    closeModal();
  });
  openModal('Producto', node);
}

// ---------------------------------------------------------------------------
//  Ventas / Pedidos
// ---------------------------------------------------------------------------
function renderOrders() {
  const orders = profileOrders();
  const list = $('#order-list');
  if (!list) return;
  list.innerHTML = '';
  $('#order-empty').classList.toggle('hidden', orders.length > 0);
  for (const o of orders) {
    const st = ORDER_STATUS[o.status] || ORDER_STATUS.pending;
    const count = (o.items || []).reduce((s, it) => s + it.qty, 0);
    const item = document.createElement('div');
    item.className = 'tx-item';
    item.innerHTML = `
      <span class="tx-icon" style="background:#1b61d1"><span class="material-symbols-rounded">shopping_cart</span></span>
      <div class="tx-main">
        <div class="tx-cat">${esc(o.customerName || 'Cliente')}</div>
        <div class="tx-meta">${count} artículo(s) · ${esc(o.date || '')}</div>
      </div>
      <div style="text-align:right">
        <div class="tx-amount income">${money(o.total)}</div>
        <span class="status-chip status-${o.status}">${st.label}</span>
      </div>`;
    item.onclick = () => openOrderDetails(o);
    list.appendChild(item);
  }
}

function openOrderForm() {
  if (!currentProfile()) return;
  const sellable = profileProducts();
  const node = document.createElement('div');
  const names = [...new Set(state.orders.map((o) => o.customerName).filter(Boolean))];
  node.innerHTML = `
    <label class="stacked">Cliente<input type="text" id="ord-customer" maxlength="60" list="ord-customers" placeholder="Nombre del cliente" /></label>
    <datalist id="ord-customers">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <div class="section-title" style="margin:4px">Artículos</div>
    <div id="ord-items"></div>
    <button type="button" class="btn btn-text" id="ord-add-item"><span class="material-symbols-rounded">add</span>Agregar artículo</button>
    <label class="stacked">Envío (opcional)<input type="number" id="ord-shipping" inputmode="numeric" min="0" step="any" placeholder="0" /></label>
    <label class="stacked">Nota (opcional)<input type="text" id="ord-note" maxlength="120" /></label>
    <div class="ord-total"><span>Total</span><span id="ord-total-val">$0</span></div>
    <p id="ord-error" class="error hidden"></p>
    <button class="btn btn-filled btn-block" id="ord-save">Crear pedido</button>`;

  const itemsWrap = node.querySelector('#ord-items');
  const optionsHtml = sellable
    .map((pr) => `<option value="${pr.id}">${esc(pr.name)} (stock ${pr.stock})</option>`)
    .join('');

  function recalc() {
    let total = 0;
    itemsWrap.querySelectorAll('.ord-item-row').forEach((row) => {
      const pr = state.products.find((x) => x.id === row.querySelector('select').value);
      const qty = parseFloat(row.querySelector('input').value) || 0;
      if (pr) total += qty * (pr.price || 0);
    });
    total += parseFloat(node.querySelector('#ord-shipping').value) || 0;
    node.querySelector('#ord-total-val').textContent = money(total);
  }
  function addItemRow() {
    const row = document.createElement('div');
    row.className = 'ord-item-row';
    row.innerHTML = `
      <select>${optionsHtml}</select>
      <input type="number" inputmode="numeric" min="1" step="any" value="1" />
      <button type="button" class="icon-btn"><span class="material-symbols-rounded">close</span></button>`;
    row.querySelector('select').addEventListener('change', recalc);
    row.querySelector('input').addEventListener('input', recalc);
    row.querySelector('.icon-btn').addEventListener('click', () => {
      row.remove();
      recalc();
    });
    itemsWrap.appendChild(row);
    recalc();
  }
  node.querySelector('#ord-add-item').addEventListener('click', addItemRow);
  node.querySelector('#ord-shipping').addEventListener('input', recalc);
  if (sellable.length) addItemRow();

  node.querySelector('#ord-save').addEventListener('click', async () => {
    const err = node.querySelector('#ord-error');
    const customer = node.querySelector('#ord-customer').value.trim() || 'Cliente';
    const shipping = parseFloat(node.querySelector('#ord-shipping').value) || 0;
    const note = node.querySelector('#ord-note').value.trim();

    const items = [];
    for (const row of itemsWrap.querySelectorAll('.ord-item-row')) {
      const pr = state.products.find((x) => x.id === row.querySelector('select').value);
      const qty = parseFloat(row.querySelector('input').value) || 0;
      if (!pr || qty <= 0) continue;
      items.push({ productId: pr.id, name: pr.name, qty, price: pr.price || 0 });
    }
    if (items.length === 0) {
      err.textContent = 'Agrega al menos un artículo.';
      err.classList.remove('hidden');
      return;
    }
    const needed = {};
    for (const it of items) needed[it.productId] = (needed[it.productId] || 0) + it.qty;
    for (const [pid, qty] of Object.entries(needed)) {
      const pr = state.products.find((x) => x.id === pid);
      if (qty > (pr?.stock || 0)) {
        err.textContent = `No hay stock suficiente de ${pr?.name}. Disponible: ${pr?.stock || 0}.`;
        err.classList.remove('hidden');
        return;
      }
    }
    const total = items.reduce((s, it) => s + it.qty * it.price, 0) + shipping;

    let ventasCat =
      state.categories.find((c) => c.profileType === 'business' && c.name === 'Ventas') ||
      state.categories.find((c) => c.profileType === 'business' && c.type === 'income');
    if (!ventasCat) {
      const ref = await addDoc(col('categories'), {
        name: 'Ventas', type: 'income', profileType: 'business', color: '#059669', createdAt: serverTimestamp(),
      });
      ventasCat = { id: ref.id };
    }

    // Escritura atómica: ingreso + pedido + descuento de stock.
    const batch = writeBatch(db);
    const txRef = doc(col('transactions'));
    const orderRef = doc(col('orders'));
    batch.set(txRef, {
      profileId: state.currentProfileId, type: 'income', amount: total, categoryId: ventasCat.id,
      date: todayIso(), note: `Pedido - ${customer}`, createdAt: serverTimestamp(),
    });
    batch.set(orderRef, {
      profileId: state.currentProfileId, customerName: customer, items, shipping, total,
      status: 'pending', incomeTxId: txRef.id, note, date: todayIso(),
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    for (const [pid, qty] of Object.entries(needed)) {
      const pr = state.products.find((x) => x.id === pid);
      batch.update(doc(col('products'), pid), { stock: (pr.stock || 0) - qty, updatedAt: serverTimestamp() });
    }
    await batch.commit();
    closeModal();
  });

  openModal('Nuevo pedido', node);
}

function openOrderDetails(o) {
  const st = ORDER_STATUS[o.status] || ORDER_STATUS.pending;
  const node = document.createElement('div');
  const itemsHtml = (o.items || [])
    .map(
      (it) => `<div class="settings-row"><div><span class="name">${esc(it.name)}</span>
      <div class="sub">${it.qty} × ${money(it.price)}</div></div><strong>${money(it.qty * it.price)}</strong></div>`,
    )
    .join('');
  const nextBtns = st.next
    .map((s) => `<button class="btn btn-tonal btn-block ord-next" data-s="${s}">Marcar como ${ORDER_STATUS[s].label}</button>`)
    .join('');
  const canCancel = o.status !== 'cancelled' && o.status !== 'delivered';
  node.innerHTML = `
    <div class="settings-row">
      <div><span class="name">${esc(o.customerName || 'Cliente')}</span>
      <div class="sub">${esc(o.date || '')}</div></div>
      <span class="status-chip status-${o.status}">${st.label}</span>
    </div>
    ${itemsHtml}
    ${o.shipping > 0 ? `<div class="settings-row"><span class="muted">Envío</span><strong>${money(o.shipping)}</strong></div>` : ''}
    <div class="ord-total"><span>Total</span><span>${money(o.total)}</span></div>
    ${o.note ? `<p class="muted">${esc(o.note)}</p>` : ''}
    ${nextBtns}
    ${canCancel ? `<button class="btn btn-danger btn-block" id="ord-cancel"><span class="material-symbols-rounded">cancel</span>Cancelar pedido</button>` : ''}`;

  node.querySelectorAll('.ord-next').forEach((b) =>
    b.addEventListener('click', async () => {
      await updateDoc(doc(col('orders'), o.id), { status: b.dataset.s, updatedAt: serverTimestamp() });
      closeModal();
    }),
  );
  const cancelBtn = node.querySelector('#ord-cancel');
  if (cancelBtn)
    cancelBtn.addEventListener('click', async () => {
      if (!confirm('¿Cancelar el pedido? Se restaurará el stock y se revertirá el ingreso.')) return;
      const batch = writeBatch(db);
      const restore = {};
      for (const it of o.items || []) restore[it.productId] = (restore[it.productId] || 0) + it.qty;
      for (const [pid, qty] of Object.entries(restore)) {
        const pr = state.products.find((x) => x.id === pid);
        if (pr) batch.update(doc(col('products'), pid), { stock: (pr.stock || 0) + qty, updatedAt: serverTimestamp() });
      }
      if (o.incomeTxId) batch.delete(doc(col('transactions'), o.incomeTxId));
      batch.update(doc(col('orders'), o.id), { status: 'cancelled', updatedAt: serverTimestamp() });
      await batch.commit();
      closeModal();
    });

  openModal('Pedido', node);
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
