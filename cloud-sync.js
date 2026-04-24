// ══════════════════════════════════════════════════════
// CHAWKPRO CLOUD SYNC v1.0
// Load this AFTER firebase-config.js and Firebase CDN
// ══════════════════════════════════════════════════════

let _db, _auth, _cloudShopId, _cloudRole, _cloudEmail, _cloudName;
let _stockListener = null, _salesListener = null;
let _syncQ = JSON.parse(localStorage.getItem('chawkpro_syncQ') || '[]');

// ── INIT ──────────────────────────────────────────────
function initFirebase() {
  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    _db = firebase.firestore();
    _auth = firebase.auth();
    _db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
    window.addEventListener('online', () => { updateSyncDot('online'); processSyncQ(); });
    window.addEventListener('offline', () => updateSyncDot('offline'));
    updateSyncDot(navigator.onLine ? 'online' : 'offline');
    return true;
  } catch (e) { alert("DEBUG: " + e.message + " | CODE: " + e.code);
    console.warn('Firebase init failed:', e);
    return false;
  }
}

// ── SYNC STATUS ───────────────────────────────────────
function updateSyncDot(status) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const s = {
    online:  { t: '● Online',  c: '#00d97e' },
    offline: { t: '○ Offline', c: '#ff4757' },
    syncing: { t: '↻ Syncing', c: '#f5c518' }
  };
  el.textContent = s[status].t;
  el.style.color = s[status].c;
}

// ── TRIAL CHECK ───────────────────────────────────────
const TRIAL_DAYS = 30;

function checkTrial(shopData) {
  if (!shopData) return { active: false };
  const created = shopData.createdAt?.toDate ? shopData.createdAt.toDate() : new Date(shopData.createdAt);
  const days = Math.floor((new Date() - created) / 86400000);
  if (days <= TRIAL_DAYS) return { active: true, trial: true, daysLeft: TRIAL_DAYS - days };
  if (shopData.subscriptionActive) {
    const end = shopData.subscriptionEnd?.toDate ? shopData.subscriptionEnd.toDate() : new Date(shopData.subscriptionEnd);
    if (end > new Date()) return { active: true, trial: false };
  }
  return { active: false, daysLeft: 0 };
}

function showTrialBanner(days) {
  const b = document.getElementById('trialBanner');
  if (b) { b.textContent = `🔔 Free trial: ${days} day${days !== 1 ? 's' : ''} left`; b.style.display = 'block'; }
}

function showSubWall(msg) {
  document.getElementById('subDaysLeft').textContent = msg;
  document.getElementById('subWallOverlay').classList.add('open');
}

// ── PIN HASH ──────────────────────────────────────────
function hashPin(pin) {
  let h = 0, s = pin + 'CHAWKPRO2026';
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h = h & h; }
  return Math.abs(h).toString(16);
}

// ── FIREBASE ERROR MESSAGES ───────────────────────────
function fbErr(code) {
  const m = {
    'auth/email-already-in-use': 'Email already registered',
    'auth/invalid-email': 'Invalid email address',
    'auth/weak-password': 'Password too weak (min 6 chars)',
    'auth/user-not-found': 'No account found',
    'auth/wrong-password': 'Wrong password',
    'auth/invalid-credential': 'Wrong email or password',
    'auth/too-many-requests': 'Too many attempts. Try later.',
    'auth/network-request-failed': 'No internet connection'
  };
  return m[code] || (code ? "Error: " + code : "Something went wrong. Try again.");
}

// ── LOADER ────────────────────────────────────────────
function showCloudLoader(msg) {
  document.getElementById('cloudLoaderMsg').textContent = msg || 'Loading...';
  document.getElementById('cloudLoaderOverlay').classList.add('show');
}
function hideCloudLoader() {
  document.getElementById('cloudLoaderOverlay').classList.remove('show');
}

// ── SESSION ───────────────────────────────────────────
function saveCloudSession(shopId, role, email, name) {
  localStorage.setItem('chawkpro_cloud_session', JSON.stringify({ shopId, role, email, name }));
}

function loadCloudSession() {
  try { return JSON.parse(localStorage.getItem('chawkpro_cloud_session')); }
  catch (e) { return null; }
}

function clearCloudSession() {
  localStorage.removeItem('chawkpro_cloud_session');
}

