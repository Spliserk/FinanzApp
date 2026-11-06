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
  sendPasswordResetEmail,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  collectionGroup,
  query,
  where,
  doc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  arrayUnion,
  arrayRemove,
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
  contracts: [],
  invites: [], // invitaciones pendientes dirigidas a este usuario
  currentProfileId: null,
  profileSubFor: null, // de qué perfil están cargados los datos ahora mismo
  unsub: [], // listeners globales (perfiles + invitaciones); se limpian al salir
  dataUnsub: [], // listeners de los datos del perfil actual; se limpian al cambiar
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

// --- Rutas de colecciones ---
// Los perfiles son de nivel superior y tienen una lista de "members" (uids).
// Los datos de cada perfil cuelgan de él, así se pueden compartir entre usuarios.
const profilesCol = () => collection(db, 'profiles');
const pcol = (name, pid = state.currentProfileId) => collection(db, 'profiles', pid, name);
const pdoc = (name, id, pid = state.currentProfileId) => doc(db, 'profiles', pid, name, id);

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

$('#auth-forgot').addEventListener('click', async () => {
  const email = $('#auth-email').value.trim();
  const errEl = $('#auth-error');
  errEl.classList.remove('ok');
  if (!email) {
    errEl.textContent = 'Escribe tu correo arriba y vuelve a tocar aquí.';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    errEl.textContent = 'Te enviamos un correo para restablecer tu contraseña. Revisa tu bandeja (y spam).';
    errEl.classList.add('ok');
    errEl.classList.remove('hidden');
  } catch (err) {
    errEl.textContent = authErrorMessage(err.code);
    errEl.classList.remove('hidden');
  }
});

