// ItzB local backend: authentication, user profiles and (demo) plan/boost purchases.
// Run with `npm start` from the project folder, then open http://localhost:3000
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSION_COOKIE = 'itzb_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const ROLES = ['need', 'help', 'both'];
const CATEGORIES = ['Computer', 'Phone', 'Repair', 'Study', 'Home', 'Other'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIME_SLOTS = ['Morning', 'Afternoon', 'Evening', 'Anytime'];
const URGENCY = ['Today', 'This week', 'Flexible'];
const CONTACT = ['Chat', 'Call', 'Either'];
const RADII = ['0.5 km', '1 km', '1.5 km', '3 km', '5 km'];

// Paid plans and boosts. Prices are in rupees and must match what index.html shows.
// Payments are NOT live: purchases are recorded with status 'demo' and nothing is charged.
const PLAN_PRICES = { need: { Plus: 99, Premium: 249 }, help: { Pro: 199, Business: 499 } };
const BOOST_PRICES = { 1: 49, 3: 129, 7: 249 };
const PAY_METHODS = ['UPI', 'Card', 'Net banking'];
const CYCLES = ['monthly', 'yearly'];
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- storage ----------
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}
function saveUsers(users) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}
let users = loadUsers();

// Sessions live in memory: restarting the server logs everyone out.
const sessions = new Map(); // token -> { userId, expires }

// ---------- password hashing (scrypt, built into Node) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ---------- validation helpers ----------
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const oneOf = (v, list, fallback = '') => (list.includes(v) ? v : fallback);
const someOf = (v, list) => (Array.isArray(v) ? [...new Set(v.filter(x => list.includes(x)))] : []);
const normalizeLogin = id => str(id, 120).toLowerCase();
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isPhone = s => /^\+?[0-9 ()-]{7,20}$/.test(s);

function cleanProfile(body, role) {
  const p = body || {};
  const personal = p.personal || {};
  const profile = {
    personal: {
      name: str(personal.name, 80),
      phone: str(personal.phone, 20),
      area: str(personal.area, 120),
    },
  };
  if (role === 'need' || role === 'both') {
    const n = p.needs || {};
    profile.needs = {
      categories: someOf(n.categories, CATEGORIES),
      description: str(n.description, 1000),
      urgency: oneOf(n.urgency, URGENCY, 'Flexible'),
      preferredTime: oneOf(n.preferredTime, TIME_SLOTS, 'Anytime'),
      radius: oneOf(n.radius, RADII, '1.5 km'),
      contact: oneOf(n.contact, CONTACT, 'Chat'),
    };
  }
  if (role === 'help' || role === 'both') {
    const h = p.helper || {};
    const years = Number(h.experienceYears);
    const rate = Number(h.hourlyRate);
    profile.helper = {
      skills: someOf(h.skills, CATEGORIES),
      otherSkills: str(h.otherSkills, 200),
      experienceYears: Number.isFinite(years) && years >= 0 && years <= 60 ? Math.floor(years) : 0,
      about: str(h.about, 1000),
      days: someOf(h.days, DAYS),
      timeSlot: oneOf(h.timeSlot, TIME_SLOTS, 'Anytime'),
      radius: oneOf(h.radius, RADII, '1.5 km'),
      hourlyRate: Number.isFinite(rate) && rate >= 0 && rate <= 100000 ? rate : null,
    };
  }
  return profile;
}

function profileErrors(profile, role) {
  const errs = [];
  if (!profile.personal.name) errs.push('Your name is required.');
  if (!profile.personal.phone || !isPhone(profile.personal.phone)) errs.push('A valid phone number is required.');
  if (!profile.personal.area) errs.push('Your area / locality is required.');
  if (profile.needs) {
    if (!profile.needs.categories.length) errs.push('Pick at least one kind of help you need.');
    if (!profile.needs.description) errs.push('Describe what you usually need help with.');
  }
  if (profile.helper) {
    if (!profile.helper.skills.length) errs.push('Pick at least one skill you can help with.');
    if (!profile.helper.days.length) errs.push('Pick the days you are available.');
  }
  return errs;
}

