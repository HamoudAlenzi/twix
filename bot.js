// =============================================================
// Warzone Services — Discord Store Bot v1.0
// Fresh build for Warzone boosting stores.
// Engines: ladder (rank boost) • multi (gun leveling / camo unlock) • package (wins/kills/nuke/levels)
// Includes: private tickets, payment review flow, coupons, order alerts,
//           one-click Discord server auto-setup, secure web control panel.
// Deploy: Railway/any Node host — set DISCORD_TOKEN + PANEL_PASSWORD env vars.
// =============================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ---- Tiny .env loader (no dependency) for local runs ----
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) return;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    });
  }
} catch (e) {}

const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, Partials, StringSelectMenuBuilder, AttachmentBuilder,
  PermissionFlagsBits, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');

// ===== CONFIG =====
const DATA_FILE = path.join(__dirname, 'data.json');
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin123';
const SESSIONS = new Map();
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7;

// ===== DATA STORE =====
const DEFAULT_STORE = {
  services: [],          // unified products — see "kind" docs below
  orders: [],
  customers: [],
  coupons: [],
  paymentRequests: [],
  tickets: [],
  logs: [],
  settings: {
    storeName: 'Warzone Services',
    tagline: 'Pro Warzone Boosting & Unlocks',
    currency: '$',
    color: 0x57f287,                  // Warzone green
    storeChannelId: '',               // default channel for product posts
    channelByKind: { ladder: '', multi: '', package: '' }, // optional per-engine channels
    ticketCategoryId: '',
    logChannelId: '',
    guideChannelId: '',
    welcomeChannelId: '',
    vouchesChannelId: '',
    ownerId: '',
    staffRoleIds: [],
    orderAlertWebhook: '',
    orderAlertsEnabled: true,
    autoCloseSeconds: 20,
    welcomeMsg: 'Welcome to Warzone Services! Open a ticket by clicking Order on any service — fast, safe, and professional boosting.',
    terms: 'Terms of Service\n━━━━━━━━━━━━━━━\n▪️ Work starts right after payment confirmation\n▪️ Account safety guaranteed — VPN matched to your region\n▪️ No refunds once the service has started\n▪️ Delivery times are estimates, not guarantees\n▪️ All sales are final',
    payments: {
      stcPay: { number: '', name: '' },
      alrajhi: { iban: '', name: '' },
      paypal: { email: '', name: '' }
    }
  },
  nextId: 1
};

/*
  SERVICE KINDS
  -------------
  kind: 'ladder'  → rank boost. config: {
      ranks: [{name, emoji}], tiersPerRank: 3, pricePerTier: 5
      // last rank is single-tier (Top 250 style)
    }
    Buyer flow: pick CURRENT rank tier → pick TARGET rank tier → price = tiers × pricePerTier.

  kind: 'multi'   → gun leveling / camo unlock. config: {
      categories: [{name, emoji, items: [{name, emoji, price}]}],
      defaultPrice: 13,
      gunPick: [{name, emoji}]   // OPTIONAL — if set, buyer picks a gun first (camo services)
    }
    Buyer flow: (pick gun) → pick category (if >1) → MULTI-SELECT items → price = sum of item prices.

  kind: 'package' → wins boost, kills boost, nuke service, account leveling. config: {
      packages: [{name, emoji, price, note}]
    }
    Buyer flow: MULTI-SELECT packages → price = sum.
*/

let store = loadStore();

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return {
        ...DEFAULT_STORE, ...parsed,
        settings: {
          ...DEFAULT_STORE.settings, ...(parsed.settings || {}),
          channelByKind: { ...DEFAULT_STORE.settings.channelByKind, ...((parsed.settings || {}).channelByKind || {}) },
          payments: { ...DEFAULT_STORE.settings.payments, ...((parsed.settings || {}).payments || {}) }
        }
      };
    }
  } catch (e) { console.error('Failed to load data.json:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT_STORE));
}

let saveTimer = null;
function saveStore() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.error('Save failed:', e.message); }
  }, 300);
}
function flushSave() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); } catch (e) {} }
process.on('SIGTERM', () => { flushSave(); process.exit(0); });
process.on('SIGINT', () => { flushSave(); process.exit(0); });
setInterval(flushSave, 60 * 1000).unref?.();

function genId() { const id = store.nextId++; saveStore(); return id; }
function addLog(level, msg) {
  store.logs.unshift({ time: new Date().toISOString(), level, msg });
  if (store.logs.length > 500) store.logs.length = 500;
  saveStore();
}