// ── AUTH: SWITCH PANEL ────────────────────────────────
function switchAuthMode(mode) {
  document.querySelectorAll('.mode-btn').forEach((b, i) =>
    b.classList.toggle('active', mode === 'login' ? i === 0 : i === 1));
  document.getElementById('authLoginPanel').classList.toggle('active', mode === 'login');
  document.getElementById('authRegisterPanel').classList.toggle('active', mode === 'register');
}

// ── AUTH: REGISTER ────────────────────────────────────
async function handleRegister() {
  const shopName = document.getElementById('regShopName').value.trim();
  const email    = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const pin      = document.getElementById('regPin').value.trim();
  const errEl    = document.getElementById('registerError');
  errEl.classList.remove('show');

  if (!shopName || !email || !password || !pin) {
    errEl.textContent = 'All fields are required'; errEl.classList.add('show'); return;
  }
  if (pin.length < 4) {
    errEl.textContent = 'PIN must be 4–6 digits'; errEl.classList.add('show'); return;
  }

  showCloudLoader('Creating your shop...');
  try {
    const cred = await _auth.createUserWithEmailAndPassword(email, password);
    const uid = cred.user.uid;

    await _db.collection('shops').doc(uid).set({
      shopName, ownerEmail: email, ownerPin: hashPin(pin),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      subscriptionActive: false, plan: 'trial'
    });

    await _db.collection('shops').doc(uid).collection('staff').doc(uid).set({
      name: 'Owner', email, role: 'owner', pin: hashPin(pin),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    _cloudShopId = uid; _cloudRole = 'owner';
    _cloudEmail = email; _cloudName = shopName;
    saveCloudSession(uid, 'owner', email, shopName);
    hideCloudLoader();
    showToast('Shop created! Welcome 🎉', 'success');
    enterCloudApp('owner', shopName);
  } catch (e) { alert("DEBUG: " + e.message + " | CODE: " + e.code);
    hideCloudLoader();
    errEl.textContent = fbErr(e.code) + " [" + (e.code||"unknown") + "]"; errEl.classList.add("show"); alert("DEBUG: " + e.code + " | " + e.message);
  }
}

// ── AUTH: LOGIN ───────────────────────────────────────
async function handleCloudLogin() {
  const email    = document.getElementById('cloudEmail').value.trim();
  const password = document.getElementById('cloudPassword').value;
  const pin      = document.getElementById('cloudPin').value.trim();
  const errEl    = document.getElementById('cloudLoginError');
  errEl.classList.remove('show');

  if (!email || !password || !pin) {
    errEl.textContent = 'All fields required'; errEl.classList.add('show'); return;
  }

  showCloudLoader('Signing in...');
  try {
    const cred = await _auth.signInWithEmailAndPassword(email, password);
    const uid = cred.user.uid;

    // Check if owner
    const shopDoc = await _db.collection('shops').doc(uid).get();
    if (shopDoc.exists) {
      const shop = shopDoc.data();
      if (hashPin(pin) !== shop.ownerPin) {
        await _auth.signOut(); hideCloudLoader();
        errEl.textContent = 'Wrong PIN'; errEl.classList.add('show'); return;
      }
      const trial = checkTrial(shop);
      if (!trial.active) {
        await _auth.signOut(); hideCloudLoader();
        showSubWall('Your free trial has ended. Subscribe to continue.');
        return;
      }
      _cloudShopId = uid; _cloudRole = 'owner';
      _cloudEmail = email; _cloudName = shop.shopName;
      saveCloudSession(uid, 'owner', email, shop.shopName);
      if (trial.trial) showTrialBanner(trial.daysLeft);
      hideCloudLoader();
      enterCloudApp('owner', shop.shopName);
      return;
    }

    // Check if staff
    const linkDoc = await _db.collection('staffLinks').doc(email.replace(/\./g, '_')).get();
    if (linkDoc.exists) {
      const link = linkDoc.data();
      const staffSnap = await _db.collection('shops').doc(link.shopId)
        .collection('staff').where('email', '==', email).get();
      if (!staffSnap.empty) {
        const staff = staffSnap.docs[0].data();
        if (hashPin(pin) !== staff.pin) {
          await _auth.signOut(); hideCloudLoader();
          errEl.textContent = 'Wrong PIN'; errEl.classList.add('show'); return;
        }
        const ownerShop = await _db.collection('shops').doc(link.shopId).get();
        const trial = checkTrial(ownerShop.data());
        if (!trial.active) {
          await _auth.signOut(); hideCloudLoader();
          errEl.textContent = 'Shop subscription expired. Contact owner.';
          errEl.classList.add('show'); return;
        }
        _cloudShopId = link.shopId; _cloudRole = 'staff';
        _cloudEmail = email; _cloudName = staff.name;
        saveCloudSession(link.shopId, 'staff', email, staff.name);
        hideCloudLoader();
        enterCloudApp('staff', staff.name);
        return;
      }
    }

    await _auth.signOut(); hideCloudLoader();
    errEl.textContent = 'No shop account found for this email';
    errEl.classList.add('show');
  } catch (e) { alert("DEBUG: " + e.message + " | CODE: " + e.code);
    hideCloudLoader();
    errEl.textContent = fbErr(e.code) + " [" + (e.code||"unknown") + "]"; errEl.classList.add("show"); alert("DEBUG: " + e.code + " | " + e.message);
  }
}

// ── AUTH: FORGOT PASSWORD ─────────────────────────────
async function handleForgotPassword() {
  const email = document.getElementById('cloudEmail').value.trim();
  if (!email) { showToast('Enter your email first', 'error'); return; }
  try {
    await _auth.sendPasswordResetEmail(email);
    showToast('Reset email sent! Check inbox', 'success');
  } catch (e) { alert("DEBUG: " + e.message + " | CODE: " + e.code); showToast('Email not found', 'error'); }
}

// ── ENTER APP ─────────────────────────────────────────
function enterCloudApp(role, name) {
  showScreen('app');
  document.getElementById('topBarName').textContent = name || role;
  const rb = document.getElementById('topBarRole');
  rb.textContent = role.toUpperCase();
  rb.className = 'role-badge role-' + role;

  // Hide settings nav for staff
  const settingsNav = document.getElementById('settingsNav');
  if (settingsNav) settingsNav.style.display = role === 'owner' ? '' : 'none';

  loadCloudDataIntoApp();
  startCloudListeners();
}

// ── LOAD DATA ─────────────────────────────────────────
async function loadCloudDataIntoApp() {
  try {
    const [stockSnap, salesSnap, debtsSnap, shopDoc] = await Promise.all([
      _db.collection('shops').doc(_cloudShopId).collection('stock').get(),
      _db.collection('shops').doc(_cloudShopId).collection('sales')
        .orderBy('createdAt', 'desc').limit(300).get(),
      _db.collection('shops').doc(_cloudShopId).collection('debts').get(),
      _db.collection('shops').doc(_cloudShopId).get()
    ]);

    DB.stock = stockSnap.docs.map(d => ({ ...d.data(), id: d.id }));
    DB.sales = salesSnap.docs.map(d => {
      const s = d.data();
      return { ...s, id: d.id, date: s.date || new Date().toISOString().split('T')[0] };
    });
    DB.debts = debtsSnap.docs.map(d => ({ ...d.data(), id: d.id }));
    if (shopDoc.exists) DB.shop = { name: shopDoc.data().shopName };

    save(); // persist to localStorage for offline
    renderAll();
  } catch (e) { alert("DEBUG: " + e.message + " | CODE: " + e.code);
    console.warn('loadCloudData offline, using cache:', e);
    renderAll();
  }
}

// ── REAL-TIME LISTENERS ───────────────────────────────
function startCloudListeners() {
  if (_stockListener) _stockListener();
  if (_salesListener) _salesListener();

  _stockListener = _db.collection('shops').doc(_cloudShopId).collection('stock')
    .onSnapshot(snap => {
      DB.stock = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      save();
      renderStock();
      renderDashboard();
    });

  const today = new Date(); today.setHours(0, 0, 0, 0);
  _salesListener = _db.collection('shops').doc(_cloudShopId).collection('sales')
    .where('createdAt', '>=', today)
    .onSnapshot(snap => {
      const todaySales = snap.docs.map(d => ({
        ...d.data(), id: d.id, date: new Date().toISOString().split('T')[0]
      }));
      const otherSales = DB.sales.filter(s => s.date !== new Date().toISOString().split('T')[0]);
      DB.sales = [...todaySales, ...otherSales];
      save();
      renderDashboard();
      renderSales();
    });
}

// ── CLOUD WRITE HELPERS ───────────────────────────────
async function cloudSaveItem(item) {
  if (!_cloudShopId) return;
  try {
    await _db.collection('shops').doc(_cloudShopId).collection('stock').doc(item.id).set({
      ...item, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { alert("DEBUG: " + e.message + " | CODE: " + e.code); queueOp({ type: 'addItem', data: item }); }
}

async function cloudDeleteItem(id) {
  if (!_cloudShopId) return;
  try {
    await _db.collection('shops').doc(_cloudShopId).collection('stock').doc(id).delete();
  } catch (e) { alert("DEBUG: " + e.message + " | CODE: " + e.code); queueOp({ type: 'deleteItem', id }); }
}

async function cloudSaveSale(sale) {
  if (!_cloudShopId) return;
  try {
    await _db.collection('shops').doc(_cloudShopId).collection('sales').doc(sale.id).set({
      ...sale, staffEmail: _cloudEmail, staffRole: _cloudRole,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    if (sale.productId) {
      await _db.collection('shops').doc(_cloudShopId).collection('stock').doc(sale.productId)
        .update({ qty: firebase.firestore.FieldValue.increment(-(sale.qty || 1)),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    }
  } catch (e) { alert("DEBUG: " + e.message + " | CODE: " + e.code); queueOp({ type: 'addSale', data: sale }); }
}

async function cloudSaveDebt(debt) {
  if (!_cloudShopId) return;
  try {
    await _db.collection('shops').doc(_cloudShopId).collection('debts').doc(debt.id).set({
      ...debt, createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { alert("DEBUG: " + e.message + " | CODE: " + e.code); queueOp({ type: 'addDebt', data: debt }); }
}

// ── ADD STAFF ─────────────────────────────────────────
async function addCloudStaff(name, email, password, pin) {
  if (_cloudRole !== 'owner') { showToast('Only owner can add staff', 'error'); return; }
  showCloudLoader('Adding staff member...');
  try {
    const secondApp = firebase.initializeApp(FIREBASE_CONFIG, 'staff_' + Date.now());
    const secondAuth = secondApp.auth();
    const cred = await secondAuth.createUserWithEmailAndPassword(email, password);
    const staffUid = cred.user.uid;
    await secondAuth.signOut();
    await secondApp.delete();

    await _db.collection('shops').doc(_cloudShopId).collection('staff').doc(staffUid).set({
      name, email, role: 'staff', pin: hashPin(pin),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await _db.collection('staffLinks').doc(email.replace(/\./g, '_')).set({
      shopId: _cloudShopId, staffUid, name
    });

    hideCloudLoader();
    showToast(name + ' added as staff ✓', 'success');

    // Add to local DB users list
    if (!DB.users) DB.users = [];
    DB.users.push({ id: staffUid, name, role: 'staff', pin: hashPin(pin) });
    save(); renderUsers();
  } catch (e) { alert("DEBUG: " + e.message + " | CODE: " + e.code);
    hideCloudLoader(); showToast(fbErr(e.code), 'error');
  }
}

// ── OFFLINE SYNC QUEUE ────────────────────────────────
function queueOp(op) {
  _syncQ.push(op);
  localStorage.setItem('chawkpro_syncQ', JSON.stringify(_syncQ));
}

async function processSyncQ() {
  if (!navigator.onLine || !_syncQ.length || !_cloudShopId) return;
  updateSyncDot('syncing');
  const q = [..._syncQ]; _syncQ = [];
  localStorage.setItem('chawkpro_syncQ', '[]');
  for (const op of q) {
    try {
      if (op.type === 'addSale')    await cloudSaveSale(op.data);
      else if (op.type === 'addItem')    await cloudSaveItem(op.data);
      else if (op.type === 'deleteItem') await cloudDeleteItem(op.id);
      else if (op.type === 'addDebt')    await cloudSaveDebt(op.data);
    } catch (e) { alert("DEBUG: " + e.message + " | CODE: " + e.code); _syncQ.push(op); }
  }
  localStorage.setItem('chawkpro_syncQ', JSON.stringify(_syncQ));
  updateSyncDot('online');
  if (_syncQ.length === 0) showToast('All data synced ✓', 'success');
}

// ── LOGOUT ────────────────────────────────────────────
async function cloudLogout() {
  if (_auth) await _auth.signOut();
  if (_stockListener) _stockListener();
  if (_salesListener) _salesListener();
  clearCloudSession();
  _cloudShopId = null; _cloudRole = null;
  _cloudEmail = null; _cloudName = null;
  showScreen('cloudAuth');
}