$('#signout-btn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  // Limpia listeners de la sesión anterior (globales y de datos del perfil).
  state.unsub.forEach((fn) => fn());
  state.dataUnsub.forEach((fn) => fn());
  state.unsub = [];
  state.dataUnsub = [];
  state.profileSubFor = null;

  if (!user) {
    state.uid = null;
    showScreen('auth');
    return;
  }

  state.uid = user.uid;
  state.email = (user.email || '').toLowerCase();
  $('#account-email').textContent = user.email;
  showScreen('app');
  try {
    await ensureSeedData();
  } catch (e) {
    console.warn('[seed] no se pudo sembrar (¿faltan publicar las reglas?):', e);
  }
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
function defaultCategoriesFor(type) {
  return DEFAULT_CATEGORIES.filter((c) => c.profileType === type);
}

/** Crea un perfil nuevo (de nivel superior, con el creador como miembro) y
 *  siembra sus categorías por defecto. Devuelve el id del perfil. */
async function createProfile({ name, type, mode }) {
  const ref = doc(profilesCol());
  const data = {
    name,
    type,
    ownerUid: state.uid,
    members: [state.uid],
    memberEmails: [state.email],
    createdAt: serverTimestamp(),
  };
  if (type === 'business') data.mode = mode || 'sales';
  // 1) Crear el perfil primero: las reglas necesitan verlo (membresía) para
  //    permitir escribir en sus subcolecciones. 2) Luego sembrar categorías.
  await setDoc(ref, data);
  const batch = writeBatch(db);
  for (const c of defaultCategoriesFor(type)) {
    batch.set(doc(collection(db, 'profiles', ref.id, 'categories')), { ...c, createdAt: serverTimestamp() });
  }
  await batch.commit();
  return ref.id;
}

async function ensureSeedData() {
  // ¿El usuario ya pertenece a algún perfil? Si no, le creamos uno "Personal".
  const mine = await getOnce(query(profilesCol(), where('members', 'array-contains', state.uid)));
  if (!mine.empty) return;
  await createProfile({ name: 'Personal', type: 'personal' });
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
  // Perfiles a los que pertenezco (propios + compartidos).
  state.unsub.push(
    onSnapshot(query(profilesCol(), where('members', 'array-contains', state.uid)), (snap) => {
      state.profiles = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      let pid = state.currentProfileId;
      if (!pid || !state.profiles.find((p) => p.id === pid)) {
        const saved = localStorage.getItem('finanzapp.profile');
        pid = (saved && state.profiles.find((p) => p.id === saved)?.id) || state.profiles[0]?.id || null;
      }
      setCurrentProfile(pid);
    }),
  );

  // Invitaciones pendientes dirigidas a mi correo (en cualquier perfil).
  state.unsub.push(
    onSnapshot(query(collectionGroup(db, 'invites'), where('email', '==', state.email)), (snap) => {
      state.invites = snap.docs.map((d) => ({ id: d.id, profileId: d.ref.parent.parent.id, ...d.data() }));
      renderInvites();
    }),
  );
}

/** Cambia de perfil: re-suscribe los listeners de datos de ese perfil. */
function setCurrentProfile(pid) {
  state.currentProfileId = pid;
  if (pid) localStorage.setItem('finanzapp.profile', pid);
  renderProfiles();
  updateBusinessTabs();
  if (pid !== state.profileSubFor) {
    state.dataUnsub.forEach((fn) => fn());
    state.dataUnsub = [];
    state.profileSubFor = pid;
    state.transactions = [];
    state.products = [];
    state.orders = [];
    state.contracts = [];
    state.categories = [];
    if (pid) subscribeProfileData(pid);
  }
  render();
}

function subscribeProfileData(pid) {
  const sub = (name, apply) =>
    state.dataUnsub.push(
      onSnapshot(collection(db, 'profiles', pid, name), (snap) => {
        if (state.profileSubFor !== pid) return; // snapshot de un perfil ya abandonado
        apply(
          snap.docs.map((d) => ({ id: d.id, ...d.data() })),
          snap,
        );
        render();
      }),
    );
  sub('categories', (rows) => (state.categories = rows));
  sub('products', (rows) => (state.products = rows));
  sub('orders', (rows) => (state.orders = rows));
  sub('contracts', (rows) => (state.contracts = rows));
  sub('transactions', (rows, snap) => {
    state.transactions = rows;
    setSyncBadge(snap.metadata.hasPendingWrites ? 'syncing' : 'ok');
  });
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

// --- Alquileres ---
const CONTRACT_STATUS = {
  reserved: { label: 'Apartado' },
  picked_up: { label: 'Recogido' },
  returned: { label: 'Devuelto' },
  cancelled: { label: 'Cancelado' },
};
function isRentalProfile() {
  return currentProfile()?.mode === 'rental';
}
function isContractOverdue(c) {
  return (c.status === 'reserved' || c.status === 'picked_up') && c.dueDate && c.dueDate < todayIso();
}
function profileContracts() {
  return state.contracts
    .filter((c) => c.profileId === state.currentProfileId)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
/** Unidades "fuera" de un producto en contratos activos (apartados o recogidos). */
function rentedOut(productId) {
  return state.contracts
    .filter(
      (c) =>
        c.profileId === state.currentProfileId &&
        (c.status === 'reserved' || c.status === 'picked_up'),
    )
    .reduce(
      (sum, c) =>
        sum + (c.items || []).filter((it) => it.productId === productId).reduce((s, it) => s + it.qty, 0),
      0,
    );
}
function productAvailable(p) {
  return (p.stock || 0) - rentedOut(p.id);
}

// ---------------------------------------------------------------------------
//  Render
// ---------------------------------------------------------------------------
function render() {
  renderCalendar();
  renderDashboard();
  renderTransactions();
  renderCategoriesList();
  renderInventory();
  renderOrders();
  renderRentals();
  renderInvites();
  renderShareSection();
}

/** Muestra/oculta las pestañas de negocio según el tipo y modo del perfil. */
function updateBusinessTabs() {
  const p = currentProfile();
  const isBusiness = p?.type === 'business';
  const mode = p?.mode || 'sales'; // negocios creados antes del modo = ventas
  $('#nav-inventory').classList.toggle('hidden', !isBusiness);
  $('#nav-sales').classList.toggle('hidden', !(isBusiness && mode === 'sales'));
  $('#nav-rentals').classList.toggle('hidden', !(isBusiness && mode === 'rental'));
  // Si la vista activa ya no corresponde a este perfil, volvemos al tablero.
  const allowed = new Set(['view-dashboard', 'view-transactions', 'view-settings']);
  if (isBusiness) {
    allowed.add('view-inventory');
    allowed.add(mode === 'rental' ? 'view-rentals' : 'view-sales');
  }
  const activeView = document.querySelector('.view:not(.hidden)')?.id;
  if (activeView && !allowed.has(activeView)) switchView('dashboard');
}

function renderInventory() {
  const products = profileProducts();
  const list = $('#inv-list');
  if (!list) return;
  list.innerHTML = '';
  $('#inv-empty').classList.toggle('hidden', products.length > 0);
  const rental = isRentalProfile();
  for (const p of products) {
    const low = isLowStock(p);
    const avail = productAvailable(p);
    const stockLine = rental
      ? `Disponibles: <strong class="${avail <= 0 ? 'low-stock' : ''}">${avail}</strong> de ${p.stock}`
      : `Stock: <strong class="${low ? 'low-stock' : ''}">${p.stock}</strong>${low ? ' ⚠️' : ''}`;
    const item = document.createElement('div');
    item.className = 'tx-item';
    item.innerHTML = `
      <span class="tx-icon" style="background:${p.kind === 'material' ? '#8B5CF6' : '#1b61d1'}">
        <span class="material-symbols-rounded">${p.kind === 'material' ? 'category' : 'inventory_2'}</span>
      </span>
      <div class="tx-main">
        <div class="tx-cat">${esc(p.name)}</div>
        <div class="tx-meta">${stockLine}${p.price > 0 ? ' · ' + money(p.price) : ''}</div>
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

// --- Calendario de eventos (entregas, recogidas, devoluciones) ---
let calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

function profileEvents() {
  const evs = [];
  for (const o of profileOrders()) {
    if (o.dueDate && o.status !== 'delivered' && o.status !== 'cancelled')
      evs.push({
        date: o.dueDate, color: '#1b61d1', icon: 'local_shipping',
        label: `Entregar · ${o.customerName || 'Cliente'}`, onClick: () => openOrderDetails(o),
      });
  }
  for (const c of profileContracts()) {
    if (c.status === 'cancelled') continue;
    if (c.pickupDate && c.status === 'reserved')
      evs.push({
        date: c.pickupDate, color: '#8B5CF6', icon: 'outbox',
        label: `Recoger · ${c.customerName || 'Cliente'}`, onClick: () => openContractDetails(c),
      });
    if (c.dueDate && c.status !== 'returned')
      evs.push({
        date: c.dueDate, color: '#D97706', icon: 'assignment_return',
        label: `Devolver · ${c.customerName || 'Cliente'}`, onClick: () => openContractDetails(c),
      });
  }
  return evs;
}

function renderCalendar() {
  const wrap = $('#calendar');
  const agenda = $('#agenda');
  if (!wrap || !agenda) return;
  const events = profileEvents();
  const byDate = {};
  for (const e of events) (byDate[e.date] = byDate[e.date] || []).push(e);

  const y = calMonth.getFullYear();
  const m = calMonth.getMonth();
  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7; // lunes = 0
  const daysIn = new Date(y, m + 1, 0).getDate();
  const today = todayIso();

  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += '<div class="cal-cell empty"></div>';
  for (let d = 1; d <= daysIn; d++) {
    const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const evs = byDate[ds] || [];
    const dots = [...new Set(evs.map((e) => e.color))]
      .slice(0, 3)
      .map((c) => `<span class="cal-dot" style="background:${c}"></span>`)
      .join('');
    cells += `<div class="cal-cell${ds === today ? ' today' : ''}" data-date="${ds}">
      <span class="cal-num">${d}</span><span class="cal-dots">${dots}</span></div>`;
  }
  const dows = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'];
  wrap.innerHTML = `
    <div class="cal-head">
      <button class="icon-btn" id="cal-prev"><span class="material-symbols-rounded">chevron_left</span></button>
      <strong class="cal-title">${calMonth.toLocaleDateString('es', { month: 'long', year: 'numeric' })}</strong>
      <button class="icon-btn" id="cal-next"><span class="material-symbols-rounded">chevron_right</span></button>
    </div>
    <div class="cal-grid cal-dow">${dows.map((d) => `<div class="cal-dowc">${d}</div>`).join('')}</div>
    <div class="cal-grid">${cells}</div>`;
  wrap.querySelector('#cal-prev').onclick = () => {
    calMonth = new Date(y, m - 1, 1);
    renderCalendar();
  };
  wrap.querySelector('#cal-next').onclick = () => {
    calMonth = new Date(y, m + 1, 1);
    renderCalendar();
  };

  // Agenda: eventos pendientes ordenados por fecha (los atrasados primero).
  const list = events.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(0, 8);
  if (list.length === 0) {
    agenda.innerHTML = '';
    return;
  }
  agenda.innerHTML = '<h2 class="section-title">Próximos eventos</h2>';
  const ul = document.createElement('div');
  ul.className = 'tx-list';
  for (const e of list) {
    const overdue = e.date < today;
    const row = document.createElement('div');
    row.className = 'tx-item';
    row.innerHTML = `
      <span class="tx-icon" style="background:${e.color}"><span class="material-symbols-rounded">${e.icon}</span></span>
      <div class="tx-main"><div class="tx-cat">${esc(e.label)}</div>
        <div class="tx-meta ${overdue ? 'low-stock' : ''}">${esc(e.date)}${overdue ? ' · atrasado' : ''}</div></div>`;
    row.onclick = e.onClick;
    ul.appendChild(row);
  }
  agenda.appendChild(ul);
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

  renderMonthlyTrend(txs);
}

/** Gráfico de ingresos vs gastos de los últimos 6 meses del perfil actual. */
function renderMonthlyTrend(txs) {
  const wrap = $('#monthly-trend');
  if (!wrap) return;
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({ key, label: d.toLocaleDateString('es', { month: 'short' }), income: 0, expense: 0 });
  }
  for (const t of txs) {
    const m = months.find((x) => (t.date || '').startsWith(x.key));
    if (!m) continue;
    if (t.type === 'income') m.income += t.amount;
    else m.expense += t.amount;
  }
  const max = Math.max(1, ...months.map((m) => Math.max(m.income, m.expense)));
  wrap.innerHTML = months
    .map(
      (m) => `
      <div class="mt-col">
        <div class="mt-bars">
          <div class="mt-bar mt-income" style="height:${(m.income / max) * 100}%" title="Ingresos ${money(m.income)}"></div>
          <div class="mt-bar mt-expense" style="height:${(m.expense / max) * 100}%" title="Gastos ${money(m.expense)}"></div>
        </div>
        <div class="mt-label">${m.label}</div>
      </div>`,
    )
    .join('');
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
    del.onclick = () => deleteDoc(pdoc('categories', c.id));
    row.appendChild(del);
    list.appendChild(row);
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// --- Recibos (impresión → "Guardar como PDF" desde el navegador) ---
function formatReceiptNumber(date, id) {
  return `${(date || todayIso()).replace(/-/g, '')}-${(id || '').slice(-4).toUpperCase()}`;
}
function printReceipt({ title, id, date, customer, items, extraLabel, extraValue, total }) {
  const rows = (items || [])
    .map(
      (it) =>
        `<tr><td>${esc(it.name)}</td><td class="num">${it.qty}</td><td class="num">${money(it.price)}</td><td class="num">${money(it.qty * it.price)}</td></tr>`,
    )
    .join('');
  const business = currentProfile()?.name || 'FinanzApp';
  $('#print-area').innerHTML = `
    <div class="receipt">
      <h1>${esc(business)}</h1>
      <div class="r-sub">${esc(title)} — Recibo</div>
      <div class="r-meta"><span>Recibo N.º</span><strong>${formatReceiptNumber(date, id)}</strong></div>
      <div class="r-meta"><span>Fecha</span><span>${esc(date || todayIso())}</span></div>
      <div class="r-meta"><span>Cliente</span><span>${esc(customer || 'Cliente')}</span></div>
      <table>
        <thead><tr><th>Artículo</th><th class="num">Cant.</th><th class="num">P. unit.</th><th class="num">Subtotal</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${extraValue ? `<div class="r-meta"><span>${esc(extraLabel)}</span><span>${money(extraValue)}</span></div>` : ''}
      <div class="r-total"><span>Total</span><span>${money(total)}</span></div>
      <div class="r-foot">¡Gracias por su preferencia!</div>
    </div>`;
  window.print();
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

$('#profile-select').addEventListener('change', (e) => setCurrentProfile(e.target.value));

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
  else if (!$('#view-rentals').classList.contains('hidden')) openContractForm();
  else openTxForm();
});

function openTxForm(existing) {
  if (!currentProfile()) return;
  let txType = existing?.type || 'expense';
  const node = document.createElement('div');
  node.innerHTML = `
    <div class="segmented">
      <button type="button" data-t="income">Ingreso</button>
      <button type="button" data-t="expense">Gasto</button>
    </div>
    <label class="stacked">Monto<input type="number" id="f-amount" inputmode="numeric" min="0" step="any" value="${existing ? existing.amount : ''}" placeholder="0" /></label>
    <label class="stacked">Categoría<select id="f-category"></select></label>
    <label class="stacked">Fecha<input type="date" id="f-date" value="${existing?.date || todayIso()}" /></label>
    <label class="stacked">Nota (opcional)<input type="text" id="f-note" maxlength="120" value="${existing ? esc(existing.note || '') : ''}" /></label>
    <p id="f-error" class="error hidden"></p>
    <button id="f-save" class="btn btn-filled btn-block">${existing ? 'Guardar cambios' : 'Guardar'}</button>`;

  const segBtns = node.querySelectorAll('.segmented button');
  const fillCats = () => {
    const sel = node.querySelector('#f-category');
    sel.innerHTML = '';
    for (const c of profileCategories().filter((c) => c.type === txType)) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      if (existing && c.id === existing.categoryId) o.selected = true;
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
  setType(txType);

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
    if (existing) {
      await updateDoc(pdoc('transactions', existing.id), {
        type: txType, amount, categoryId, date, note, updatedAt: serverTimestamp(),
      });
    } else {
      await addDoc(pcol('transactions'), {
        profileId: state.currentProfileId, type: txType, amount, categoryId, date, note,
        createdAt: serverTimestamp(),
      });
    }
    closeModal();
  });

  openModal(existing ? 'Editar movimiento' : 'Nuevo movimiento', node);
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
    <button class="btn btn-tonal btn-block" id="tx-edit"><span class="material-symbols-rounded">edit</span>Editar movimiento</button>
    <button class="btn btn-danger btn-block" id="tx-del"><span class="material-symbols-rounded">delete</span>Eliminar movimiento</button>`;
  node.querySelector('#tx-edit').addEventListener('click', () => {
    closeModal();
    openTxForm(t);
  });
  node.querySelector('#tx-del').addEventListener('click', async () => {
    await deleteDoc(pdoc('transactions', t.id));
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
      await updateDoc(pdoc('products', existing.id), {
        name, kind, stock, price, minStock, updatedAt: serverTimestamp(),
      });
    } else {
      await addDoc(pcol('products'), {
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
    await updateDoc(pdoc('products', p.id), {
      stock: (p.stock || 0) + qty, updatedAt: serverTimestamp(),
    });
    if (cost > 0) {
      const cat =
        state.categories.find((c) => c.profileType === 'business' && c.name === 'Mercancía') ||
        state.categories.find((c) => c.profileType === 'business' && c.type === 'expense');
      if (cat) {
        await addDoc(pcol('transactions'), {
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
    await deleteDoc(pdoc('products', p.id));
    closeModal();
  });
  openModal('Producto', node);
}

// Producción libre: consumir materiales y producir productos, ajustando stock.
function openProductionForm() {
  if (!currentProfile()) return;
  const materials = profileProducts().filter((p) => p.kind === 'material');
  const products = profileProducts().filter((p) => p.kind === 'product');
  const node = document.createElement('div');
  node.innerHTML = `
    <p class="muted">Declara qué materiales consumes y qué productos produces; se ajusta el stock de cada uno.</p>
    <div class="section-title" style="margin:4px">Consumir (materiales)</div>
    <div id="prd-consume"></div>
    <button type="button" class="btn btn-text" id="prd-add-consume"><span class="material-symbols-rounded">add</span>Agregar material</button>
    <div class="section-title" style="margin:4px">Producir (productos)</div>
    <div id="prd-produce"></div>
    <button type="button" class="btn btn-text" id="prd-add-produce"><span class="material-symbols-rounded">add</span>Agregar producto</button>
    <p id="prd-error" class="error hidden"></p>
    <button class="btn btn-filled btn-block" id="prd-save">Registrar producción</button>`;

  const optFor = (list) => list.map((p) => `<option value="${p.id}">${esc(p.name)} (stock ${p.stock})</option>`).join('');
  function addRow(container, list) {
    if (!list.length) return;
    const row = document.createElement('div');
    row.className = 'ord-item-row';
    row.innerHTML = `<select>${optFor(list)}</select>
      <input type="number" inputmode="numeric" min="1" step="any" value="1" />
      <button type="button" class="icon-btn"><span class="material-symbols-rounded">close</span></button>`;
    row.querySelector('.icon-btn').addEventListener('click', () => row.remove());
    container.appendChild(row);
  }
  const consumeWrap = node.querySelector('#prd-consume');
  const produceWrap = node.querySelector('#prd-produce');
  node.querySelector('#prd-add-consume').addEventListener('click', () => addRow(consumeWrap, materials));
  node.querySelector('#prd-add-produce').addEventListener('click', () => addRow(produceWrap, products));
  if (materials.length) addRow(consumeWrap, materials);
  if (products.length) addRow(produceWrap, products);

  node.querySelector('#prd-save').addEventListener('click', async () => {
    const err = node.querySelector('#prd-error');
    const gather = (wrap) => {
      const map = {};
      wrap.querySelectorAll('.ord-item-row').forEach((row) => {
        const id = row.querySelector('select').value;
        const qty = parseFloat(row.querySelector('input').value) || 0;
        if (id && qty > 0) map[id] = (map[id] || 0) + qty;
      });
      return map;
    };
    const consume = gather(consumeWrap);
    const produce = gather(produceWrap);
    if (Object.keys(produce).length === 0) {
      err.textContent = 'Agrega al menos un producto a producir.';
      err.classList.remove('hidden');
      return;
    }
    for (const [pid, qty] of Object.entries(consume)) {
      const pr = state.products.find((x) => x.id === pid);
      if (qty > (pr?.stock || 0)) {
        err.textContent = `No hay suficiente "${pr?.name}". Disponible: ${pr?.stock || 0}.`;
        err.classList.remove('hidden');
        return;
      }
    }
    // Delta neto por producto (por si aparece en ambos lados).
    const delta = {};
    for (const [pid, qty] of Object.entries(consume)) delta[pid] = (delta[pid] || 0) - qty;
    for (const [pid, qty] of Object.entries(produce)) delta[pid] = (delta[pid] || 0) + qty;
    const batch = writeBatch(db);
    for (const [pid, d] of Object.entries(delta)) {
      const pr = state.products.find((x) => x.id === pid);
      batch.update(pdoc('products', pid), { stock: (pr.stock || 0) + d, updatedAt: serverTimestamp() });
    }
    await batch.commit();
    closeModal();
  });

  openModal('Registrar producción', node);
}
$('#production-btn').addEventListener('click', openProductionForm);

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
    <label class="stacked">Fecha de entrega (opcional)<input type="date" id="ord-due" /></label>
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
    const dueDate = node.querySelector('#ord-due').value || null;
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
      const ref = await addDoc(pcol('categories'), {
        name: 'Ventas', type: 'income', profileType: 'business', color: '#059669', createdAt: serverTimestamp(),
      });
      ventasCat = { id: ref.id };
    }

    // Escritura atómica: ingreso + pedido + descuento de stock.
    const batch = writeBatch(db);
    const txRef = doc(pcol('transactions'));
    const orderRef = doc(pcol('orders'));
    batch.set(txRef, {
      profileId: state.currentProfileId, type: 'income', amount: total, categoryId: ventasCat.id,
      date: todayIso(), note: `Pedido - ${customer}`, createdAt: serverTimestamp(),
    });
    batch.set(orderRef, {
      profileId: state.currentProfileId, customerName: customer, items, shipping, total,
      status: 'pending', incomeTxId: txRef.id, note, date: todayIso(), dueDate,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    for (const [pid, qty] of Object.entries(needed)) {
      const pr = state.products.find((x) => x.id === pid);
      batch.update(pdoc('products', pid), { stock: (pr.stock || 0) - qty, updatedAt: serverTimestamp() });
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
      <div class="sub">${esc(o.date || '')}${o.dueDate ? ` · Entregar ${esc(o.dueDate)}` : ''}</div></div>
      <span class="status-chip status-${o.status}">${st.label}</span>
    </div>
    ${itemsHtml}
    ${o.shipping > 0 ? `<div class="settings-row"><span class="muted">Envío</span><strong>${money(o.shipping)}</strong></div>` : ''}
    <div class="ord-total"><span>Total</span><span>${money(o.total)}</span></div>
    ${o.note ? `<p class="muted">${esc(o.note)}</p>` : ''}
    <button class="btn btn-outlined btn-block" id="ord-receipt"><span class="material-symbols-rounded">receipt_long</span>Recibo</button>
    ${nextBtns}
    ${canCancel ? `<button class="btn btn-danger btn-block" id="ord-cancel"><span class="material-symbols-rounded">cancel</span>Cancelar pedido</button>` : ''}`;

  node.querySelector('#ord-receipt').addEventListener('click', () =>
    printReceipt({
      title: 'Pedido', id: o.id, date: o.date, customer: o.customerName, items: o.items,
      extraLabel: 'Envío', extraValue: o.shipping, total: o.total,
    }),
  );
  node.querySelectorAll('.ord-next').forEach((b) =>
    b.addEventListener('click', async () => {
      await updateDoc(pdoc('orders', o.id), { status: b.dataset.s, updatedAt: serverTimestamp() });
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
        if (pr) batch.update(pdoc('products', pid), { stock: (pr.stock || 0) + qty, updatedAt: serverTimestamp() });
      }
      if (o.incomeTxId) batch.delete(pdoc('transactions', o.incomeTxId));
      batch.update(pdoc('orders', o.id), { status: 'cancelled', updatedAt: serverTimestamp() });
      await batch.commit();
      closeModal();
    });

  openModal('Pedido', node);
}

// ---------------------------------------------------------------------------
//  Alquileres / Contratos
// ---------------------------------------------------------------------------
function renderRentals() {
  const contracts = profileContracts();
  const list = $('#rental-list');
  if (!list) return;
  list.innerHTML = '';
  $('#rental-empty').classList.toggle('hidden', contracts.length > 0);
  for (const c of contracts) {
    const st = CONTRACT_STATUS[c.status] || CONTRACT_STATUS.reserved;
    const count = (c.items || []).reduce((s, it) => s + it.qty, 0);
    const paid = c.paymentStatus === 'paid';
    const item = document.createElement('div');
    item.className = 'tx-item';
    item.innerHTML = `
      <span class="tx-icon" style="background:#8B5CF6"><span class="material-symbols-rounded">event_available</span></span>
      <div class="tx-main">
        <div class="tx-cat">${esc(c.customerName || 'Cliente')}</div>
        <div class="tx-meta">${count} unidad(es) · ${esc(c.date || '')}${isContractOverdue(c) ? ' · <span class="low-stock">atrasado</span>' : ''}</div>
      </div>
      <div style="text-align:right">
        <div class="tx-amount ${paid ? 'income' : ''}">${money(c.total)}</div>
        <span class="status-chip status-${c.status}">${st.label}</span>
        ${c.status !== 'cancelled' ? `<span class="status-chip ${paid ? 'pay-paid' : 'pay-pending'}">${paid ? 'Pagado' : 'Por cobrar'}</span>` : ''}
      </div>`;
    item.onclick = () => openContractDetails(c);
    list.appendChild(item);
  }
}

function openContractForm() {
  if (!currentProfile()) return;
  const products = profileProducts();
  const node = document.createElement('div');
  const names = [...new Set(state.contracts.map((c) => c.customerName).filter(Boolean))];
  node.innerHTML = `
    <label class="stacked">Cliente<input type="text" id="ct-customer" maxlength="60" list="ct-customers" placeholder="Nombre del cliente" /></label>
    <datalist id="ct-customers">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <div class="section-title" style="margin:4px">Artículos a alquilar</div>
    <div id="ct-items"></div>
    <button type="button" class="btn btn-text" id="ct-add-item"><span class="material-symbols-rounded">add</span>Agregar artículo</button>
    <label class="stacked">Recargo / Descuento (opcional)<input type="number" id="ct-adjust" inputmode="numeric" step="any" placeholder="0" /></label>
    <label class="stacked">Fecha de recogida (opcional)<input type="date" id="ct-pickup-date" /></label>
    <label class="stacked">Fecha de devolución (opcional)<input type="date" id="ct-due" /></label>
    <label class="stacked">Nota (opcional)<input type="text" id="ct-note" maxlength="120" /></label>
    <div class="ord-total"><span>Total</span><span id="ct-total-val">$0</span></div>
    <p id="ct-error" class="error hidden"></p>
    <button class="btn btn-filled btn-block" id="ct-save">Crear contrato (apartar)</button>`;

  const itemsWrap = node.querySelector('#ct-items');
  const optionsHtml = products
    .map((pr) => `<option value="${pr.id}">${esc(pr.name)} (disp ${productAvailable(pr)})</option>`)
    .join('');

  function recalc() {
    let total = 0;
    itemsWrap.querySelectorAll('.ord-item-row').forEach((row) => {
      const pr = state.products.find((x) => x.id === row.querySelector('select').value);
      const qty = parseFloat(row.querySelector('input').value) || 0;
      if (pr) total += qty * (pr.price || 0);
    });
    total += parseFloat(node.querySelector('#ct-adjust').value) || 0;
    node.querySelector('#ct-total-val').textContent = money(total);
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
  node.querySelector('#ct-add-item').addEventListener('click', addItemRow);
  node.querySelector('#ct-adjust').addEventListener('input', recalc);
  if (products.length) addItemRow();

  node.querySelector('#ct-save').addEventListener('click', async () => {
    const err = node.querySelector('#ct-error');
    const customer = node.querySelector('#ct-customer').value.trim() || 'Cliente';
    const adjust = parseFloat(node.querySelector('#ct-adjust').value) || 0;
    const pickupDate = node.querySelector('#ct-pickup-date').value || null;
    const dueDate = node.querySelector('#ct-due').value || null;
    const note = node.querySelector('#ct-note').value.trim();

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
      if (qty > productAvailable(pr)) {
        err.textContent = `No hay suficientes "${pr?.name}" disponibles. Disponible: ${productAvailable(pr)}.`;
        err.classList.remove('hidden');
        return;
      }
    }
    const total = items.reduce((s, it) => s + it.qty * it.price, 0) + adjust;
    // El alquiler NO descuenta stock (las unidades vuelven); se reserva disponibilidad.
    // Ingreso pendiente hasta registrar el pago.
    await addDoc(pcol('contracts'), {
      profileId: state.currentProfileId, customerName: customer, items, adjust, total,
      status: 'reserved', paymentStatus: 'pending', note, date: todayIso(), pickupDate, dueDate,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    closeModal();
  });

  openModal('Nuevo contrato', node);
}

function openContractDetails(c) {
  const st = CONTRACT_STATUS[c.status] || CONTRACT_STATUS.reserved;
  const paid = c.paymentStatus === 'paid';
  const node = document.createElement('div');
  const itemsHtml = (c.items || [])
    .map(
      (it) => `<div class="settings-row"><div><span class="name">${esc(it.name)}</span>
      <div class="sub">${it.qty} × ${money(it.price)}</div></div><strong>${money(it.qty * it.price)}</strong></div>`,
    )
    .join('');
  let lifeBtns = '';
  if (c.status === 'reserved')
    lifeBtns += `<button class="btn btn-tonal btn-block" id="ct-pickup"><span class="material-symbols-rounded">local_shipping</span>Marcar recogido</button>`;
  if (c.status === 'picked_up')
    lifeBtns += `<button class="btn btn-tonal btn-block" id="ct-return"><span class="material-symbols-rounded">assignment_return</span>Marcar devuelto</button>`;
  const payBtn =
    !paid && c.status !== 'cancelled'
      ? `<button class="btn btn-filled btn-block" id="ct-pay"><span class="material-symbols-rounded">payments</span>Registrar pago (${money(c.total)})</button>`
      : '';
  const canCancel = c.status === 'reserved' || c.status === 'picked_up';
  node.innerHTML = `
    <div class="settings-row">
      <div><span class="name">${esc(c.customerName || 'Cliente')}</span><div class="sub">${esc(c.date || '')}${c.pickupDate ? ` · Recoger ${esc(c.pickupDate)}` : ''}${c.dueDate ? ` · Devolver ${esc(c.dueDate)}` : ''}${isContractOverdue(c) ? ' <span class="low-stock">(atrasado)</span>' : ''}</div></div>
      <div style="text-align:right"><span class="status-chip status-${c.status}">${st.label}</span>
      ${c.status !== 'cancelled' ? `<br><span class="status-chip ${paid ? 'pay-paid' : 'pay-pending'}" style="margin-top:4px;display:inline-block">${paid ? 'Pagado' : 'Por cobrar'}</span>` : ''}</div>
    </div>
    ${itemsHtml}
    <div class="ord-total"><span>Total</span><span>${money(c.total)}</span></div>
    ${c.note ? `<p class="muted">${esc(c.note)}</p>` : ''}
    <button class="btn btn-outlined btn-block" id="ct-receipt"><span class="material-symbols-rounded">receipt_long</span>Recibo</button>
    ${payBtn}
    ${lifeBtns}
    ${canCancel ? `<button class="btn btn-danger btn-block" id="ct-cancel"><span class="material-symbols-rounded">cancel</span>Cancelar contrato</button>` : ''}`;

  node.querySelector('#ct-receipt').addEventListener('click', () =>
    printReceipt({
      title: 'Alquiler', id: c.id, date: c.date, customer: c.customerName, items: c.items,
      extraLabel: 'Ajuste', extraValue: c.adjust, total: c.total,
    }),
  );
  const pickup = node.querySelector('#ct-pickup');
  if (pickup)
    pickup.addEventListener('click', async () => {
      await updateDoc(pdoc('contracts', c.id), { status: 'picked_up', updatedAt: serverTimestamp() });
      closeModal();
    });
  const ret = node.querySelector('#ct-return');
  if (ret)
    ret.addEventListener('click', async () => {
      await updateDoc(pdoc('contracts', c.id), {
        status: 'returned', returnedAt: todayIso(), updatedAt: serverTimestamp(),
      });
      closeModal();
    });
  const pay = node.querySelector('#ct-pay');
  if (pay)
    pay.addEventListener('click', async () => {
      let cat =
        state.categories.find((x) => x.profileType === 'business' && x.name === 'Servicios') ||
        state.categories.find((x) => x.profileType === 'business' && x.type === 'income');
      if (!cat) {
        const ref = await addDoc(pcol('categories'), {
          name: 'Servicios', type: 'income', profileType: 'business', color: '#10B981', createdAt: serverTimestamp(),
        });
        cat = { id: ref.id };
      }
      const batch = writeBatch(db);
      const txRef = doc(pcol('transactions'));
      batch.set(txRef, {
        profileId: state.currentProfileId, type: 'income', amount: c.total, categoryId: cat.id,
        date: todayIso(), note: `Alquiler - ${c.customerName}`, createdAt: serverTimestamp(),
      });
      batch.update(pdoc('contracts', c.id), {
        paymentStatus: 'paid', incomeTxId: txRef.id, updatedAt: serverTimestamp(),
      });
      await batch.commit();
      closeModal();
    });
  const cancelBtn = node.querySelector('#ct-cancel');
  if (cancelBtn)
    cancelBtn.addEventListener('click', async () => {
      if (!confirm('¿Cancelar el contrato? Se liberan las unidades' + (paid ? ' y se revierte el pago.' : '.'))) return;
      const batch = writeBatch(db);
      if (paid && c.incomeTxId) batch.delete(pdoc('transactions', c.incomeTxId));
      batch.update(pdoc('contracts', c.id), { status: 'cancelled', updatedAt: serverTimestamp() });
      await batch.commit();
      closeModal();
    });

  openModal('Contrato', node);
}

// ---------------------------------------------------------------------------
//  Perfiles y categorías (Ajustes)
// ---------------------------------------------------------------------------
$('#add-profile-btn').addEventListener('click', () => {
  let type = 'personal';
  const node = document.createElement('div');
  let mode = 'sales';
  node.innerHTML = `
    <label class="stacked">Nombre<input type="text" id="p-name" maxlength="40" placeholder="Mi negocio" /></label>
    <div class="segmented" id="p-type">
      <button type="button" data-t="personal" class="active-neutral">Personal</button>
      <button type="button" data-t="business">Negocio</button>
    </div>
    <div id="p-mode-wrap" class="hidden">
      <div class="section-title" style="margin:8px 4px 6px">Tipo de negocio</div>
      <div class="segmented" id="p-mode">
        <button type="button" data-m="sales" class="active-neutral">Ventas</button>
        <button type="button" data-m="rental">Alquiler</button>
      </div>
    </div>
    <p id="p-error" class="error hidden"></p>
    <button class="btn btn-filled btn-block" id="p-save">Crear perfil</button>`;

  const typeBtns = node.querySelectorAll('#p-type button');
  typeBtns.forEach((b) =>
    b.addEventListener('click', () => {
      type = b.dataset.t;
      typeBtns.forEach((x) => x.classList.remove('active-neutral'));
      b.classList.add('active-neutral');
      node.querySelector('#p-mode-wrap').classList.toggle('hidden', type !== 'business');
    }),
  );
  const modeBtns = node.querySelectorAll('#p-mode button');
  modeBtns.forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.m;
      modeBtns.forEach((x) => x.classList.remove('active-neutral'));
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
    const pid = await createProfile({ name, type, mode });
    closeModal();
    setCurrentProfile(pid);
  });
  openModal('Nuevo perfil', node);
});

async function deleteProfile(p) {
  const amOwner = !p.ownerUid || p.ownerUid === state.uid;
  const shared = (p.members?.length || 1) > 1;

  // Si no soy el dueño, "salgo" del negocio (no borro los datos de los demás).
  if (!amOwner) {
    if (!confirm(`¿Salir de "${p.name}"? Dejarás de verlo, pero sigue existiendo para los demás.`)) return;
    await updateDoc(doc(profilesCol(), p.id), {
      members: arrayRemove(state.uid),
      memberEmails: arrayRemove(state.email),
    });
    if (state.currentProfileId === p.id) state.currentProfileId = null;
    return;
  }

  const msg = shared
    ? `"${p.name}" está compartido. Si lo eliminas, se borra para TODOS los miembros. ¿Continuar?`
    : `¿Eliminar "${p.name}" y todos sus datos?`;
  if (!confirm(msg)) return;

  const batch = writeBatch(db);
  // Solo podemos limpiar las subcolecciones si es el perfil cargado ahora.
  if (p.id === state.currentProfileId) {
    for (const t of state.transactions) batch.delete(pdoc('transactions', t.id));
    for (const x of state.products) batch.delete(pdoc('products', x.id));
    for (const x of state.orders) batch.delete(pdoc('orders', x.id));
    for (const x of state.contracts) batch.delete(pdoc('contracts', x.id));
    for (const x of state.categories) batch.delete(pdoc('categories', x.id));
  }
  batch.delete(doc(profilesCol(), p.id));
  await batch.commit();
  if (state.currentProfileId === p.id) state.currentProfileId = null;
}

// --- Compartir negocio: invitaciones y miembros ---
function renderInvites() {
  const wrap = $('#invites-section');
  if (!wrap) return;
  // No mostrar invitaciones de perfiles a los que ya pertenezco.
  const pending = state.invites.filter((i) => !state.profiles.find((p) => p.id === i.profileId));
  if (pending.length === 0) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML =
    `<h2 class="section-title">Invitaciones</h2>` +
    pending
      .map(
        (i) => `<div class="settings-row">
          <div><span class="name">${esc(i.profileName || 'Negocio')}</span>
          <div class="sub">Te invitó ${esc(i.invitedBy || '')}</div></div>
          <button class="btn btn-filled accept-invite" data-pid="${i.profileId}" style="min-height:36px;padding:0 16px">Unirme</button>
        </div>`,
      )
      .join('');
  wrap.querySelectorAll('.accept-invite').forEach((b) =>
    b.addEventListener('click', () => acceptInvite(b.dataset.pid)),
  );
}

async function acceptInvite(pid) {
  await updateDoc(doc(profilesCol(), pid), {
    members: arrayUnion(state.uid),
    memberEmails: arrayUnion(state.email),
  });
  await deleteDoc(doc(db, 'profiles', pid, 'invites', state.email));
  setCurrentProfile(pid);
}

function renderShareSection() {
  const wrap = $('#share-section');
  if (!wrap) return;
  const p = currentProfile();
  if (!p || p.type !== 'business') {
    wrap.innerHTML = '';
    return;
  }
  const emails = p.memberEmails || [];
  wrap.innerHTML = `
    <h2 class="section-title">Compartir "${esc(p.name)}"</h2>
    <div class="settings-list">
      ${emails
        .map(
          (e) =>
            `<div class="settings-row"><span class="name">${esc(e)}</span>${e === state.email ? '<span class="chip">tú</span>' : ''}</div>`,
        )
        .join('')}
    </div>
    <button class="btn btn-tonal btn-block" id="invite-btn"><span class="material-symbols-rounded">person_add</span>Invitar por correo</button>`;
  wrap.querySelector('#invite-btn').addEventListener('click', openInviteForm);
}

function openInviteForm() {
  const p = currentProfile();
  if (!p) return;
  const node = document.createElement('div');
  node.innerHTML = `
    <p class="muted">Escribe el correo de la persona. Debe entrar (o registrarse) con ese mismo correo y aceptar la invitación en sus Ajustes.</p>
    <label class="stacked">Correo<input type="email" id="inv-email" placeholder="persona@correo.com" /></label>
    <p id="inv-error" class="error hidden"></p>
    <button class="btn btn-filled btn-block" id="inv-send">Enviar invitación</button>`;
  node.querySelector('#inv-send').addEventListener('click', async () => {
    const email = node.querySelector('#inv-email').value.trim().toLowerCase();
    const err = node.querySelector('#inv-error');
    err.classList.remove('ok');
    if (!email || !email.includes('@')) {
      err.textContent = 'Escribe un correo válido.';
      err.classList.remove('hidden');
      return;
    }
    if ((p.memberEmails || []).includes(email)) {
      err.textContent = 'Esa persona ya es miembro.';
      err.classList.remove('hidden');
      return;
    }
    await setDoc(doc(db, 'profiles', p.id, 'invites', email), {
      email, profileName: p.name, invitedBy: state.email, createdAt: serverTimestamp(),
    });
    err.textContent = 'Invitación enviada. La persona la verá al entrar con ese correo.';
    err.classList.add('ok');
    err.classList.remove('hidden');
  });
  openModal('Invitar a ' + p.name, node);
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
    await addDoc(pcol('categories'), { name, type, profileType: p.type, color, createdAt: serverTimestamp() });
    closeModal();
  });
  openModal('Nueva categoría', node);
});

// Arranque: si Firebase no está configurado, avisa claramente.
if (firebaseConfig.apiKey === 'PEGA_AQUI_TU_API_KEY') {
  $('#splash').innerHTML =
    '<div style="padding:24px;text-align:center;color:#6b7280">Falta configurar Firebase.<br>Edita <code>js/config.js</code> con las claves de tu proyecto.</div>';
}

// Registrar el service worker (PWA: instalable + abre offline).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