// ---------- billing ----------
const planGroupFor = role => (role === 'need' ? 'need' : 'help');
const canBoost = role => role === 'help' || role === 'both';
function billingOf(u) {
  if (!u.billing) u.billing = { plans: {}, boost: null, payments: [] };
  return u.billing;
}
// The plan/boost that is in effect right now (expired ones are ignored).
function currentBilling(u) {
  const b = u.billing || {};
  const plan = (b.plans || {})[planGroupFor(u.role)];
  const boost = b.boost;
  return {
    plan: plan && new Date(plan.renews) > new Date() ? plan : null,
    boost: canBoost(u.role) && boost && new Date(boost.ends) > new Date() ? boost : null,
  };
}
function recordPayment(u, item, amount, method) {
  const payment = {
    ref: 'ITZB-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    item, amount, method, date: new Date().toISOString(), status: 'demo',
  };
  billingOf(u).payments.push(payment);
  return payment;
}

function publicUser(u) {
  return {
    id: u.id,
    login: u.login,
    role: u.role,
    profile: u.profile || null,
    profileComplete: !!u.profile && profileErrors(u.profile, u.role).length === 0,
    billing: currentBilling(u),
    createdAt: u.createdAt,
  };
}

// ---------- sessions ----------
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expires: Date.now() + SESSION_TTL_MS });
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
}
function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const s = token && sessions.get(token);
  if (!s || s.expires < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: 'Not logged in.' });
  }
  const user = users.find(u => u.id === s.userId);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  req.user = user;
  req.sessionToken = token;
  next();
}

// Simple brute-force protection: max 10 failed logins per login id per 15 minutes.
const failed = new Map();
function tooManyAttempts(login) {
  const f = failed.get(login);
  return f && f.count >= 10 && Date.now() - f.first < 15 * 60 * 1000;
}
function recordFailure(login) {
  const f = failed.get(login);
  if (!f || Date.now() - f.first > 15 * 60 * 1000) failed.set(login, { count: 1, first: Date.now() });
  else f.count++;
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '50kb' }));