// ===== HELPERS =====
function base64ToBuffer(dataUri) {
  const m = String(dataUri || '').match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return null;
  return { buffer: Buffer.from(m[2], 'base64'), ext: m[1] === 'jpeg' ? 'jpg' : m[1] };
}
function emojiKey(e) {
  if (!e) return '';
  if (typeof e === 'object') return (e.name || '') + ':' + (e.id || '');
  return String(e);
}
function emojiToStr(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (e.id && e.name) return '<:' + e.name + ':' + e.id + '>';
  return '';
}
function emojiOpt(e) {
  // shape usable in select-menu option / button
  if (!e) return undefined;
  if (typeof e === 'object' && e.id) return { id: e.id, name: e.name };
  return e || undefined;
}
// Parse 'emoji Name' or '<:custom:123> Name' or plain 'Name' (+ optional ':price' suffix)
function parseEntry(line, withPrice) {
  if (typeof line === 'object' && line) {
    if (typeof line.emoji === 'string') {
      const cm = line.emoji.trim().match(/^<a?:(\w+):(\d+)>$/);
      if (cm) line = { ...line, emoji: { name: cm[1], id: cm[2] } };
    }
    return line;
  }
  let s = String(line).trim();
  let emoji = '';
  const cm = s.match(/^<a?:(\w+):(\d+)>\s*(.+)$/);
  if (cm) { emoji = { name: cm[1], id: cm[2] }; s = cm[3]; }
  else {
    const um = s.match(/^(\p{Extended_Pictographic}|\p{Emoji})(️)?(?:‍(?:\p{Extended_Pictographic}|\p{Emoji}))*\s*(.+)$/u);
    if (um) { emoji = s.slice(0, s.length - um[3].length).trim(); s = um[3].trim(); }
  }
  if (withPrice) {
    const idx = s.lastIndexOf(':');
    if (idx > 0) {
      const p = parseFloat(s.slice(idx + 1));
      if (!isNaN(p)) return { name: s.slice(0, idx).trim(), emoji, price: p };
    }
    return { name: s.trim(), emoji, price: null };
  }
  return { name: s.trim(), emoji };
}
// Parse categorized list: '# Category' headers + item lines
function parseCategorized(input, withPrice) {
  if (typeof input === 'string') input = input.split('\n');
  if (!Array.isArray(input)) return [];
  const categories = [];
  let cur = null;
  for (let line of input) {
    if (typeof line === 'object' && line && Array.isArray(line.items)) { categories.push(line); cur = null; continue; }
    const s = String(typeof line === 'object' ? (line.name || '') : line).trim();
    if (!s) continue;
    if (s.startsWith('#')) {
      const h = parseEntry(s.replace(/^#+\s*/, ''), false);
      cur = { name: h.name, emoji: h.emoji, items: [] };
      categories.push(cur);
      continue;
    }
    const item = typeof line === 'object' ? parseEntry(line, withPrice) : parseEntry(s, withPrice);
    if (!cur) { cur = { name: 'All', emoji: '', items: [] }; categories.push(cur); }
    cur.items.push(item);
  }
  return categories.filter(c => c.items.length > 0);
}
function expandLadder(cfg) {
  const ranks = cfg.ranks || [];
  const tiers = cfg.tiersPerRank || 3;
  const tierLabels = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  const out = [];
  for (let r = 0; r < ranks.length; r++) {
    const isLast = r === ranks.length - 1;
    if (isLast) out.push({ label: ranks[r].name, emoji: ranks[r].emoji, idx: out.length });
    else for (let t = 0; t < tiers; t++) out.push({ label: ranks[r].name + ' ' + tierLabels[t], emoji: ranks[r].emoji, idx: out.length });
  }
  return out;
}
function serviceStartingPrice(svc) {
  const cfg = svc.config || {};
  if (svc.kind === 'ladder') return cfg.pricePerTier || 0;
  if (svc.kind === 'multi') {
    const prices = (cfg.categories || []).flatMap(c => c.items).map(i => (i.price != null ? i.price : cfg.defaultPrice || 0)).filter(p => p > 0);
    return prices.length ? Math.min(...prices) : (cfg.defaultPrice || 0);
  }
  if (svc.kind === 'package') {
    const prices = (cfg.packages || []).map(p => p.price || 0).filter(p => p > 0);
    return prices.length ? Math.min(...prices) : 0;
  }
  return 0;
}

// ===== PENDING SELECTIONS (avoids Discord's 100-char customId limit) =====
const PENDING = new Map();
const PENDING_TTL = 1000 * 60 * 30;
function pkey(userId, sid) { return userId + ':' + sid; }
function setPending(userId, sid, data) { PENDING.set(pkey(userId, sid), { data, expires: Date.now() + PENDING_TTL }); }
function getPending(userId, sid) {
  const e = PENDING.get(pkey(userId, sid));
  if (!e) return null;
  if (Date.now() > e.expires) { PENDING.delete(pkey(userId, sid)); return null; }
  return e.data;
}
function clearPending(userId, sid) { PENDING.delete(pkey(userId, sid)); }
setInterval(() => { const now = Date.now(); for (const [k, v] of PENDING) if (now > v.expires) PENDING.delete(k); }, 10 * 60 * 1000).unref?.();

// ===== ORDER ALERTS =====
function sendLogToDiscord(msg) {
  const chId = store.settings.logChannelId;
  if (chId && client.isReady()) {
    const ch = client.channels.cache.get(chId);
    if (ch) ch.send(msg).catch(() => {});
  }
}
function sendOrderAlert(msg) {
  if (!store.settings.orderAlertsEnabled) return;
  const s = store.settings;
  if (s.logChannelId && client.isReady()) {
    const ch = client.channels.cache.get(s.logChannelId);
    if (ch) ch.send('@here ' + msg).catch(() => {});
  }
  if (s.ownerId && client.isReady()) {
    client.users.fetch(s.ownerId).then(u => {
      const em = new EmbedBuilder().setColor(0xf0b232).setTitle('🛒 New Order Alert').setDescription(msg).setFooter({ text: s.storeName }).setTimestamp();
      u.send({ embeds: [em] }).catch(() => {});
    }).catch(() => {});
  }
  if (s.orderAlertWebhook) {
    fetch(s.orderAlertWebhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value1: s.storeName, value2: msg.replace(/\*\*/g, '').replace(/`/g, '').substring(0, 500), value3: new Date().toISOString() })
    }).catch(() => {});
  }
}

// ===== EXPRESS =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ limit: '60mb', extended: true }));

// SECURITY: never serve the whole directory — only safe public files.
['logo.png', 'favicon.ico'].forEach(f => {
  app.get('/' + f, (req, res) => {
    const fp = path.join(__dirname, f);
    if (fs.existsSync(fp)) return res.sendFile(fp);
    res.status(404).end();
  });
});

// ===== AUTH =====
function createSession() { const sid = crypto.randomBytes(32).toString('hex'); SESSIONS.set(sid, Date.now() + SESSION_TTL); return sid; }
function isValidSession(sid) {
  if (!sid) return false;
  const exp = SESSIONS.get(sid);
  if (!exp) return false;
  if (Date.now() > exp) { SESSIONS.delete(sid); return false; }
  return true;
}
app.use((req, res, next) => {
  if (['/', '/panel.html'].includes(req.path)) return next();
  if (['/api/login', '/api/check-auth', '/api/backup'].includes(req.path)) return next();
  const sid = req.headers['x-session'];
  if (!isValidSession(sid)) return res.status(401).json({ error: 'Unauthorized. Please login.' });
  next();
});

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (password !== PANEL_PASSWORD) {
    addLog('WARN', `Failed panel login from ${req.ip}`);
    return res.status(401).json({ error: 'Wrong password' });
  }
  const sid = createSession();
  addLog('INFO', `Panel login from ${req.ip}`);
  res.json({ token: sid, storeName: store.settings.storeName });
});
app.post('/api/logout', (req, res) => { const sid = req.headers['x-session']; if (sid) SESSIONS.delete(sid); res.json({ success: true }); });
app.get('/api/check-auth', (req, res) => res.json({ authenticated: isValidSession(req.headers['x-session']) }));
app.get('/', (req, res) => res.redirect('/panel.html'));
app.get('/panel.html', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

// ===== STATS =====
app.get('/api/stats', (req, res) => {
  try {
    const delivered = store.orders.filter(o => o.status === 'Delivered');
    const last7 = new Date(Date.now() - 7 * 864e5), last30 = new Date(Date.now() - 30 * 864e5);
    const chart = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now); d.setDate(now.getDate() - i);
      const day = d.toISOString().slice(0, 10);
      chart.push({ date: day, revenue: delivered.filter(o => o.date && o.date.startsWith(day)).reduce((s, o) => s + o.amount, 0) });
    }
    const byKind = {};
    store.services.forEach(s => { byKind[s.kind] = (byKind[s.kind] || 0) + 1; });
    res.json({
      storeName: store.settings.storeName,
      botOnline: client.isReady(),
      totalServices: store.services.length,
      byKind,
      totalRevenue: delivered.reduce((s, o) => s + o.amount, 0),
      revenue30d: delivered.filter(o => new Date(o.date) >= last30).reduce((s, o) => s + o.amount, 0),
      revenue7d: delivered.filter(o => new Date(o.date) >= last7).reduce((s, o) => s + o.amount, 0),
      totalOrders: store.orders.length,
      inProgress: store.tickets.filter(t => t.status === 'in_progress').length,
      orders7d: store.orders.filter(o => new Date(o.date) >= last7).length,
      pendingPayments: store.paymentRequests.filter(p => p.status === 'Pending' || p.status === 'Waiting Review').length,
      openTickets: store.tickets.filter(t => t.status !== 'closed').length,
      totalCustomers: store.customers.length,
      activeCoupons: store.coupons.filter(c => c.active && (!c.expiresAt || new Date(c.expiresAt) > new Date()) && c.uses < c.maxUses).length,
      salesChart: chart
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== SERVICES CRUD =====
function normalizeServiceConfig(kind, config) {
  const cfg = config || {};
  if (kind === 'ladder') {
    return {
      ranks: (Array.isArray(cfg.ranks) ? cfg.ranks : String(cfg.ranks || '').split('\n')).map(l => parseEntry(l, false)).filter(r => r.name),
      tiersPerRank: parseInt(cfg.tiersPerRank) || 3,
      pricePerTier: parseFloat(cfg.pricePerTier) || 0
    };
  }
  if (kind === 'multi') {
    return {
      categories: parseCategorized(cfg.categories !== undefined ? cfg.categories : cfg.items, true),
      defaultPrice: parseFloat(cfg.defaultPrice) || 0,
      gunPick: (Array.isArray(cfg.gunPick) ? cfg.gunPick : String(cfg.gunPick || '').split('\n')).map(l => parseEntry(l, false)).filter(g => g.name)
    };
  }
  if (kind === 'package') {
    return {
      packages: (Array.isArray(cfg.packages) ? cfg.packages : []).map(p => ({
        name: String(p.name || '').trim(),
        emoji: (typeof p.emoji === 'string' && p.emoji.match(/^<a?:\w+:\d+>$/)) ? parseEntry(p.emoji + ' x', false).emoji : (p.emoji || ''),
        price: parseFloat(p.price) || 0,
        note: String(p.note || '').trim()
      })).filter(p => p.name)
    };
  }
  return cfg;
}

app.get('/api/services', (req, res) => { try { res.json(store.services); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/services', async (req, res) => {
  try {
    const { name, kind, description, eta, image, channelId, config } = req.body;
    if (!name || !kind) return res.status(400).json({ error: 'Name and kind required' });
    if (!['ladder', 'multi', 'package'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
    const svc = {
      id: genId(), name: String(name).trim(), kind,
      description: description || '', eta: eta || '24-48 hours',
      image: image || null, channelId: channelId || '',
      config: normalizeServiceConfig(kind, config),
      active: true, createdAt: new Date().toISOString(), discordMessageIds: []
    };
    // validation
    if (kind === 'ladder' && (svc.config.ranks.length < 2 || svc.config.pricePerTier <= 0)) return res.status(400).json({ error: 'Ladder needs at least 2 ranks and a price per tier' });
    if (kind === 'multi' && svc.config.categories.length === 0) return res.status(400).json({ error: 'Add at least 1 item (e.g. "🔫 M4A1:13")' });
    if (kind === 'package' && svc.config.packages.length === 0) return res.status(400).json({ error: 'Add at least 1 package' });
    store.services.push(svc);
    saveStore();
    const chId = svc.channelId || store.settings.channelByKind[kind] || store.settings.storeChannelId;
    if (chId && client.isReady()) {
      const ch = client.channels.cache.get(chId);
      if (ch) await postServiceToDiscord(ch, svc).catch(e => addLog('ERROR', 'Service post failed: ' + e.message));
    }
    addLog('INFO', `Service created: ${svc.name} (${kind})`);
    res.json(svc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/services/:id', (req, res) => {
  try {
    const svc = store.services.find(s => s.id === parseInt(req.params.id));
    if (!svc) return res.status(404).json({ error: 'Not found' });
    const { name, description, eta, image, channelId, config, active } = req.body;
    if (name !== undefined) svc.name = String(name).trim();
    if (description !== undefined) svc.description = description;
    if (eta !== undefined) svc.eta = eta;
    if (image !== undefined) svc.image = image;
    if (channelId !== undefined) svc.channelId = channelId;
    if (active !== undefined) svc.active = !!active;
    if (config !== undefined) svc.config = normalizeServiceConfig(svc.kind, config);
    saveStore();
    addLog('INFO', 'Service updated: ' + svc.name);
    res.json(svc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/services/:id', async (req, res) => {
  try {
    const svc = store.services.find(s => s.id === parseInt(req.params.id));
    if (!svc) return res.status(404).json({ error: 'Not found' });
    if (svc.discordMessageIds.length && client.isReady()) {
      const chId = svc.channelId || store.settings.channelByKind[svc.kind] || store.settings.storeChannelId;
      const ch = client.channels.cache.get(chId);
      if (ch) for (const mid of svc.discordMessageIds) { try { await ch.messages.delete(mid); } catch (e) {} }
    }
    store.services = store.services.filter(s => s.id !== svc.id);
    saveStore();
    addLog('WARN', 'Service deleted: ' + svc.name);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/services/:id/repost', async (req, res) => {
  try {
    const svc = store.services.find(s => s.id === parseInt(req.params.id));
    if (!svc) return res.status(404).json({ error: 'Not found' });
    const chId = svc.channelId || store.settings.channelByKind[svc.kind] || store.settings.storeChannelId;
    if (!chId || !client.isReady()) return res.status(400).json({ error: 'Bot not ready or channel not set' });
    const ch = client.channels.cache.get(chId);
    if (!ch) return res.status(400).json({ error: 'Channel not found' });
    for (const mid of svc.discordMessageIds) { try { await ch.messages.delete(mid); } catch (e) {} }
    svc.discordMessageIds = [];
    await postServiceToDiscord(ch, svc);
    saveStore();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ORDERS =====
app.get('/api/orders', (req, res) => { try { res.json(store.orders); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/orders/:id/refund', (req, res) => {
  try {
    const o = store.orders.find(x => x.id === req.params.id);
    if (!o) return res.status(404).json({ error: 'Not found' });
    o.status = 'Refunded';
    saveStore();
    addLog('WARN', `Order ${o.id} refunded`);
    res.json(o);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== PAYMENTS =====
app.get('/api/payments', (req, res) => { try { res.json(store.paymentRequests); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/payments/:id/approve', async (req, res) => {
  try {
    const pr = store.paymentRequests.find(p => p.id === req.params.id);
    if (!pr) return res.status(404).json({ error: 'Request missing' });
    if (pr.status === 'Approved' || pr.status === 'Delivered') return res.status(400).json({ error: 'Already approved' });
    pr.status = 'Approved';
    pr.approvedAt = new Date().toISOString();

    const finalAmount = pr.discountedAmount || pr.amount;
    const order = {
      id: 'ORD-' + String(1000 + store.orders.length + 1),
      cust: pr.userName, custId: pr.userId,
      item: pr.title, serviceId: pr.serviceId,
      amount: finalAmount, originalAmount: pr.amount, couponCode: pr.couponCode || null,
      status: 'In Progress',
      paymentMethod: pr.method, date: new Date().toISOString().slice(0, 16).replace('T', ' ')
    };
    store.orders.unshift(order);

    let customer = store.customers.find(c => c.discordId === pr.userId);
    if (!customer) {
      customer = { id: 'u' + genId(), name: pr.userName, discordId: pr.userId, trust: 'Verified', spent: 0, purchases: 0, notes: '', joined: new Date().toISOString().slice(0, 10) };
      store.customers.push(customer);
    }
    customer.purchases += 1;
    customer.spent += finalAmount;
    if (pr.couponCode) {
      const c = store.coupons.find(x => x.code === pr.couponCode);
      if (c) c.uses = (c.uses || 0) + 1;
    }

    const s = store.settings;
    const cur = s.currency;
    const ticket = store.tickets.find(t => t.paymentId === pr.id);
    if (ticket) {
      ticket.status = 'in_progress';
      ticket.orderId = order.id;
      if (ticket.channelId && client.isReady()) {
        const ch = client.channels.cache.get(ticket.channelId);
        if (ch) {
          const em = new EmbedBuilder()
            .setColor(s.color || 0x57f287)
            .setTitle('✅ Payment Confirmed — Service Starting')
            .setDescription(
              `**Hey ${pr.userName}! 👋**\n\n` +
              `Your payment has been confirmed and your order is now **in progress**.\n\n` +
              `**📋 Order Details:**\n` +
              `🎮 Service: ${pr.title}\n` +
              `💰 Amount: \`${cur}${finalAmount.toFixed(2)}\`\n` +
              `🧾 Order: \`${order.id}\`\n` +
              `⏱️ ETA: \`${ticket.eta || '24-48 hours'}\`\n\n` +
              `**Next step:** click the button below and send your account login so our booster can start.`
            )
            .setFooter({ text: s.storeName + ' • Ticket stays open until completion' })
            .setTimestamp();
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('cred_' + ticket.id).setLabel('Send Account Login').setEmoji('🔐').setStyle(ButtonStyle.Primary)
          );
          await ch.send({ embeds: [em], components: [row] });
        }
      }
    }

    if (pr.userId && client.isReady()) {
      try {
        const user = await client.users.fetch(pr.userId);
        const dm = new EmbedBuilder()
          .setColor(s.color || 0x57f287)
          .setTitle('✅ Order Confirmed — ' + s.storeName)
          .setDescription(
            `**Hey ${pr.userName}! 👋**\n\n` +
            `Your payment was confirmed and we started working on your order.\n\n` +
            `**📋 Order Details:**\n` +
            `🎮 Service: ${pr.title}\n` +
            `💰 Amount: \`${cur}${finalAmount.toFixed(2)}\`\n` +
            `🧾 Order: \`${order.id}\`\n\n` +
            `Head back to your ticket and send your account login so we can begin. You'll get a DM the moment it's done! 🚀`
          )
          .setFooter({ text: s.storeName + ' • Keep this message' })
          .setTimestamp();
        await user.send({ embeds: [dm] });
      } catch (e) { addLog('WARN', `Could not DM ${pr.userName}: ${e.message}`); }
    }

    saveStore();
    sendOrderAlert(`✅ Payment approved: \`${pr.id}\` — **${pr.title}** (${cur}${finalAmount}) by ${pr.userName}`);
    addLog('INFO', `Payment approved: ${pr.id}`);
    res.json(pr);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payments/:id/reject', async (req, res) => {
  try {
    const pr = store.paymentRequests.find(p => p.id === req.params.id);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    const reason = (req.body && req.body.reason) || '';
    const reasonLine = reason ? `\n📝 **Reason:** ${reason}\n` : '';
    const ticket = store.tickets.find(t => t.paymentId === pr.id);
    if (ticket && ticket.channelId && client.isReady()) {
      const ch = client.channels.cache.get(ticket.channelId);
      if (ch) {
        const em = new EmbedBuilder()
          .setColor(0xda373c)
          .setTitle('❌ Payment Rejected')
          .setDescription(`Payment \`${pr.id}\` for **${pr.title}** was rejected.${reasonLine}\n⚠️ Please double-check the amount and upload a new receipt here.`)
          .setFooter({ text: store.settings.storeName + ' • Waiting for new receipt' })
          .setTimestamp();
        await ch.send({ embeds: [em] });
        ticket.status = 'waiting_payment';
        pr.status = 'Pending';
      }
    } else {
      pr.status = 'Rejected';
    }
    if (pr.userId && client.isReady()) {
      client.users.fetch(pr.userId).then(u => {
        const dm = new EmbedBuilder()
          .setColor(0xda373c)
          .setTitle('❌ Payment Rejected — ' + store.settings.storeName)
          .setDescription(`**Hey ${pr.userName},**\n\nYour payment \`${pr.id}\` for **${pr.title}** was rejected.${reasonLine}\n⚠️ Please verify the amount and upload a new receipt in your ticket.`)
          .setFooter({ text: store.settings.storeName })
          .setTimestamp();
        u.send({ embeds: [dm] }).catch(() => {});
      }).catch(() => {});
    }
    saveStore();
    sendOrderAlert(`❌ Payment rejected: \`${pr.id}\` — **${pr.title}**${reason ? ' — ' + reason : ''}`);
    addLog('WARN', `Payment rejected: ${pr.id}`);
    res.json(pr);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== TICKETS =====
app.get('/api/tickets', (req, res) => { try { res.json(store.tickets); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/tickets/:id/close', async (req, res) => {
  try {
    const t = store.tickets.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    t.status = 'closed';
    t.closedAt = new Date().toISOString();
    if (t.channelId && client.isReady()) {
      const ch = client.channels.cache.get(t.channelId);
      if (ch) {
        await ch.send('🔒 **Ticket closed** — this channel will be deleted in 5 seconds.').catch(() => {});
        setTimeout(async () => { try { await ch.delete('Ticket closed by admin'); } catch (e) {} }, 5000);
      }
    }
    saveStore();
    addLog('INFO', `Ticket ${t.id} closed manually`);
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/:id/complete', async (req, res) => {
  try {
    const t = store.tickets.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    if (t.status !== 'in_progress') return res.status(400).json({ error: 'This ticket is not in progress.' });
    const pr = store.paymentRequests.find(p => p.id === t.paymentId);
    if (pr) pr.status = 'Delivered';
    const order = store.orders.find(o => o.id === t.orderId) || store.orders.find(o => o.custId === t.userId && o.item === t.title && o.status === 'In Progress');
    if (order) order.status = 'Delivered';
    t.status = 'closed';
    t.closedAt = new Date().toISOString();

    const s = store.settings;
    const vouchLine = s.vouchesChannelId ? `\n⭐ Enjoyed the service? Leave us a review in <#${s.vouchesChannelId}>!` : '';
    const desc =
      `**Hey ${t.userName}! 👋**\n\n` +
      `🎉 Your service is **complete**!\n\n` +
      `**📋 Details:**\n` +
      `🎮 Service: ${t.title}\n` +
      `🎫 Ticket: \`${t.id}\`\n\n` +
      `🎮 Your account is ready — log in and check it out!\n` +
      `🙏 Thanks for choosing **${s.storeName}**!` + vouchLine;

    if (t.channelId && client.isReady()) {
      const ch = client.channels.cache.get(t.channelId);
      if (ch) {
        const em = new EmbedBuilder().setColor(0x3ddc84).setTitle('✅ Service Complete!')
          .setDescription(desc)
          .setFooter({ text: s.storeName + ' • Ticket closes in ' + (s.autoCloseSeconds || 20) + 's' }).setTimestamp();
        await ch.send({ embeds: [em] });
        setTimeout(async () => { try { await ch.delete('Service complete'); } catch (e) {} }, (s.autoCloseSeconds || 20) * 1000);
      }
    }
    if (t.userId && client.isReady()) {
      try {
        const u = await client.users.fetch(t.userId);
        const dm = new EmbedBuilder().setColor(0x3ddc84).setTitle('✅ Service Complete — ' + s.storeName)
          .setDescription(desc).setFooter({ text: s.storeName }).setTimestamp();
        await u.send({ embeds: [dm] });
      } catch (e) {}
    }
    saveStore();
    addLog('INFO', `Ticket ${t.id} completed`);
    sendLogToDiscord(`✅ Service complete: ticket \`${t.id}\` — **${t.title}**`);
    res.json({ success: true, ticketId: t.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== CUSTOMERS =====
app.get('/api/customers', (req, res) => { try { res.json(store.customers); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/customers/:id/blacklist', (req, res) => { try { const c = store.customers.find(x => x.id === req.params.id); if (c) c.trust = 'Blacklisted'; saveStore(); res.json(c || {}); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/customers/:id/unblacklist', (req, res) => { try { const c = store.customers.find(x => x.id === req.params.id); if (c) c.trust = 'Verified'; saveStore(); res.json(c || {}); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== COUPONS =====
app.get('/api/coupons', (req, res) => { try { res.json(store.coupons); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/coupons', (req, res) => {
  try {
    const { code, type, value, maxUses, expiresAt, active } = req.body;
    if (!code || !type || value === undefined) return res.status(400).json({ error: 'code, type, value required' });
    if (store.coupons.find(c => c.code.toUpperCase() === String(code).toUpperCase())) return res.status(400).json({ error: 'Coupon already exists' });
    const coupon = {
      id: genId(), code: String(code).toUpperCase(),
      type: type === 'percent' ? 'percent' : 'fixed',
      value: parseFloat(value), maxUses: parseInt(maxUses) || 999999, uses: 0,
      expiresAt: expiresAt || null, active: active !== false, createdAt: new Date().toISOString()
    };
    store.coupons.push(coupon);
    saveStore();
    addLog('INFO', 'Coupon created: ' + coupon.code);
    res.json(coupon);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/coupons/:id', (req, res) => {
  try {
    const c = store.coupons.find(x => x.id === parseInt(req.params.id));
    if (!c) return res.status(404).json({ error: 'Not found' });
    Object.assign(c, req.body, { id: c.id });
    saveStore(); res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/coupons/:id', (req, res) => { try { store.coupons = store.coupons.filter(c => c.id !== parseInt(req.params.id)); saveStore(); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== SETTINGS / LOGS / BACKUP =====
app.get('/api/settings', (req, res) => { try { res.json(store.settings); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/settings', (req, res) => {
  try {
    const body = req.body || {};
    if (body.channelByKind) body.channelByKind = { ...store.settings.channelByKind, ...body.channelByKind };
    if (body.payments) body.payments = { ...store.settings.payments, ...body.payments };
    Object.assign(store.settings, body);
    saveStore();
    addLog('INFO', 'Settings updated');
    res.json(store.settings);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/logs', (req, res) => { try { res.json(store.logs); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/logs', (req, res) => { try { store.logs = []; saveStore(); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/backup', (req, res) => {
  try {
    const sid = req.query.session || req.headers['x-session'];
    if (!isValidSession(sid)) return res.status(401).json({ error: 'Unauthorized' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="warzone-services-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(store, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/restore', (req, res) => {
  try {
    if (!req.body || !Array.isArray(req.body.services)) return res.status(400).json({ error: 'Invalid backup format' });
    store = { ...DEFAULT_STORE, ...req.body, settings: { ...DEFAULT_STORE.settings, ...(req.body.settings || {}) } };
    saveStore();
    addLog('WARN', 'Store restored from backup');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== BROADCAST =====
app.post('/api/broadcast', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });
    let sent = 0, failed = 0;
    if (client.isReady()) {
      for (const c of store.customers) {
        if (c.trust === 'Blacklisted') continue;
        try {
          const u = await client.users.fetch(c.discordId);
          await u.send(`📢 **${store.settings.storeName} — Announcement**\n\n${message}`);
          sent++;
        } catch (e) { failed++; }
        await new Promise(r => setTimeout(r, 800));
      }
    }
    addLog('INFO', `Broadcast sent to ${sent} customers (${failed} failed)`);
    res.json({ sent, failed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== GUILDS =====
app.get('/api/guilds', (req, res) => {
  try {
    if (!client.isReady()) return res.json([]);
    const out = [];
    client.guilds.cache.forEach(g => out.push({ id: g.id, name: g.name, memberCount: g.memberCount || 0 }));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ONE-CLICK SERVER SETUP =====
// Builds a clean store structure: INFO / STORE / TICKETS / ADMIN categories,
// wires all channel IDs into settings, and posts the welcome + buyer guide.
const SETUP_PLAN = {
  categories: [
    {
      name: '📢 INFO', key: 'info', private: false,
      channels: [
        { name: '👋-welcome', key: 'welcomeChannelId', readOnly: true },
        { name: '📖-how-to-buy', key: 'guideChannelId', readOnly: true },
        { name: '⭐-vouches', key: 'vouchesChannelId', readOnly: false }
      ]
    },
    {
      name: '🛒 STORE', key: 'store', private: false,
      channels: [
        { name: '🏆-rank-boost', key: 'kind:ladder', readOnly: true },
        { name: '🔫-gun-leveling', key: 'kind:multi', readOnly: true },
        { name: '🎨-camo-unlock', key: null, readOnly: true },
        { name: '📦-wins-and-packages', key: 'kind:package', readOnly: true }
      ]
    },
    { name: '🎫 TICKETS', key: 'tickets', private: true, channels: [] },
    {
      name: '🔒 ADMIN', key: 'admin', private: true,
      channels: [{ name: '📜-order-logs', key: 'logChannelId', readOnly: false }]
    }
  ]
};

async function runServerSetup(guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not found — is the bot in your server?');

    const created = [];
    const everyone = guild.id;
    const findChannel = (name, type) => guild.channels.cache.find(c => c.name === name && c.type === type);

    for (const catPlan of SETUP_PLAN.categories) {
      let category = findChannel(catPlan.name, ChannelType.GuildCategory);
      if (!category) {
        const overwrites = catPlan.private ? [{ id: everyone, deny: [PermissionFlagsBits.ViewChannel] }] : [];
        category = await guild.channels.create({ name: catPlan.name, type: ChannelType.GuildCategory, permissionOverwrites: overwrites });
        created.push(catPlan.name);
      }
      if (catPlan.key === 'tickets') { store.settings.ticketCategoryId = category.id; continue; }

      for (const chPlan of catPlan.channels) {
        let ch = findChannel(chPlan.name, ChannelType.GuildText);
        if (!ch) {
          const overwrites = [];
          if (catPlan.private) overwrites.push({ id: everyone, deny: [PermissionFlagsBits.ViewChannel] });
          else if (chPlan.readOnly) overwrites.push({ id: everyone, deny: [PermissionFlagsBits.SendMessages] });
          ch = await guild.channels.create({ name: chPlan.name, type: ChannelType.GuildText, parent: category, permissionOverwrites: overwrites });
          created.push(chPlan.name);
        }
        if (chPlan.key === null) { if (!store.settings.storeChannelId) store.settings.storeChannelId = ch.id; continue; }
        if (chPlan.key.startsWith('kind:')) {
          store.settings.channelByKind[chPlan.key.slice(5)] = ch.id;
          if (!store.settings.storeChannelId) store.settings.storeChannelId = ch.id;
        } else {
          store.settings[chPlan.key] = ch.id;
        }
      }
    }
    saveStore();

    // Post welcome + guide (best effort)
    const s = store.settings;
    if (s.welcomeChannelId) {
      const ch = client.channels.cache.get(s.welcomeChannelId);
      if (ch) {
        const em = new EmbedBuilder()
          .setColor(s.color || 0x57f287)
          .setTitle('🎮 Welcome to ' + s.storeName)
          .setDescription(
            `**${s.tagline || 'Pro Warzone Boosting & Unlocks'}**\n\n` +
            (s.welcomeMsg || '') + '\n\n' +
            `🛒 Browse services in the **STORE** channels\n` +
            `📖 New here? Read <#${s.guideChannelId || ch.id}>\n` +
            `⭐ Check what buyers say in <#${s.vouchesChannelId || ch.id}>`
          )
          .setFooter({ text: s.storeName }).setTimestamp();
        await ch.send({ embeds: [em] }).catch(() => {});
      }
    }
    if (s.guideChannelId) await postGuideTo(s.guideChannelId).catch(() => {});

    addLog('INFO', `Server setup complete on ${guild.name} — created: ${created.join(', ') || 'nothing (already existed)'}`);
    return { created, guildName: guild.name };
}

app.post('/api/setup-server', async (req, res) => {
  try {
    if (!client.isReady()) return res.status(400).json({ error: 'Bot is not connected to Discord.' });
    const guildId = (req.body && req.body.guildId) || client.guilds.cache.first()?.id;
    const result = await runServerSetup(guildId);
    // also post any services that aren't in Discord yet
    await postAllUnpostedServices().catch(() => {});
    res.json({ success: true, ...result, settings: store.settings });
  } catch (e) {
    console.error('setup-server error:', e);
    res.status(500).json({ error: e.message + ' (does the bot have Administrator / Manage Channels permission?)' });
  }
});

// ===== STARTER SERVICES (seeded on first run so the store isn't empty) =====
const WZ_RANKS = [
  { emoji: '🥉', name: 'Bronze' }, { emoji: '🥈', name: 'Silver' }, { emoji: '🥇', name: 'Gold' },
  { emoji: '💠', name: 'Platinum' }, { emoji: '💎', name: 'Diamond' }, { emoji: '🔴', name: 'Crimson' },
  { emoji: '🟣', name: 'Iridescent' }, { emoji: '👑', name: 'Top 250' }
];
function seedDefaultServices() {
  if (store.services.length > 0) return false;
  const mk = (name, kind, description, eta, config) => ({
    id: genId(), name, kind, description, eta, image: null, channelId: '',
    config: normalizeServiceConfig(kind, config),
    active: true, createdAt: new Date().toISOString(), discordMessageIds: []
  });
  store.services.push(
    mk('Warzone Ranked — Rank Boost', 'ladder',
      'Professional rank boosting by top players. Pick your current and target rank — account safety guaranteed.',
      '24-72 hours',
      { ranks: WZ_RANKS, tiersPerRank: 3, pricePerTier: 5 }),
    mk('Gun Leveling — Max Any Weapon', 'multi',
      'We level any weapon to MAX with all attachments unlocked. Select as many guns as you want in one order.',
      '24-48 hours',
      {
        categories: [
          '# 🔫 Assault Rifles', '🔫 AK-27:13', '🔫 M15 MOD 0:13', '🔫 MXR-17:13', '🔫 X9 Maverick:13', '🔫 Peacemaker MK1:13',
          '# 💨 SMGs', '💨 Dravec 45:11', '💨 Kogot-7:11', '💨 VX Compact:11', '💨 C9:11',
          '# 🎯 Snipers & Marksman', '🎯 LW3I Tundra:12', '🎯 HDR:12', '🎯 KRS-7.62:12',
          '# ⛓️ LMGs & Shotguns', '⛓️ GPMG-7:12', '⛓️ BRUEN MK9:12', '💥 Marine Breacher:12'
        ].join('\n'),
        defaultPrice: 13
      }),
    mk('Camo Unlock — Mastery Camos', 'multi',
      'Unlock any mastery camo on your favorite weapon. Pick your weapon, then select all the camos you want.',
      '24-72 hours',
      {
        categories: [
          '# 🎨 Mastery Camos', '🔥 Molten Gold:12', '⚡ Arclight:15', '🌀 Void Stripe:20', '💎 Diamond:25',
          '🌌 Singularity:30', '🌋 Apocalypse:28', '🌑 Dark Matter:35'
        ].join('\n'),
        defaultPrice: 12,
        gunPick: ['🔫 AK-27', '🔫 M15 MOD 0', '🔫 MXR-17', '💨 Dravec 45', '💨 Kogot-7', '🎯 LW3I Tundra', '🎯 HDR'].join('\n')
      }),
    mk('Wins & Kills Boost', 'package',
      'Guaranteed wins and high-kill games played by pro boosters on your account.',
      '12-48 hours',
      {
        packages: [
          { name: '1 Win', emoji: '🏅', price: 8, note: 'played on your account' },
          { name: '5 Wins', emoji: '🏆', price: 35, note: 'save $5' },
          { name: '10 Wins', emoji: '👑', price: 65, note: 'save $15' },
          { name: '20-Kill Game', emoji: '💀', price: 15, note: 'VOD proof included' },
          { name: '30-Kill Game', emoji: '☠️', price: 25, note: 'VOD proof included' }
        ]
      }),
    mk('Nuke Service & Account Leveling', 'package',
      'The legendary nuke skin done for you, plus fast account/battle-pass leveling.',
      '1-4 days',
      {
        packages: [
          { name: 'Nuke Skin Unlock', emoji: '☢️', price: 120, note: 'full challenge completed' },
          { name: 'Account Level 1-55', emoji: '📈', price: 40 },
          { name: 'Battle Pass — 20 Tiers', emoji: '🎟️', price: 15 },
          { name: 'Battle Pass — Full', emoji: '🎫', price: 45 }
        ]
      })
  );
  saveStore();
  addLog('INFO', 'Seeded 5 starter Warzone services (edit or delete them in the panel)');
  return true;
}

// Post every active service that has no Discord message yet
async function postAllUnpostedServices() {
  for (const svc of store.services) {
    if (!svc.active || (svc.discordMessageIds && svc.discordMessageIds.length)) continue;
    const chId = svc.channelId || store.settings.channelByKind[svc.kind] || store.settings.storeChannelId;
    if (!chId) continue;
    const ch = client.channels.cache.get(chId);
    if (!ch) continue;
    await postServiceToDiscord(ch, svc).catch(e => addLog('ERROR', 'Post failed for ' + svc.name + ': ' + e.message));
  }
}
app.post('/api/post-all-services', async (req, res) => {
  try {
    if (!client.isReady()) return res.status(400).json({ error: 'Bot is not connected to Discord.' });
    await postAllUnpostedServices();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== BUYER GUIDE =====
async function postGuideTo(channelId) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) throw new Error('Channel not found');
  const s = store.settings;
  const methods = [];
  if (s.payments.stcPay && s.payments.stcPay.number) methods.push('📱 STC Pay');
  if (s.payments.alrajhi && s.payments.alrajhi.iban) methods.push('🏦 AlRajhi Bank');
  if (s.payments.paypal && s.payments.paypal.email) methods.push('💳 PayPal');
  const em = new EmbedBuilder()
    .setColor(s.color || 0x57f287)
    .setTitle('📖 How to Buy — ' + s.storeName)
    .setDescription(
      `**Ordering takes less than a minute:**\n\n` +
      `1️⃣ Find the service you want in the **STORE** channels and hit **🛒 Order**\n\n` +
      `2️⃣ Pick your options from the menus — for gun leveling and camos you can **select multiple items at once** and the total price is calculated automatically\n\n` +
      `3️⃣ A **private ticket** opens — only you and staff can see it\n\n` +
      `4️⃣ Choose a payment method, send the payment, then **upload a screenshot of the receipt** in the ticket\n\n` +
      `5️⃣ Once staff confirms, you'll be asked for your account login and the boost begins\n\n` +
      `6️⃣ You get a DM the moment your order is complete ✅\n\n` +
      `🎁 Got a coupon? Use the **Coupon** button inside your ticket before paying.`
    )
    .addFields(
      { name: '💳 Payment Methods', value: methods.length ? methods.join(' • ') : 'Ask staff in a ticket', inline: false },
      { name: '📜 Terms of Service', value: (s.terms || '').slice(0, 1024) || '-', inline: false }
    )
    .setFooter({ text: s.storeName + ' • ' + (s.tagline || '') })
    .setTimestamp();
  const files = [];
  try {
    const logoPath = path.join(__dirname, 'logo.png');
    if (fs.existsSync(logoPath)) {
      files.push(new AttachmentBuilder(fs.readFileSync(logoPath), { name: 'logo.png' }));
      em.setThumbnail('attachment://logo.png');
    }
  } catch (e) {}
  await channel.send({ embeds: [em], files });
}

app.post('/api/post-guide', async (req, res) => {
  try {
    if (!client.isReady()) return res.status(400).json({ error: 'Bot is not connected to Discord.' });
    const channelId = (req.body && req.body.channelId) || store.settings.guideChannelId || store.settings.storeChannelId;
    if (!channelId) return res.status(400).json({ error: 'No channel — run Server Setup or set a channel first.' });
    await postGuideTo(channelId);
    addLog('INFO', 'Buyer guide posted to ' + channelId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.on('ready', () => {
  console.log(`[${store.settings.storeName}] Bot online as ${client.user.tag}`);
  try {
    const logoPath = path.join(__dirname, 'logo.png');
    if (fs.existsSync(logoPath) && !client.user.avatar) {
      client.user.setAvatar(fs.readFileSync(logoPath)).catch(() => {});
    }
    client.user.setActivity(store.settings.storeName, { type: 3 });
  } catch (e) {}
  addLog('INFO', 'Bot connected as ' + client.user.tag);
  sendLogToDiscord(`🟢 **${store.settings.storeName}** — Bot Online`);

  // ===== FULL AUTO-SETUP on first boot =====
  // If the server was never set up (no ticket category yet), the bot organizes the
  // Discord server by itself: creates all categories/channels, posts welcome + guide,
  // seeds starter services and posts them to their store channels.
  // Disable by setting AUTO_SETUP=0 in env.
  const autoSetupEnabled = process.env.AUTO_SETUP !== '0';
  const needsSetup = !store.settings.ticketCategoryId;
  if (autoSetupEnabled && needsSetup) {
    setTimeout(async () => {
      try {
        const guild = client.guilds.cache.first();
        if (!guild) { addLog('WARN', 'Auto-setup skipped — bot is not in any server yet.'); return; }
        console.log('[Warzone Services] First boot — auto-organizing server "' + guild.name + '"...');
        seedDefaultServices();
        await runServerSetup(guild.id);
        await postAllUnpostedServices();
        console.log('[Warzone Services] Auto-setup complete ✅ — channels created, guide posted, services listed.');
      } catch (e) {
        console.error('[Warzone Services] Auto-setup failed:', e.message);
        addLog('ERROR', 'Auto-setup failed: ' + e.message + ' — you can run it from the panel (Server Setup page).');
      }
    }, 3000);
  }
});

// ===== SERVICE POSTS =====
const KIND_META = {
  ladder: { emoji: '🏆', label: 'Rank Boost' },
  multi: { emoji: '🔫', label: 'Multi-Select Service' },
  package: { emoji: '📦', label: 'Packages' }
};

async function postServiceToDiscord(channel, svc) {
  const s = store.settings;
  const cur = s.currency;
  const meta = KIND_META[svc.kind] || { emoji: '🎮', label: svc.kind };
  const cfg = svc.config || {};
  const em = new EmbedBuilder()
    .setColor(s.color || 0x57f287)
    .setTitle(meta.emoji + ' ' + svc.name)
    .setDescription(
      '```yaml\nWarzone • ' + meta.label + '```\n' +
      (svc.description ? '📋 ' + svc.description + '\n' : '')
    )
    .addFields({ name: '⏱️ ETA', value: svc.eta || '24-48 hours', inline: true });

  if (svc.kind === 'ladder') {
    const ladderLine = (cfg.ranks || []).map(r => emojiToStr(r.emoji) + '`' + r.name + '`').join(' → ');
    em.addFields(
      { name: '📈 Ranked Ladder', value: ladderLine.slice(0, 1024) || '-', inline: false },
      { name: '🎯 How it works', value: 'Pick your **current** rank and your **target** rank — price is calculated per tier automatically.', inline: false }
    );
  } else if (svc.kind === 'multi') {
    const cats = cfg.categories || [];
    const totalItems = cats.reduce((n, c) => n + c.items.length, 0);
    em.addFields({
      name: '🧩 What you can pick',
      value: (cats.length > 1 ? cats.length + ' categories • ' : '') + totalItems + ' options — **select as many as you want in one order**, total price adds up automatically.',
      inline: false
    });
  } else if (svc.kind === 'package') {
    const lines = (cfg.packages || []).slice(0, 10).map(p => (emojiToStr(p.emoji) ? emojiToStr(p.emoji) + ' ' : '') + '`' + p.name + '` — ' + cur + (p.price || 0).toFixed(2) + (p.note ? ' *(' + p.note + ')*' : ''));
    em.addFields({ name: '📦 Packages (multi-select)', value: lines.join('\n').slice(0, 1024) || '-', inline: false });
  }
  em.addFields({ name: '💰 Starting from', value: '```fix\n' + cur + serviceStartingPrice(svc).toFixed(2) + '```', inline: false });
  em.setFooter({ text: s.storeName + ' • Service ID: ' + svc.id + ' • Click Order to customize' });
  em.setTimestamp();

  const files = [];
  const embeds = [em];
  if (svc.image) {
    const parsed = base64ToBuffer(svc.image);
    if (parsed) {
      const fn = 'svc_' + svc.id + '.jpg';
      files.push(new AttachmentBuilder(parsed.buffer, { name: fn }));
      em.setImage('attachment://' + fn);
    }
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('order_' + svc.id).setLabel('Order Now').setStyle(ButtonStyle.Success).setEmoji('🛒')
  );
  const msg = await channel.send({ embeds, components: [row], files });
  svc.discordMessageIds.push(msg.id);
  saveStore();
}

// ===== TICKET + PAYMENT HELPERS =====
function paymentOptions() {
  const p = store.settings.payments;
  const options = [];
  if (p.stcPay && p.stcPay.number) options.push({ label: 'STC Pay', value: 'stcpay', description: 'STC Pay: ' + p.stcPay.number, emoji: '📱' });
  if (p.alrajhi && p.alrajhi.iban) options.push({ label: 'AlRajhi Bank', value: 'alrajhi', description: 'Bank transfer (IBAN)', emoji: '🏦' });
  if (p.paypal && p.paypal.email) options.push({ label: 'PayPal', value: 'paypal', description: 'PayPal link', emoji: '💳' });
  if (options.length === 0) options.push({ label: 'No payment methods configured', value: 'none', description: 'Contact admin' });
  return options;
}
function paymentInfoText(method) {
  const p = store.settings.payments;
  if (method === 'stcpay') return `📱 **STC Pay**\nNumber: \`${p.stcPay.number}\`\nName: *${p.stcPay.name || '-'}*`;
  if (method === 'alrajhi') return `🏦 **AlRajhi Bank**\nIBAN: \`${p.alrajhi.iban}\`\nName: *${p.alrajhi.name || '-'}*`;
  if (method === 'paypal') return `💳 **PayPal**\n${p.paypal.email}`;
  return '⚠️ Contact staff for payment details.';
}

async function createServiceTicket(interaction, svc, choiceText, price) {
  const s = store.settings;
  const categoryId = s.ticketCategoryId;
  const fail = (msg) => (interaction.deferred || interaction.replied)
    ? interaction.followUp({ content: msg, ephemeral: true }).catch(() => {})
    : interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
  if (!categoryId) return fail('❌ Store is not ready yet — ticket category not configured.');
  const guild = interaction.guild;
  if (!guild) return fail('❌ This only works inside the server.');
  const category = guild.channels.cache.get(categoryId);
  if (!category || category.type !== ChannelType.GuildCategory) return fail('❌ Ticket category misconfigured.');

  const ticketChannel = await guild.channels.create({
    name: `🎫-${interaction.user.username}-${svc.id}`,
    type: ChannelType.GuildText,
    parent: category,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }
    ]
  });
  if (s.ownerId) {
    await ticketChannel.permissionOverwrites.create(s.ownerId, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, ManageChannels: true
    }).catch(() => {});
  }
  if (Array.isArray(s.staffRoleIds)) {
    for (const rid of s.staffRoleIds) {
      if (rid) await ticketChannel.permissionOverwrites.create(rid, {
        ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true
      }).catch(() => {});
    }
  }

  const ticketId = 'TKT-' + String(store.tickets.length + 1).padStart(4, '0');
  const ticket = {
    id: ticketId, userId: interaction.user.id, userName: interaction.user.username,
    serviceId: svc.id, title: svc.name + ' — ' + choiceText, choice: choiceText,
    amount: parseFloat(price.toFixed(2)), eta: svc.eta,
    guildId: guild.id, channelId: ticketChannel.id,
    paymentId: null, paymentMethod: null, orderId: null,
    status: 'open', createdAt: new Date().toISOString()
  };
  store.tickets.unshift(ticket);
  saveStore();

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('pay_' + svc.id + '_' + ticketId)
    .setPlaceholder('💳 Choose payment method')
    .addOptions(paymentOptions());

  const em = new EmbedBuilder()
    .setColor(s.color || 0x57f287)
    .setTitle('🎫 New Order — ' + svc.name)
    .setDescription(
      `**Hey ${interaction.user.username}! 👋**\n\n` +
      `Your private order ticket is ready. Follow the steps below:\n\n` +
      `**📋 Order Details:**\n` +
      `🎮 Service: **${svc.name}**\n` +
      `⚙️ Your selection: **${choiceText}**\n` +
      `💰 Price: \`${s.currency}${price.toFixed(2)}\`\n` +
      `⏱️ ETA: \`${svc.eta || '24-48 hours'}\`\n` +
      `🎫 Ticket: \`${ticketId}\`\n\n` +
      `**📋 Steps to complete your order:**\n` +
      `1️⃣ Choose a payment method below\n` +
      `2️⃣ Send the payment\n` +
      `3️⃣ Upload a receipt screenshot **here in this ticket**\n` +
      `4️⃣ Wait for staff confirmation (you'll get a DM)\n` +
      `5️⃣ Send your account login when asked\n` +
      `6️⃣ Get notified the moment it's done ✅`
    )
    .setFooter({ text: s.storeName + ' • ' + ticketId })
    .setTimestamp();

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tclose_' + ticketId).setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('tcoupon_' + ticketId).setLabel('Coupon').setStyle(ButtonStyle.Secondary).setEmoji('🎁')
  );

  await ticketChannel.send({
    content: '👤 <@' + interaction.user.id + '> | 🎫 Private Order Ticket',
    embeds: [em],
    components: [new ActionRowBuilder().addComponents(selectMenu), closeRow]
  });

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content: '🎫 Your ticket is ready: <#' + ticketChannel.id + '>', ephemeral: true }).catch(() => {});
  } else {
    await interaction.reply({ content: '🎫 Your ticket is ready: <#' + ticketChannel.id + '>', ephemeral: true }).catch(() => {});
  }
  addLog('INFO', `Ticket ${ticketId} — ${interaction.user.username} → ${svc.name} (${choiceText}) ${s.currency}${price}`);
  sendOrderAlert(`🎫 New ticket \`${ticketId}\` by **${interaction.user.username}** — **${svc.name}** (${choiceText}) — ${s.currency}${price}`);
}

function createPaymentRequest(interaction, svc, ticket, method) {
  const payId = 'PAY-' + String(100 + store.paymentRequests.length + 1);
  let finalAmount = ticket.amount;
  let couponCode = null;
  if (ticket.couponCode) { couponCode = ticket.couponCode; finalAmount = ticket.discountedAmount || ticket.amount; }
  store.paymentRequests.unshift({
    id: payId, userId: interaction.user.id, userName: interaction.user.username,
    serviceId: svc.id, title: ticket.title,
    amount: ticket.amount, discountedAmount: finalAmount, couponCode,
    method: method.toUpperCase(), status: 'Pending',
    date: new Date().toISOString().slice(0, 16).replace('T', ' ')
  });
  ticket.paymentId = payId;
  ticket.paymentMethod = method.toUpperCase();
  ticket.status = 'waiting_payment';
  saveStore();
  return payId;
}

// ===== INTERACTION HANDLER =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
  try {
    const s = store.settings;
    const cur = s.currency;
    const brand = s.color || 0x57f287;

    // ---------- ORDER BUTTON ----------
    if (interaction.isButton() && interaction.customId.startsWith('order_')) {
      const sid = parseInt(interaction.customId.split('_')[1]);
      const svc = store.services.find(x => x.id === sid);
      if (!svc || svc.active === false) return interaction.reply({ content: '❌ This service is not available right now.', ephemeral: true });
      const existing = store.tickets.find(t => t.userId === interaction.user.id && t.serviceId === sid && t.status !== 'closed');
      if (existing) return interaction.reply({ content: `🎫 You already have an open ticket for this service: <#${existing.channelId}>`, ephemeral: true });
      const cfg = svc.config || {};

      if (svc.kind === 'ladder') {
        const expanded = expandLadder(cfg);
        if (expanded.length < 2) return interaction.reply({ content: '❌ Service misconfigured.', ephemeral: true });
        const options = expanded.slice(0, 25).map(r => ({
          label: r.label.slice(0, 100), value: String(r.idx),
          description: 'My current rank is ' + r.label.slice(0, 76),
          emoji: emojiOpt(r.emoji)
        }));
        const select = new StringSelectMenuBuilder().setCustomId('ladf_' + sid).setPlaceholder('Select your CURRENT rank').addOptions(options);
        const ladderLine = (cfg.ranks || []).map(r => emojiToStr(r.emoji) + '`' + r.name + '`').join(' → ');
        const em = new EmbedBuilder().setColor(brand).setTitle('🏆 ' + svc.name)
          .setDescription(`**Step 1 — pick your CURRENT rank.**\n📈 Ladder: ${ladderLine}\n💰 Price: \`${cur}${cfg.pricePerTier} per tier\``)
          .setFooter({ text: s.storeName + ' • Step 1 of 2' });
        return interaction.reply({ embeds: [em], components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      }

      if (svc.kind === 'multi') {
        // Optional gun pick first (camo unlock style)
        if (Array.isArray(cfg.gunPick) && cfg.gunPick.length > 0) {
          const options = cfg.gunPick.slice(0, 25).map((g, i) => ({ label: g.name.slice(0, 100), value: String(i), description: 'Unlock for this weapon', emoji: emojiOpt(g.emoji) }));
          const select = new StringSelectMenuBuilder().setCustomId('mgun_' + sid).setPlaceholder('Select your weapon').addOptions(options);
          const em = new EmbedBuilder().setColor(brand).setTitle('🔫 ' + svc.name)
            .setDescription('**Step 1 — pick the weapon you want this for.**')
            .setFooter({ text: s.storeName + ' • Step 1 of 3' });
          return interaction.reply({ embeds: [em], components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
        }
        return await showMultiFlow(interaction, svc, null, true);
      }

      if (svc.kind === 'package') {
        const packages = cfg.packages || [];
        if (!packages.length) return interaction.reply({ content: '❌ Service misconfigured.', ephemeral: true });
        const options = packages.slice(0, 25).map((p, i) => ({
          label: p.name.slice(0, 100), value: String(i),
          description: (cur + (p.price || 0).toFixed(2) + (p.note ? ' • ' + p.note : '')).slice(0, 100),
          emoji: emojiOpt(p.emoji)
        }));
        const select = new StringSelectMenuBuilder().setCustomId('pk_' + sid)
          .setPlaceholder('Select package(s) — you can pick multiple')
          .setMinValues(1).setMaxValues(Math.min(options.length, 25)).addOptions(options);
        const em = new EmbedBuilder().setColor(brand).setTitle('📦 ' + svc.name)
          .setDescription(`**Pick one or more packages** — the total is calculated automatically.\n⏱️ ETA: \`${svc.eta}\``)
          .setFooter({ text: s.storeName });
        return interaction.reply({ embeds: [em], components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      }
      return interaction.reply({ content: '❌ Unknown service type.', ephemeral: true });
    }

    // ---------- LADDER: current rank picked ----------
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ladf_')) {
      const sid = parseInt(interaction.customId.split('_')[1]);
      const svc = store.services.find(x => x.id === sid);
      if (!svc) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const expanded = expandLadder(svc.config || {});
      const fromIdx = parseInt(interaction.values[0]);
      const from = expanded[fromIdx];
      if (!from) return interaction.reply({ content: '❌ Invalid rank.', ephemeral: true });
      const targetOptions = [];
      for (let i = fromIdx + 1; i < expanded.length; i++) {
        const tiers = i - fromIdx;
        targetOptions.push({
          label: expanded[i].label.slice(0, 100), value: String(i),
          description: (cur + (svc.config.pricePerTier * tiers).toFixed(2) + ' (' + tiers + ' tier' + (tiers > 1 ? 's' : '') + ')').slice(0, 100),
          emoji: emojiOpt(expanded[i].emoji)
        });
      }
      if (!targetOptions.length) return interaction.reply({ content: '❌ You are already at the top rank!', ephemeral: true });
      const select = new StringSelectMenuBuilder().setCustomId('ladt_' + sid + '_' + fromIdx).setPlaceholder('Select your TARGET rank').addOptions(targetOptions.slice(0, 25));
      const em = new EmbedBuilder().setColor(brand).setTitle('📈 Current: ' + emojiToStr(from.emoji) + from.label)
        .setDescription('**Step 2 — pick your TARGET rank.**')
        .setFooter({ text: s.storeName + ' • Step 2 of 2' });
      return interaction.update({ embeds: [em], components: [new ActionRowBuilder().addComponents(select)] });
    }

    // ---------- LADDER: target picked → confirm ----------
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ladt_')) {
      const parts = interaction.customId.split('_');
      const sid = parseInt(parts[1]);
      const fromIdx = parseInt(parts[2]);
      const toIdx = parseInt(interaction.values[0]);
      const svc = store.services.find(x => x.id === sid);
      if (!svc) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const expanded = expandLadder(svc.config || {});
      const from = expanded[fromIdx], to = expanded[toIdx];
      if (!from || !to || toIdx <= fromIdx) return interaction.reply({ content: '❌ Invalid selection.', ephemeral: true });
      const tiers = toIdx - fromIdx;
      const price = svc.config.pricePerTier * tiers;
      const em = new EmbedBuilder().setColor(brand).setTitle('✅ Confirm Your Rank Boost')
        .setDescription(`**${svc.name}**\n📈 ${emojiToStr(from.emoji)}\`${from.label}\` → ${emojiToStr(to.emoji)}\`${to.label}\`\n📊 Tiers: ${tiers}\n💰 Price: \`${cur}${price.toFixed(2)}\`\n⏱️ ETA: \`${svc.eta}\`\n\nClick **Confirm** to open your ticket.`)
        .setFooter({ text: s.storeName });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ladok_' + sid + '_' + fromIdx + '_' + toIdx).setLabel('Confirm').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('xcancel').setLabel('Cancel').setEmoji('❌').setStyle(ButtonStyle.Danger)
      );
      return interaction.update({ embeds: [em], components: [row] });
    }

    // ---------- LADDER: confirm ----------
    if (interaction.isButton() && interaction.customId.startsWith('ladok_')) {
      const parts = interaction.customId.split('_');
      const sid = parseInt(parts[1]), fromIdx = parseInt(parts[2]), toIdx = parseInt(parts[3]);
      const svc = store.services.find(x => x.id === sid);
      if (!svc) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const expanded = expandLadder(svc.config || {});
      const from = expanded[fromIdx], to = expanded[toIdx];
      if (!from || !to) return interaction.reply({ content: '❌ Invalid selection — please start again.', ephemeral: true });
      const price = svc.config.pricePerTier * (toIdx - fromIdx);
      await interaction.deferUpdate();
      return await createServiceTicket(interaction, svc, from.label + ' → ' + to.label, price);
    }

    // ---------- MULTI: gun picked ----------
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('mgun_')) {
      const sid = parseInt(interaction.customId.split('_')[1]);
      const svc = store.services.find(x => x.id === sid);
      if (!svc) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const gunIdx = parseInt(interaction.values[0]);
      const gun = (svc.config.gunPick || [])[gunIdx];
      if (!gun) return interaction.reply({ content: '❌ Invalid weapon.', ephemeral: true });
      setPending(interaction.user.id, 'g' + sid, { gunIdx });
      return await showMultiFlow(interaction, svc, gunIdx, false);
    }

    // ---------- MULTI: category picked ----------
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('mcat_')) {
      const sid = parseInt(interaction.customId.split('_')[1]);
      const svc = store.services.find(x => x.id === sid);
      if (!svc) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const catIdx = parseInt(interaction.values[0]);
      return await showMultiItems(interaction, svc, catIdx, false);
    }

    // ---------- MULTI: items multi-selected → confirm ----------
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('mitems_')) {
      const parts = interaction.customId.split('_');
      const sid = parseInt(parts[1]);
      const catIdx = parseInt(parts[2] || '0');
      const svc = store.services.find(x => x.id === sid);
      if (!svc) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const cats = svc.config.categories || [];
      const cat = cats[catIdx] || cats[0];
      if (!cat) return interaction.reply({ content: '❌ Category missing.', ephemeral: true });
      const chosen = interaction.values.map(v => cat.items[parseInt(v)]).filter(Boolean);
      if (!chosen.length) return interaction.reply({ content: '❌ Pick at least one item.', ephemeral: true });
      let total = 0;
      const lines = chosen.map(it => {
        const p = (it.price != null ? it.price : (svc.config.defaultPrice || 0));
        total += p;
        return (emojiToStr(it.emoji) ? emojiToStr(it.emoji) + ' ' : '') + it.name + ' — ' + cur + p.toFixed(2);
      });
      // Pending gun choice (camo services)
      const gp = getPending(interaction.user.id, 'g' + sid);
      const gun = gp && svc.config.gunPick ? svc.config.gunPick[gp.gunIdx] : null;
      setPending(interaction.user.id, 'm' + sid, { items: chosen, total, gunName: gun ? gun.name : null });
      const em = new EmbedBuilder().setColor(brand).setTitle('✅ Confirm Your Order')
        .setDescription(
          `**${svc.name}**\n` +
          (gun ? `🔫 Weapon: \`${gun.name}\`\n` : '') +
          `\n🧩 Selected (${chosen.length}):\n${lines.join('\n').slice(0, 3000)}\n\n` +
          `💰 **Total: \`${cur}${total.toFixed(2)}\`**\n⏱️ ETA: \`${svc.eta}\`\n\nClick **Confirm** to open your ticket.`
        )
        .setFooter({ text: s.storeName });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mok_' + sid).setLabel('Confirm').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('xcancel').setLabel('Cancel').setEmoji('❌').setStyle(ButtonStyle.Danger)
      );
      return interaction.update({ embeds: [em], components: [row] });
    }

    // ---------- MULTI: confirm ----------
    if (interaction.isButton() && interaction.customId.startsWith('mok_')) {
      const sid = parseInt(interaction.customId.split('_')[1]);
      const svc = store.services.find(x => x.id === sid);
      if (!svc) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const pending = getPending(interaction.user.id, 'm' + sid);
      if (!pending || !pending.items || !pending.items.length) {
        return interaction.reply({ content: '⌛ Your selection expired — please click Order again on the service post.', ephemeral: true });
      }
      clearPending(interaction.user.id, 'm' + sid);
      clearPending(interaction.user.id, 'g' + sid);
      const names = pending.items.map(i => i.name).join(', ');
      const choice = (pending.gunName ? pending.gunName + ' — ' : '') + names + ' (' + pending.items.length + ' items)';
      await interaction.deferUpdate();
      return await createServiceTicket(interaction, svc, choice, pending.total);
    }

    // ---------- PACKAGE: multi-selected → confirm ----------
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('pk_')) {
      const sid = parseInt(interaction.customId.split('_')[1]);
      const svc = store.services.find(x => x.id === sid);
      if (!svc) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const packages = svc.config.packages || [];
      const chosen = interaction.values.map(v => packages[parseInt(v)]).filter(Boolean);
      if (!chosen.length) return interaction.reply({ content: '❌ Pick at least one package.', ephemeral: true });
      let total = 0;
      const lines = chosen.map(p => { total += (p.price || 0); return (emojiToStr(p.emoji) ? emojiToStr(p.emoji) + ' ' : '') + p.name + ' — ' + cur + (p.price || 0).toFixed(2); });
      setPending(interaction.user.id, 'p' + sid, { items: chosen, total });
      const em = new EmbedBuilder().setColor(brand).setTitle('✅ Confirm Your Order')
        .setDescription(`**${svc.name}**\n\n📦 Selected (${chosen.length}):\n${lines.join('\n').slice(0, 3000)}\n\n💰 **Total: \`${cur}${total.toFixed(2)}\`**\n⏱️ ETA: \`${svc.eta}\`\n\nClick **Confirm** to open your ticket.`)
        .setFooter({ text: s.storeName });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pok_' + sid).setLabel('Confirm').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('xcancel').setLabel('Cancel').setEmoji('❌').setStyle(ButtonStyle.Danger)
      );
      return interaction.update({ embeds: [em], components: [row] });
    }

    // ---------- PACKAGE: confirm ----------
    if (interaction.isButton() && interaction.customId.startsWith('pok_')) {
      const sid = parseInt(interaction.customId.split('_')[1]);
      const svc = store.services.find(x => x.id === sid);
      if (!svc) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const pending = getPending(interaction.user.id, 'p' + sid);
      if (!pending || !pending.items || !pending.items.length) {
        return interaction.reply({ content: '⌛ Your selection expired — please click Order again on the service post.', ephemeral: true });
      }
      clearPending(interaction.user.id, 'p' + sid);
      const choice = pending.items.map(i => i.name).join(', ') + ' (' + pending.items.length + ')';
      await interaction.deferUpdate();
      return await createServiceTicket(interaction, svc, choice, pending.total);
    }

    // ---------- CANCEL ----------
    if (interaction.isButton() && interaction.customId === 'xcancel') {
      return interaction.update({ content: '❌ Cancelled.', embeds: [], components: [] });
    }

    // ---------- PAYMENT METHOD SELECT ----------
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('pay_')) {
      const parts = interaction.customId.split('_');
      const sid = parseInt(parts[1]);
      const ticketId = parts.slice(2).join('_');
      const svc = store.services.find(x => x.id === sid);
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!svc || !ticket) return interaction.reply({ content: '❌ Ticket or service missing.', ephemeral: true });
      const method = interaction.values[0];
      if (method === 'none') return interaction.reply({ content: '⚠️ No payment methods configured — contact staff.', ephemeral: true });
      const payId = createPaymentRequest(interaction, svc, ticket, method);
      const amount = ticket.discountedAmount || ticket.amount;
      const em = new EmbedBuilder()
        .setColor(0xf0b232)
        .setTitle('💳 Payment Instructions')
        .setDescription(
          `**Service:** ${ticket.title}\n` +
          `**Amount:** \`${cur}${amount.toFixed(2)}\`\n` +
          `**Payment ID:** \`${payId}\`\n\n` +
          paymentInfoText(method) + '\n\n' +
          '⚠️ **Next step:** send the payment, then upload a **screenshot of the receipt here in this ticket**.'
        )
        .setFooter({ text: s.storeName + ' • Awaiting payment proof' })
        .setTimestamp();
      await interaction.reply({ embeds: [em] });
      addLog('INFO', `${interaction.user.username} chose ${method.toUpperCase()} for ${payId}`);
      return;
    }

    // ---------- COUPON BUTTON ----------
    if (interaction.isButton() && interaction.customId.startsWith('tcoupon_')) {
      const ticketId = interaction.customId.replace('tcoupon_', '');
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ Ticket not found.', ephemeral: true });
      if (ticket.couponCode) return interaction.reply({ content: '✅ A coupon is already applied: `' + ticket.couponCode + '`', ephemeral: true });
      const modal = new ModalBuilder().setCustomId('tcpn_' + ticketId).setTitle('Coupon Code');
      const input = new TextInputBuilder().setCustomId('coupon_code').setLabel('Enter your coupon code').setStyle(TextInputStyle.Short).setPlaceholder('e.g. LAUNCH20').setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    // ---------- COUPON MODAL ----------
    if (interaction.isModalSubmit() && interaction.customId.startsWith('tcpn_')) {
      const ticketId = interaction.customId.replace('tcpn_', '');
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ Ticket not found.', ephemeral: true });
      const code = interaction.fields.getTextInputValue('coupon_code').trim().toUpperCase();
      const coupon = store.coupons.find(c => c.code === code);
      if (!coupon) return interaction.reply({ content: '❌ Invalid coupon code.', ephemeral: true });
      if (!coupon.active) return interaction.reply({ content: '❌ This coupon is inactive.', ephemeral: true });
      if (coupon.uses >= coupon.maxUses) return interaction.reply({ content: '❌ This coupon has reached its usage limit.', ephemeral: true });
      if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) return interaction.reply({ content: '❌ This coupon has expired.', ephemeral: true });
      ticket.couponCode = code;
      let discounted = coupon.type === 'percent' ? ticket.amount * (1 - coupon.value / 100) : Math.max(0, ticket.amount - coupon.value);
      ticket.discountedAmount = parseFloat(discounted.toFixed(2));
      // keep any existing pending payment request in sync
      const pr = store.paymentRequests.find(p => p.id === ticket.paymentId && p.status === 'Pending');
      if (pr) { pr.couponCode = code; pr.discountedAmount = ticket.discountedAmount; }
      saveStore();
      const em = new EmbedBuilder().setColor(0x23a55a).setTitle('✅ Coupon Applied!')
        .setDescription(
          `🎁 Code: \`${code}\`\n` +
          `💰 Discount: ${coupon.type === 'percent' ? coupon.value + '%' : cur + coupon.value.toFixed(2)}\n` +
          `💵 Original: ~~${cur}${ticket.amount.toFixed(2)}~~\n` +
          `✨ New total: \`${cur}${ticket.discountedAmount.toFixed(2)}\``
        )
        .setFooter({ text: s.storeName }).setTimestamp();
      await interaction.reply({ embeds: [em] });
      addLog('INFO', `Coupon ${code} applied to ${ticketId}`);
      return;
    }

    // ---------- CREDENTIALS BUTTON ----------
    if (interaction.isButton() && interaction.customId.startsWith('cred_')) {
      const ticketId = interaction.customId.replace('cred_', '');
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ Ticket not found.', ephemeral: true });
      if (ticket.userId !== interaction.user.id) return interaction.reply({ content: '❌ This is not your ticket.', ephemeral: true });
      const modal = new ModalBuilder().setCustomId('credm_' + ticketId).setTitle('Account Login');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cred_email').setLabel('Email / Username').setStyle(TextInputStyle.Short).setPlaceholder('account@email.com').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cred_password').setLabel('Password').setStyle(TextInputStyle.Short).setPlaceholder('Your account password').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cred_platform').setLabel('Platform').setStyle(TextInputStyle.Short).setPlaceholder('Battle.net / Steam / PlayStation / Xbox').setRequired(true))
      );
      await interaction.showModal(modal);
      return;
    }

    // ---------- CREDENTIALS MODAL ----------
    if (interaction.isModalSubmit() && interaction.customId.startsWith('credm_')) {
      const ticketId = interaction.customId.replace('credm_', '');
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ Ticket not found.', ephemeral: true });
      ticket.credEmail = interaction.fields.getTextInputValue('cred_email').trim();
      ticket.credPassword = interaction.fields.getTextInputValue('cred_password').trim();
      ticket.credPlatform = interaction.fields.getTextInputValue('cred_platform').trim();
      saveStore();
      const em = new EmbedBuilder().setColor(0x3ddc84).setTitle('🔐 Login Received')
        .setDescription(
          `**Thanks ${interaction.user.username}!**\n\n` +
          `Your login was received and our booster is starting now.\n\n` +
          `📧 Email: \`${ticket.credEmail}\`\n` +
          `🔑 Password: \`||${ticket.credPassword}||\`\n` +
          `🎮 Platform: \`${ticket.credPlatform}\`\n\n` +
          `⏱️ ETA: \`${ticket.eta || '24-48 hours'}\`\n` +
          `🔔 You'll be notified the moment it's complete. Please **don't log in** while the boost is running.`
        )
        .setFooter({ text: s.storeName + ' • In progress' }).setTimestamp();
      const ch = client.channels.cache.get(ticket.channelId);
      if (ch) await ch.send({ embeds: [em] });
      sendOrderAlert(`🔐 Login submitted in \`${ticket.id}\` by **${interaction.user.username}** (${ticket.credPlatform})`);
      addLog('INFO', `Credentials submitted for ${ticket.id}`);
      await interaction.reply({ content: '✅ Login sent — the booster is starting now!', ephemeral: true });
      return;
    }

    // ---------- CLOSE TICKET ----------
    if (interaction.isButton() && interaction.customId.startsWith('tclose_')) {
      const ticketId = interaction.customId.replace('tclose_', '');
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ Ticket not found.', ephemeral: true });
      if (interaction.user.id !== ticket.userId && interaction.user.id !== s.ownerId) {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const isStaff = member && Array.isArray(s.staffRoleIds) && s.staffRoleIds.some(rid => member.roles.cache.has(rid));
        if (!isStaff) return interaction.reply({ content: '❌ You cannot close this ticket.', ephemeral: true });
      }
      ticket.status = 'closed';
      ticket.closedAt = new Date().toISOString();
      saveStore();
      await interaction.reply({ content: '🔒 **Ticket closed** — this channel will be deleted in 5 seconds.' });
      addLog('INFO', `Ticket ${ticketId} closed by ${interaction.user.username}`);
      setTimeout(async () => { try { await interaction.channel.delete('Ticket closed'); } catch (e) {} }, 5000);
      return;
    }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      const msg = '❌ Something went wrong — please try again.';
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
      else await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    } catch (e) {}
  }
});

// ---- MULTI flow helpers ----
// Step: show category select (if >1 category) or go straight to items.
async function showMultiFlow(interaction, svc, gunIdx, isFirstStep) {
  const s = store.settings;
  const brand = s.color || 0x57f287;
  const cats = (svc.config && svc.config.categories) || [];
  if (!cats.length) {
    const payload = { content: '❌ No items configured for this service.', ephemeral: true };
    return (interaction.isButton() && !interaction.replied) ? interaction.reply(payload).catch(() => {}) : interaction.reply(payload).catch(() => {});
  }
  if (cats.length > 1) {
    const options = cats.slice(0, 25).map((c, i) => ({
      label: c.name.slice(0, 100), value: String(i),
      description: (c.items.length + ' options').slice(0, 100),
      emoji: emojiOpt(c.emoji)
    }));
    const select = new StringSelectMenuBuilder().setCustomId('mcat_' + svc.id).setPlaceholder('Select a category').addOptions(options);
    const em = new EmbedBuilder().setColor(brand).setTitle('🧩 ' + svc.name)
      .setDescription(`**Pick a category first.**\n📋 ${cats.length} categories • ${cats.reduce((n, c) => n + c.items.length, 0)} total options`)
      .setFooter({ text: s.storeName });
    // Button (public post) → ephemeral reply. Select menu (ephemeral msg) → update.
    if (interaction.isStringSelectMenu()) return interaction.update({ embeds: [em], components: [new ActionRowBuilder().addComponents(select)] }).catch(() => {});
    return interaction.reply({ embeds: [em], components: [new ActionRowBuilder().addComponents(select)], ephemeral: true }).catch(() => {});
  }
  return showMultiItems(interaction, svc, 0, isFirstStep);
}

async function showMultiItems(interaction, svc, catIdx, isFirstStep) {
  const s = store.settings;
  const brand = s.color || 0x57f287;
  const cur = s.currency;
  const cats = (svc.config && svc.config.categories) || [];
  const cat = cats[catIdx] || cats[0];
  if (!cat || !cat.items.length) {
    return interaction.reply({ content: '❌ No items in this category.', ephemeral: true }).catch(() => {});
  }
  const options = cat.items.slice(0, 25).map((it, i) => ({
    label: it.name.slice(0, 100), value: String(i),
    description: (cur + ((it.price != null ? it.price : svc.config.defaultPrice) || 0).toFixed(2)).slice(0, 100),
    emoji: emojiOpt(it.emoji)
  }));
  const select = new StringSelectMenuBuilder()
    .setCustomId('mitems_' + svc.id + '_' + catIdx)
    .setPlaceholder('Select item(s) — you can pick multiple')
    .setMinValues(1).setMaxValues(Math.min(options.length, 25))
    .addOptions(options);
  const em = new EmbedBuilder().setColor(brand).setTitle('🧩 ' + svc.name)
    .setDescription(
      (cats.length > 1 ? `**Category: ${emojiToStr(cat.emoji)}${cat.name}**\n\n` : '') +
      `**Pick one or MANY items** — total price adds up automatically.\n` +
      `🧩 Available: ${cat.items.length}` + (cat.items.length > 25 ? ' (showing first 25)' : '')
    )
    .setFooter({ text: s.storeName });
  // Button (public post) must NEVER be updated — reply ephemerally instead.
  if (interaction.isStringSelectMenu()) {
    return interaction.update({ embeds: [em], components: [new ActionRowBuilder().addComponents(select)] }).catch(() => {});
  }
  return interaction.reply({ embeds: [em], components: [new ActionRowBuilder().addComponents(select)], ephemeral: true }).catch(() => {});
}

// ===== RECEIPT UPLOAD HANDLER =====
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const ticket = store.tickets.find(t => t.channelId === message.channel.id && t.status !== 'closed');
  if (!ticket || message.attachments.size === 0) return;
  const img = message.attachments.find(a => a.contentType && a.contentType.startsWith('image/'));
  if (!img) return;
  const pr = store.paymentRequests.find(p => p.id === ticket.paymentId);
  if (!pr || (pr.status !== 'Pending' && pr.status !== 'Rejected')) return;
  pr.status = 'Waiting Review';
  pr.proofUrl = img.url;
  ticket.status = 'waiting_review';
  saveStore();
  const s = store.settings;
  const em = new EmbedBuilder()
    .setColor(0xf0b232)
    .setTitle('⏳ Receipt Received — Under Review')
    .setDescription(
      `**Thanks ${message.author.username}!**\n\n` +
      `Your receipt was received ✅\n\n` +
      `🧾 Payment: \`${pr.id}\`\n` +
      `💰 Amount: \`${s.currency}${(pr.discountedAmount || pr.amount).toFixed(2)}\`\n` +
      `💳 Method: \`${pr.method}\`\n\n` +
      `⏳ Staff is reviewing your payment — you'll get a DM the moment it's confirmed.`
    )
    .setImage(img.url)
    .setFooter({ text: s.storeName + ' • Please wait' })
    .setTimestamp();
  await message.reply({ embeds: [em] }).catch(() => {});
  addLog('INFO', `Receipt uploaded in ${ticket.id} for ${pr.id}`);
  sendOrderAlert(`📨 Receipt uploaded in \`${ticket.id}\` for \`${pr.id}\` — **${ticket.title}** (${s.currency}${pr.discountedAmount || pr.amount})`);
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Warzone Services] Panel running on port ${PORT}`);
  if (PANEL_PASSWORD === 'admin123') console.log('[Warzone Services] WARNING: default panel password — set PANEL_PASSWORD!');
});

if (!process.env.DISCORD_TOKEN) {
  console.error('[Warzone Services] ERROR: DISCORD_TOKEN env var not set! Bot will not connect.');
} else {
  client.login(process.env.DISCORD_TOKEN).catch(err => console.error('[Warzone Services] Discord login failed:', err.message));
}