app.post('/api/signup', (req, res) => {
  const login = normalizeLogin(req.body.login);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const role = oneOf(req.body.role, ROLES);
  if (!isEmail(login) && !isPhone(login)) return res.status(400).json({ error: 'Enter a valid email or phone number.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!role) return res.status(400).json({ error: 'Choose how you want to use ItzB.' });
  if (users.some(u => u.login === login)) return res.status(409).json({ error: 'An account with this email/phone already exists. Log in instead.' });

  const user = { id: crypto.randomUUID(), login, passwordHash: hashPassword(password), role, profile: null, createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers(users);
  startSession(res, user.id);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const login = normalizeLogin(req.body.login);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!login || !password) return res.status(400).json({ error: 'Enter your email/phone and password.' });
  if (tooManyAttempts(login)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  const user = users.find(u => u.login === login);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    recordFailure(login);
    return res.status(401).json({ error: 'Wrong email/phone or password.' });
  }
  failed.delete(login);
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// Real registered customers, for helpers to browse. Only helpers ('help'/'both') may see them,
// and only customers with a completed profile are listed. Contact details (phone, login) are
// never exposed here.
function customerCard(u) {
  const per = u.profile.personal, n = u.profile.needs;
  return {
    id: u.id,
    name: per.name,
    area: per.area,
    categories: n.categories,
    description: n.description,
    urgency: n.urgency,
    preferredTime: n.preferredTime,
    radius: n.radius,
    contact: n.contact,
    memberSince: u.createdAt,
  };
}
app.get('/api/customers', requireAuth, (req, res) => {
  if (!canBoost(req.user.role)) return res.status(403).json({ error: 'Customer profiles are only available to helpers.' });
  const customers = users
    .filter(u => u.id !== req.user.id && (u.role === 'need' || u.role === 'both')
      && u.profile && u.profile.needs && profileErrors(u.profile, u.role).length === 0)
    .map(customerCard)
    .sort((a, b) => String(b.memberSince).localeCompare(String(a.memberSince)));
  res.json({ customers });
});

// ---------- customer → helper service requests ----------
// Stored in server/data/requests.json as
// { id, customerId, helperId, service, message, status: 'pending'|'accepted'|'declined', createdAt, updatedAt, respondedAt }.
// Contact details (phone + preferred contact) are only shared with the other side once a request is accepted.
const REQUESTS_FILE = path.join(DATA_DIR, 'requests.json');
const REQUEST_STATUSES = ['pending', 'accepted', 'declined'];
const MAX_PENDING_PER_CUSTOMER = 20;
function loadRequests() {
  try { return JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8')); }
  catch { return []; }
}
function saveRequests(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = REQUESTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, REQUESTS_FILE);
}
let requests = loadRequests();

const isCustomer = u => u.role === 'need' || u.role === 'both';
const isHelper = u => u.role === 'help' || u.role === 'both';
const userById = id => users.find(u => u.id === id);
const listedHelper = u => isHelper(u) && u.profile && u.profile.helper && profileErrors(u.profile, u.role).length === 0;
function helperCard(u) {
  const per = u.profile.personal, h = u.profile.helper;
  return {
    id: u.id,
    name: per.name,
    area: per.area,
    skills: h.skills,
    otherSkills: h.otherSkills,
    experienceYears: h.experienceYears,
    about: h.about,
    days: h.days,
    timeSlot: h.timeSlot,
    radius: h.radius,
    hourlyRate: h.hourlyRate,
    memberSince: u.createdAt,
  };
}
// Best-effort profile of the other side of a request (the account may have been edited since).
function sideCard(u, kind) {
  if (!u || !u.profile) return { id: u ? u.id : null, name: 'ItzB user', area: '', unavailable: true };
  if (kind === 'customer' && u.profile.needs) return customerCard(u);
  if (kind === 'helper' && u.profile.helper) return helperCard(u);
  return { id: u.id, name: u.profile.personal.name, area: u.profile.personal.area, memberSince: u.createdAt };
}
function contactOf(u, kind) {
  if (!u || !u.profile) return null;
  const pref = kind === 'customer' ? (u.profile.needs || {}).contact : null;
  return { phone: u.profile.personal.phone, preferred: pref || 'Either' };
}
function requestView(r, viewer) {
  const forHelper = viewer === 'helper';
  const other = userById(forHelper ? r.customerId : r.helperId);
  const view = {
    id: r.id, service: r.service, message: r.message, status: r.status,
    createdAt: r.createdAt, updatedAt: r.updatedAt, respondedAt: r.respondedAt || null,
  };
  if (forHelper) view.customer = sideCard(other, 'customer');
  else view.helper = sideCard(other, 'helper');
  if (r.status === 'accepted') view.contact = contactOf(other, forHelper ? 'customer' : 'helper');
  return view;
}
const newestFirst = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));

// Real registered helpers, for customers to send requests to.
app.get('/api/helpers', requireAuth, (req, res) => {
  if (!isCustomer(req.user)) return res.status(403).json({ error: 'Only customers can browse helpers to send requests.' });
  const mine = requests.filter(r => r.customerId === req.user.id);
  const helpers = users
    .filter(u => u.id !== req.user.id && listedHelper(u))
    .map(u => {
      const last = mine.filter(r => r.helperId === u.id).sort(newestFirst)[0];
      return { ...helperCard(u), requestStatus: last ? last.status : null };
    })
    .sort((a, b) => String(b.memberSince).localeCompare(String(a.memberSince)));
  res.json({ helpers });
});

// Customer sends a service request to a helper. Stored as 'pending'.
app.post('/api/requests', requireAuth, (req, res) => {
  const me = req.user;
  if (!isCustomer(me)) return res.status(403).json({ error: 'Only customers can send requests.' });
  if (!me.profile || !me.profile.needs || profileErrors(me.profile, me.role).length) {
    return res.status(400).json({ error: 'Complete your profile before sending requests.' });
  }
  const b = req.body || {};
  const helperId = str(b.helperId, 64);
  const helper = userById(helperId);
  if (!helper || helper.id === me.id || !listedHelper(helper)) return res.status(404).json({ error: 'Helper not found.' });
  const service = oneOf(b.service, CATEGORIES);
  if (!service) return res.status(400).json({ error: 'Choose the service you need.' });
  const message = str(b.message, 500);
  if (!message) return res.status(400).json({ error: 'Describe what you need help with.' });
  if (requests.some(r => r.customerId === me.id && r.helperId === helper.id && r.status === 'pending')) {
    return res.status(409).json({ error: 'You already have a pending request with this helper.' });
  }
  if (requests.filter(r => r.customerId === me.id && r.status === 'pending').length >= MAX_PENDING_PER_CUSTOMER) {
    return res.status(429).json({ error: `You can have at most ${MAX_PENDING_PER_CUSTOMER} pending requests.` });
  }
  const now = new Date().toISOString();
  const r = { id: crypto.randomUUID(), customerId: me.id, helperId: helper.id, service, message, status: 'pending', createdAt: now, updatedAt: now, respondedAt: null };
  requests.push(r);
  saveRequests(requests);
  res.status(201).json({ request: requestView(r, 'customer') });
});

// Requests the logged-in customer has sent.
app.get('/api/requests/sent', requireAuth, (req, res) => {
  if (!isCustomer(req.user)) return res.status(403).json({ error: 'Only customers have sent requests.' });
  const list = requests.filter(r => r.customerId === req.user.id).sort(newestFirst).map(r => requestView(r, 'customer'));
  res.json({ requests: list });
});

// Requests sent to the logged-in helper (only ever their own).
app.get('/api/requests/received', requireAuth, (req, res) => {
  if (!isHelper(req.user)) return res.status(403).json({ error: 'Only helpers receive requests.' });
  const list = requests.filter(r => r.helperId === req.user.id).sort(newestFirst).map(r => requestView(r, 'helper'));
  const counts = Object.fromEntries(REQUEST_STATUSES.map(s => [s, list.filter(r => r.status === s).length]));
  res.json({ requests: list, counts });
});

// Helper accepts or declines a pending request addressed to them.
function respondToRequest(status) {
  return (req, res) => {
    if (!isHelper(req.user)) return res.status(403).json({ error: 'Only helpers can respond to requests.' });
    const r = requests.find(x => x.id === req.params.id);
    // Same answer for "doesn't exist" and "not yours", so ids of other helpers' requests can't be probed.
    if (!r || r.helperId !== req.user.id) return res.status(404).json({ error: 'Request not found.' });
    if (r.status !== 'pending') return res.status(409).json({ error: `This request was already ${r.status}.` });
    const now = new Date().toISOString();
    r.status = status;
    r.updatedAt = now;
    r.respondedAt = now;
    saveRequests(requests);
    res.json({ request: requestView(r, 'helper') });
  };
}
app.post('/api/requests/:id/accept', requireAuth, respondToRequest('accepted'));
app.post('/api/requests/:id/decline', requireAuth, respondToRequest('declined'));

app.put('/api/profile', requireAuth, (req, res) => {
  const profile = cleanProfile(req.body, req.user.role);
  const errs = profileErrors(profile, req.user.role);
  if (errs.length) return res.status(400).json({ error: errs[0], errors: errs });
  req.user.profile = profile;
  req.user.updatedAt = new Date().toISOString();
  saveUsers(users);
  res.json({ user: publicUser(req.user) });
});

// Buy (or switch to) a paid plan for the user's role.
app.post('/api/billing/plan', requireAuth, (req, res) => {
  const group = planGroupFor(req.user.role);
  const name = str(req.body.name, 40);
  const price = PLAN_PRICES[group][name];
  const cycle = oneOf(req.body.cycle, CYCLES);
  const method = oneOf(req.body.method, PAY_METHODS);
  if (!price) return res.status(400).json({ error: 'Choose a valid plan.' });
  if (!cycle) return res.status(400).json({ error: 'Choose monthly or yearly billing.' });
  if (!method) return res.status(400).json({ error: 'Choose a payment method.' });
  const current = currentBilling(req.user).plan;
  if (current && current.name === name) return res.status(409).json({ error: `You are already on the ${name} plan.` });

  const renews = new Date();
  if (cycle === 'yearly') renews.setFullYear(renews.getFullYear() + 1); else renews.setMonth(renews.getMonth() + 1);
  const amount = cycle === 'yearly' ? price * 10 : price;
  const billing = billingOf(req.user);
  billing.plans[group] = { name, cycle, renews: renews.toISOString(), since: new Date().toISOString() };
  const payment = recordPayment(req.user, `${name} plan · ${cycle === 'yearly' ? 'Yearly' : 'Monthly'}`, amount, method);
  saveUsers(users);
  res.status(201).json({ user: publicUser(req.user), payment });
});

// Cancel the current plan: back to Free immediately (no refund handling yet).
app.delete('/api/billing/plan', requireAuth, (req, res) => {
  if (!currentBilling(req.user).plan) return res.status(400).json({ error: 'You are on the Free plan.' });
  delete billingOf(req.user).plans[planGroupFor(req.user.role)];
  saveUsers(users);
  res.json({ user: publicUser(req.user) });
});

// Buy a boost (helpers only). Buying while one is active extends it.
app.post('/api/billing/boost', requireAuth, (req, res) => {
  if (!canBoost(req.user.role)) return res.status(403).json({ error: 'Paid Boost is only for helpers.' });
  const days = Number(req.body.days);
  const price = BOOST_PRICES[days];
  const method = oneOf(req.body.method, PAY_METHODS);
  if (!price) return res.status(400).json({ error: 'Choose a valid boost duration.' });
  if (!method) return res.status(400).json({ error: 'Choose a payment method.' });
  const active = currentBilling(req.user).boost;
  const start = active ? new Date(active.ends).getTime() : Date.now();
  const billing = billingOf(req.user);
  billing.boost = { ends: new Date(start + days * DAY_MS).toISOString(), since: active ? active.since : new Date().toISOString() };
  const payment = recordPayment(req.user, `Paid Boost · ${days} day${days > 1 ? 's' : ''}`, price, method);
  saveUsers(users);
  res.status(201).json({ user: publicUser(req.user), payment });
});

// The logged-in user's payment history, newest first.
app.get('/api/billing/payments', requireAuth, (req, res) => {
  const payments = ((req.user.billing || {}).payments || []).slice().reverse();
  res.json({ payments });
});

// Download a PDF receipt for one of the user's own payments.
// Uses the bundled Noto fonts in server/fonts (SIL Open Font License — see the OFL*.txt files there):
// Noto Sans for Latin text and the ₹ sign, plus Noto Sans Tamil and Noto Sans Devanagari so names in those
// scripts print correctly. If Noto Sans is missing, falls back to PDF's built-in Helvetica with "Rs.".
const FONT_DIR = path.join(__dirname, 'fonts');
const fontPair = name => {
  const f = { regular: path.join(FONT_DIR, `${name}-Regular.ttf`), bold: path.join(FONT_DIR, `${name}-Bold.ttf`) };
  return fs.existsSync(f.regular) && fs.existsSync(f.bold) ? f : null;
};
const RECEIPT_FONTS = fontPair('NotoSans');
const SCRIPT_FONTS = { tamil: fontPair('NotoSansTamil'), devanagari: fontPair('NotoSansDevanagari') };
if (!RECEIPT_FONTS) console.warn('Receipt fonts not found in server/fonts — PDF receipts will use Helvetica and "Rs."');
for (const [s, f] of Object.entries(SCRIPT_FONTS)) if (!f) console.warn(`${s} receipt font not found in server/fonts — ${s} text will not display on receipts.`);

// Which script a character belongs to; null = use the Latin font. ZWJ/ZWNJ (joiners) and
// combining marks stay with the Indic text around them so the letters are shaped correctly.
function scriptOf(cp) {
  if (cp >= 0x0B80 && cp <= 0x0BFF) return 'tamil';
  if ((cp >= 0x0900 && cp <= 0x097F) || (cp >= 0xA8E0 && cp <= 0xA8FF) || (cp >= 0x1CD0 && cp <= 0x1CFF)) return 'devanagari';
  return null;
}
const isJoiner = cp => cp === 0x200C || cp === 0x200D || (cp >= 0x0300 && cp <= 0x036F);
// Split text into [{ script, text }] runs.
function scriptRuns(text) {
  const runs = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    let script = scriptOf(cp);
    if (script === null && isJoiner(cp) && runs.length) script = runs[runs.length - 1].script;
    if (runs.length && runs[runs.length - 1].script === script) runs[runs.length - 1].text += ch;
    else runs.push({ script, text: ch });
  }
  return runs;
}

app.get('/api/billing/payments/:ref/receipt', requireAuth, (req, res) => {
  const ref = String(req.params.ref);
  if (!/^ITZB-[0-9A-F]{8}$/.test(ref)) return res.status(400).json({ error: 'Invalid receipt reference.' });
  const p = ((req.user.billing || {}).payments || []).find(x => x.ref === ref);
  if (!p) return res.status(404).json({ error: 'Receipt not found.' });

  const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: `ItzB receipt ${ref}`, Author: 'ItzB' } });
  let REG = 'Helvetica', BOLD = 'Helvetica-Bold', rupee = 'Rs. ';
  if (RECEIPT_FONTS) {
    doc.registerFont('Body', RECEIPT_FONTS.regular); doc.registerFont('Body-Bold', RECEIPT_FONTS.bold);
    REG = 'Body'; BOLD = 'Body-Bold'; rupee = '\u20B9';
  }
  const fontFor = { null: { regular: REG, bold: BOLD } };
  for (const [s, f] of Object.entries(SCRIPT_FONTS)) {
    if (!f) continue;
    doc.registerFont(`${s}`, f.regular); doc.registerFont(`${s}-Bold`, f.bold);
    fontFor[s] = { regular: s, bold: `${s}-Bold` };
  }
  // Write text that may mix scripts, switching font per run. Returns the height used.
  const write = (text, x, top, { width: w, bold = false, size, color }) => {
    const runs = scriptRuns(text);
    doc.fontSize(size).fillColor(color);
    runs.forEach((r, i) => {
      const f = (fontFor[r.script] || fontFor.null)[bold ? 'bold' : 'regular'];
      const opts = { width: w, continued: i < runs.length - 1 };
      if (i === 0) doc.font(f).text(r.text, x, top, opts); else doc.font(f).text(r.text, opts);
    });
    return doc.y - top;
  };
  const name = (req.user.profile && req.user.profile.personal.name) || req.user.login;
  const when = new Date(p.date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
  const valueX = left + width * 0.4, valueW = width * 0.6;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="ItzB-receipt-${ref}.pdf"`);
  doc.pipe(res);

  // Header
  doc.font(BOLD).fontSize(26).fillColor('#111111').text('ItzB', left, 56);
  doc.font(REG).fontSize(12).fillColor('#777777').text('Payment receipt', left, 66, { width, align: 'right' });
  doc.moveTo(left, 100).lineTo(left + width, 100).lineWidth(3).strokeColor('#ffc400').stroke();

  // Detail rows
  let y = 118;
  const row = (label, value, opts = {}) => {
    const size = opts.big ? 16 : 11.5;
    const lh = write(label, left, y, { width: width * 0.38, bold: opts.big, size, color: opts.big ? '#111111' : '#666666' });
    let h = write(value, valueX, y, { width: valueW, bold: opts.big, size, color: '#111111' });
    if (opts.sub) h += 2 + write(opts.sub, valueX, y + h + 2, { width: valueW, size: 9.5, color: '#666666' });
    h = Math.max(h, lh);
    y += h + 10;
    if (!opts.big) { doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.6).strokeColor('#e6e6e6').stroke(); y += 10; }
  };
  row('Receipt no.', p.ref);
  row('Date', when);
  row('Billed to', name, { sub: req.user.login });
  row('Item', p.item);
  row('Payment method', p.method);
  row('Status', p.status === 'demo' ? 'Demo' : p.status);
  y += 4;
  row('Amount', rupee + Number(p.amount).toLocaleString('en-IN'), { big: true });

  // Demo notice
  if (p.status === 'demo') {
    y += 8;
    const note = 'Demo receipt — payments are not live yet, so no money was charged.';
    doc.font(REG).fontSize(10.5);
    const nh = doc.heightOfString(note, { width: width - 24 }) + 18;
    doc.roundedRect(left, y, width, nh, 8).lineWidth(1).fillAndStroke('#fff4d6', '#ffc400');
    doc.fillColor('#111111').text(note, left + 12, y + 9, { width: width - 24 });
    y += nh;
  }

  doc.font(REG).fontSize(9).fillColor('#888888').text('ItzB · Quick help nearby', left, y + 24, { width, align: 'center' });
  doc.end();
});

// Cancel the active boost immediately (no refund handling yet).
app.delete('/api/billing/boost', requireAuth, (req, res) => {
  if (!currentBilling(req.user).boost) return res.status(400).json({ error: 'You have no active boost.' });
  billingOf(req.user).boost = null;
  saveUsers(users);
  res.json({ user: publicUser(req.user) });
});

// ---------- guest bookings (no login needed) ----------
// Hourly rates must match the helpers list in index.html. Payments are NOT live: nothing is charged.
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');
const HELPER_RATES = {
  Arun: 300, Maya: 250, Sam: 350, Nila: 200, Karthik: 400, Priya: 250, Ravi: 350, Divya: 300,
  Imran: 280, Lakshmi: 400, Vikram: 500, Meena: 220, Suresh: 450, Anjali: 350,
};
const DURATIONS = { '1 hour': 1, '2 hours': 2, '3 hours': 3, 'Half day (4 hours)': 4, 'Full day (8 hours)': 8 };
const BOOKING_PAY = ['UPI', 'Cash', 'Debit/Credit card', 'Wallet'];
function loadBookings() {
  try { return JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8')); }
  catch { return []; }
}
function saveBookings(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = BOOKINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, BOOKINGS_FILE);
}
let bookings = loadBookings();

app.post('/api/bookings', (req, res) => {
  const b = req.body || {};
  const helper = str(b.helper, 40);
  const rate = HELPER_RATES[helper];
  const fullName = str(b.fullName, 80);
  const date = str(b.date, 10);
  const hours = DURATIONS[b.duration];
  const explore = str(b.explore, 500);
  const payment = oneOf(b.payment, BOOKING_PAY);
  const today = new Date().toISOString().slice(0, 10);
  if (!rate) return res.status(400).json({ error: 'Choose a helper to book.' });
  if (fullName.length < 2) return res.status(400).json({ error: 'Enter your full name.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date)) || date < today) return res.status(400).json({ error: 'Choose a preferred date from today onwards.' });
  if (!hours) return res.status(400).json({ error: 'Choose a duration.' });
  if (!explore) return res.status(400).json({ error: 'Tell us what you would like to explore.' });
  if (!payment) return res.status(400).json({ error: 'Choose a payment preference.' });

  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const s = token && sessions.get(token);
  const booking = {
    ref: 'BK-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    helper, fullName, date, duration: b.duration, hours, explore, payment,
    rate, amount: rate * hours,
    status: payment === 'Cash' ? 'pay-on-visit' : 'demo',
    userId: s && s.expires > Date.now() ? s.userId : null, // null = guest
    createdAt: new Date().toISOString(),
  };
  bookings.push(booking);
  saveBookings(bookings);
  res.status(201).json({ booking });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Serve the site itself (index.html etc.), but never the server code or data.
app.use((req, res, next) => (/^\/(server|node_modules)(\/|$)|^\/package/i.test(req.path) ? res.status(404).end() : next()));
app.use(express.static(ROOT, { index: 'index.html' }));

const server = app.listen(PORT, () => console.log(`ItzB running at http://localhost:${PORT}`));
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — ItzB (or another app) is probably already running.`);
    console.error(`  • If ItzB is already running, just open http://localhost:${PORT}`);
    console.error('  • Otherwise close the other terminal running it, or start on another port:');
    console.error('      PowerShell:  $env:PORT=3001; npm start');
    console.error('      Command Prompt:  set PORT=3001 && npm start\n');
    process.exit(1);
  }
  throw err;
});
