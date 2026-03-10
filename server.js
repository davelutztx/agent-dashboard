'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const { marked } = require('marked');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const configPath = path.join(__dirname, 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  console.warn('No config.json found, using defaults');
}
const PORT  = process.env.PORT  || config.port  || 5858;
const TOKEN = process.env.TOKEN || config.token || crypto.randomBytes(16).toString('hex');
const SITE_TITLE = config.siteTitle || 'Agent Dashboard';
const SITE_URL   = config.siteUrl   || `http://localhost:${PORT}`;
const TTL_INTERVAL = config.ttlCleanupIntervalMs || 60000;

// Save token back if it was generated
if (!config.token) {
  config.token = TOKEN;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`Generated token: ${TOKEN}`);
}

// ── Database ──────────────────────────────────────────────────────────────────
const dbPath = path.join(__dirname, 'db', 'dashboard.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS pages (
    slug       TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    format     TEXT DEFAULT 'html',
    agent      TEXT,
    category   TEXT,
    tags       TEXT,
    pinned     INTEGER DEFAULT 0,
    ttl        INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_category ON pages(category);
  CREATE INDEX IF NOT EXISTS idx_expires  ON pages(expires_at) WHERE expires_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_pinned   ON pages(pinned)     WHERE pinned = 1;
`);

// Prepared statements
const stmts = {
  upsert: db.prepare(`
    INSERT INTO pages (slug,title,body,format,agent,category,tags,pinned,ttl,created_at,updated_at,expires_at)
    VALUES (@slug,@title,@body,@format,@agent,@category,@tags,@pinned,@ttl,@created_at,@updated_at,@expires_at)
    ON CONFLICT(slug) DO UPDATE SET
      title=excluded.title, body=excluded.body, format=excluded.format,
      agent=excluded.agent, category=excluded.category, tags=excluded.tags,
      pinned=excluded.pinned, ttl=excluded.ttl, updated_at=excluded.updated_at,
      expires_at=excluded.expires_at
  `),
  get:    db.prepare('SELECT * FROM pages WHERE slug=?'),
  list:   db.prepare('SELECT slug,title,agent,category,tags,pinned,created_at,updated_at,expires_at FROM pages ORDER BY pinned DESC, updated_at DESC'),
  bycat:  db.prepare('SELECT slug,title,agent,category,tags,pinned,created_at,updated_at,expires_at FROM pages WHERE category=? ORDER BY pinned DESC, updated_at DESC'),
  byagent: db.prepare('SELECT slug,title,agent,category,tags,pinned,created_at,updated_at,expires_at FROM pages WHERE agent=? ORDER BY pinned DESC, updated_at DESC'),
  agents: db.prepare('SELECT DISTINCT agent FROM pages WHERE agent IS NOT NULL ORDER BY agent'),
  pinned: db.prepare('SELECT slug,title,agent,category,tags,pinned,created_at,updated_at,expires_at FROM pages WHERE pinned=1 ORDER BY updated_at DESC'),
  patch:  db.prepare(`
    UPDATE pages
    SET
      title=COALESCE(@title,title),
      agent=COALESCE(@agent,agent),
      category=COALESCE(@category,category),
      tags=COALESCE(@tags,tags),
      pinned=COALESCE(@pinned,pinned),
      ttl=CASE WHEN @ttl_set=1 THEN @ttl ELSE ttl END,
      expires_at=CASE
        WHEN @ttl_set=1 AND @ttl IS NULL THEN NULL
        WHEN @ttl_set=1 THEN @updated_at + @ttl
        ELSE expires_at
      END,
      updated_at=@updated_at
    WHERE slug=@slug
  `),
  del:    db.prepare('DELETE FROM pages WHERE slug=?'),
  expire: db.prepare('DELETE FROM pages WHERE expires_at IS NOT NULL AND expires_at < ?'),
  cats:   db.prepare('SELECT DISTINCT category FROM pages WHERE category IS NOT NULL ORDER BY category'),
};

// ── SSE clients ───────────────────────────────────────────────────────────────
const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) {}
  }
}

// ── TTL cleanup ───────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  const r = stmts.expire.run(now);
  if (r.changes > 0) {
    broadcast('expired', { count: r.changes, ts: now });
  }
}, TTL_INTERVAL);

// ── Helpers ───────────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token !== TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Cookie-based auth for browser routes
const BASIC_USER = config.basicUser || 'admin';
const BASIC_PASS = config.basicPass || 'changeme';
const COOKIE_SECRET = config.cookieSecret || crypto.randomBytes(32).toString('hex');
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

// Save cookie secret back if generated
if (!config.cookieSecret) {
  config.cookieSecret = COOKIE_SECRET;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function signSession(user) {
  const payload = JSON.stringify({ user, ts: Date.now() });
  const hmac = crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + hmac;
}

function verifySession(cookie) {
  if (!cookie) return null;
  const [b64, hmac] = cookie.split('.');
  if (!b64 || !hmac) return null;
  const payload = Buffer.from(b64, 'base64').toString();
  const expected = crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(payload);
    if (Date.now() - data.ts > SESSION_MAX_AGE) return null;
    return data;
  } catch (_) { return null; }
}

function isLocalNetwork(req) {
  // Check X-Forwarded-For first (behind reverse proxy / Cloudflare)
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.ip;
  // Normalize IPv6-mapped IPv4 (::ffff:192.168.1.10 → 192.168.1.10)
  const clean = ip.replace(/^::ffff:/, '');
  return clean === '127.0.0.1' || clean === '::1' ||
         clean.startsWith('192.168.') || clean.startsWith('10.') ||
         /^172\.(1[6-9]|2\d|3[01])\./.test(clean);
}

function cookieAuth(req, res, next) {
  // Skip auth for local network requests
  if (isLocalNetwork(req)) return next();
  const session = verifySession(req.cookies?.dash_session);
  if (session) return next();
  // Redirect to login, preserving the original URL
  const returnTo = req.originalUrl || '/';
  res.redirect(`/login?r=${encodeURIComponent(returnTo)}`);
}

function renderBody(page) {
  if (page.format === 'markdown') {
    return marked.parse(page.body);
  }
  return page.body;
}

function parseTags(tagsStr) {
  if (!tagsStr) return [];
  try { return JSON.parse(tagsStr); } catch(_) { return tagsStr.split(',').map(t => t.trim()); }
}

function timeAgo(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400)return `${Math.floor(diff/3600)}h ago`;
  return `${Math.floor(diff/86400)}d ago`;
}

function formatExpiry(page) {
  if (!page.expires_at) return '';
  const diff = page.expires_at - Math.floor(Date.now() / 1000);
  if (diff <= 0) return 'expired';
  if (diff < 3600) return `expires in ${Math.floor(diff/60)}m`;
  if (diff < 86400)return `expires in ${Math.floor(diff/3600)}h`;
  return `expires in ${Math.floor(diff/86400)}d`;
}

// ── Templates ─────────────────────────────────────────────────────────────────
function layout(title, body, extraHead = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} — ${escHtml(SITE_TITLE)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/style.css">
${extraHead}
</head>
<body class="dark">
<header>
  <a class="site-title" href="/">${escHtml(SITE_TITLE)}</a>
  <nav>
    <a href="/">All</a>
    <a href="/pinned">📌 Pinned</a>
    <a href="/logout">Logout</a>
  </nav>
</header>
<main>
${body}
</main>
<footer><small>powered by dashboard-service</small></footer>
</body>
</html>`;
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function pageCard(p) {
  const expiry = formatExpiry(p);
  return `
<article class="card${p.pinned ? ' pinned' : ''}">
  <h2><a href="/pages/${escHtml(p.slug)}">${escHtml(p.title)}</a>${p.pinned ? ' <span class="pin">📌</span>' : ''}</h2>
  <div class="meta">
    ${p.agent ? `<span class="badge agent"><a href="/agent/${escHtml(p.agent)}">${escHtml(p.agent)}</a></span>` : ''}
    ${p.category ? `<span class="badge cat"><a href="/category/${escHtml(p.category)}">${escHtml(p.category)}</a></span>` : ''}
    <span class="time">${timeAgo(p.updated_at)}</span>
    ${expiry ? `<span class="expiry">${escHtml(expiry)}</span>` : ''}
  </div>
</article>`;
}

function indexPage(pages, cats, agents = [], activeFilter = '', filterType = '') {
  const pinnedPages = pages.filter(p => p.pinned);
  const unpinned    = pages.filter(p => !p.pinned);

  const agentLinks = agents.map(a =>
    `<a href="/agent/${escHtml(a.agent)}" class="${filterType==='agent'&&activeFilter===a.agent?'active':''}">${escHtml(a.agent)}</a>`
  ).join('');

  const catLinks = cats.map(c =>
    `<a href="/category/${escHtml(c.category)}" class="${filterType==='category'&&activeFilter===c.category?'active':''}">${escHtml(c.category)}</a>`
  ).join('');

  const pinnedHtml = pinnedPages.length
    ? `<section class="section-pinned"><h3>📌 Pinned</h3>${pinnedPages.map(pageCard).join('')}</section>`
    : '';

  const cardsHtml = unpinned.length
    ? unpinned.map(pageCard).join('')
    : '<p class="empty">No pages yet. Push content via the API.</p>';

  return layout(SITE_TITLE, `
<div class="index-controls">
  <div class="filter-bar">
    <a href="/" class="${!activeFilter?'active':''}">All</a>
    ${agentLinks ? '<span class="filter-sep">·</span>' + agentLinks : ''}
    ${catLinks ? '<span class="filter-sep">·</span>' + catLinks : ''}
  </div>
  <span class="page-count">${pages.length} page${pages.length!==1?'s':''}</span>
</div>
${pinnedHtml}
<section class="section-pages">
  ${cardsHtml}
</section>
`, `<script>
// SSE live reload
const es = new EventSource('/api/events');
es.addEventListener('push',    () => location.reload());
es.addEventListener('patch',   () => location.reload());
es.addEventListener('delete',  () => location.reload());
es.addEventListener('expired', () => location.reload());
</script>`);
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── Login / Logout ────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  // Already logged in? Redirect home
  if (verifySession(req.cookies?.dash_session)) return res.redirect(req.query.r || '/');
  const error = req.query.error ? '<p class="login-error">Invalid username or password</p>' : '';
  const returnTo = escHtml(req.query.r || '/');
  res.send(layout('Login', `
<div class="login-container">
  <h1>🔒 Dashboard Login</h1>
  ${error}
  <form method="POST" action="/login" class="login-form">
    <input type="hidden" name="r" value="${returnTo}">
    <label for="user">Username</label>
    <input type="text" id="user" name="user" autocomplete="username" required autofocus>
    <label for="pass">Password</label>
    <input type="password" id="pass" name="pass" autocomplete="current-password" required>
    <button type="submit">Sign In</button>
  </form>
</div>`));
});

app.post('/login', (req, res) => {
  const { user, pass, r } = req.body;
  if (user === BASIC_USER && pass === BASIC_PASS) {
    const cookie = signSession(user);
    res.cookie('dash_session', cookie, {
      httpOnly: true,
      secure: req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https',
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE,
      path: '/',
    });
    return res.redirect(r || '/');
  }
  const returnTo = encodeURIComponent(r || '/');
  res.redirect(`/login?error=1&r=${returnTo}`);
});

app.get('/logout', (req, res) => {
  res.clearCookie('dash_session', { path: '/' });
  res.redirect('/login');
});

// ── SSE endpoint ──────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));

  // Keepalive every 25s
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch(_) {} }, 25000);
  req.on('close', () => clearInterval(hb));
});

// ── API: push / upsert ────────────────────────────────────────────────────────
app.post('/api/pages/:slug', authMiddleware, (req, res) => {
  const { slug } = req.params;
  const { title, body, format='html', agent, category, tags, pinned=false, ttl, replace=true } = req.body;

  if (!title || !body) return res.status(400).json({ error: 'title and body required' });

  // If replace=false and slug exists, 409
  const existing = stmts.get.get(slug);
  if (!replace && existing) {
    return res.status(409).json({ error: 'Page already exists. Use replace:true to overwrite.' });
  }

  const now = Math.floor(Date.now() / 1000);
  const expires_at = ttl ? now + ttl : null;
  const tagsStr = Array.isArray(tags) ? JSON.stringify(tags) : (tags || null);

  stmts.upsert.run({
    slug, title, body, format,
    agent: agent || null,
    category: category || null,
    tags: tagsStr,
    pinned: pinned ? 1 : 0,
    ttl: ttl || null,
    created_at: existing ? existing.created_at : now,
    updated_at: now,
    expires_at,
  });

  broadcast('push', { slug, title, agent, category });
  res.status(201).json({ slug, url: `${SITE_URL}/pages/${slug}` });
});

// ── API: JSON list ────────────────────────────────────────────────────────────
app.get('/api/pages', authMiddleware, (req, res) => {
  res.json(stmts.list.all());
});

// ── API: JSON single page ─────────────────────────────────────────────────────
app.get('/api/pages/:slug', authMiddleware, (req, res) => {
  const page = stmts.get.get(req.params.slug);
  if (!page) return res.status(404).json({ error: 'Not found' });
  res.json(page);
});

// ── API: patch metadata ───────────────────────────────────────────────────────
app.patch('/api/pages/:slug', authMiddleware, (req, res) => {
  const { slug } = req.params;
  if (!stmts.get.get(slug)) return res.status(404).json({ error: 'Not found' });

  const { title, agent, category, tags, pinned } = req.body;
  const ttlSet = Object.prototype.hasOwnProperty.call(req.body, 'ttl');
  const ttlRaw = req.body.ttl;
  const ttl = ttlSet
    ? (ttlRaw === null || ttlRaw === '' ? null : Number(ttlRaw))
    : null;

  if (ttlSet && ttl !== null && (!Number.isFinite(ttl) || ttl < 1)) {
    return res.status(400).json({ error: 'ttl must be a positive number of seconds or null' });
  }

  const updated_at = Math.floor(Date.now() / 1000);

  stmts.patch.run({
    slug,
    title: title || null,
    agent: agent || null,
    category: category || null,
    tags: Array.isArray(tags) ? JSON.stringify(tags) : (tags || null),
    pinned: pinned !== undefined ? (pinned ? 1 : 0) : null,
    ttl_set: ttlSet ? 1 : 0,
    ttl,
    updated_at,
  });

  broadcast('patch', { slug });
  res.json({ ok: true });
});

// ── API: delete ───────────────────────────────────────────────────────────────
app.delete('/api/pages/:slug', authMiddleware, (req, res) => {
  const r = stmts.del.run(req.params.slug);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  broadcast('delete', { slug: req.params.slug });
  res.json({ ok: true });
});

// ── HTML: index ───────────────────────────────────────────────────────────────
app.get('/', cookieAuth, (req, res) => {
  const pages  = stmts.list.all();
  const cats   = stmts.cats.all();
  const agents = stmts.agents.all();
  res.send(indexPage(pages, cats, agents));
});

// ── HTML: category filter ─────────────────────────────────────────────────────
app.get('/category/:name', cookieAuth, (req, res) => {
  const pages  = stmts.bycat.all(req.params.name);
  const cats   = stmts.cats.all();
  const agents = stmts.agents.all();
  res.send(indexPage(pages, cats, agents, req.params.name, 'category'));
});

// ── HTML: agent filter ────────────────────────────────────────────────────────
app.get('/agent/:name', cookieAuth, (req, res) => {
  const pages  = stmts.byagent.all(req.params.name);
  const cats   = stmts.cats.all();
  const agents = stmts.agents.all();
  res.send(indexPage(pages, cats, agents, req.params.name, 'agent'));
});

// ── HTML: pinned ──────────────────────────────────────────────────────────────
app.get('/pinned', cookieAuth, (req, res) => {
  const pages  = stmts.pinned.all();
  const cats   = stmts.cats.all();
  const agents = stmts.agents.all();
  const html = `
<div class="index-controls">
  <div class="filter-bar"><a href="/">← All pages</a></div>
  <span class="page-count">${pages.length} pinned</span>
</div>
<section class="section-pages">
  ${pages.length ? pages.map(pageCard).join('') : '<p class="empty">Nothing pinned yet.</p>'}
</section>`;
  res.send(layout('Pinned Pages', html));
});

// ── HTML: single page view ────────────────────────────────────────────────────
app.get('/pages/:slug', cookieAuth, (req, res) => {
  const page = stmts.get.get(req.params.slug);
  if (!page) return res.status(404).send(layout('Not Found', '<p class="empty">Page not found.</p>'));

  const bodyHtml = renderBody(page);
  const expiry = formatExpiry(page);

  const html = `
<div class="page-header">
  <h1>${escHtml(page.title)}</h1>
  <div class="meta">
    ${page.agent ? `<span class="badge agent"><a href="/agent/${escHtml(page.agent)}">${escHtml(page.agent)}</a></span>` : ''}
    ${page.category ? `<span class="badge cat"><a href="/category/${escHtml(page.category)}">${escHtml(page.category)}</a></span>` : ''}
    ${page.pinned ? '<span class="badge pin">📌 pinned</span>' : ''}
    <span class="time">updated ${timeAgo(page.updated_at)}</span>
    ${expiry ? `<span class="expiry">${escHtml(expiry)}</span>` : ''}
  </div>
  <div class="page-actions">
    <a href="/" class="btn-back">← Index</a>
    <form method="POST" action="/pages/${escHtml(page.slug)}/delete" class="inline-form"
          onsubmit="return confirm('Clear this page?')">
      <button type="submit" class="btn-clear">🗑 Clear</button>
    </form>
  </div>
</div>
<div class="page-body ${page.format === 'markdown' ? 'markdown' : 'raw-html'}">
${bodyHtml}
</div>`;

  res.send(layout(page.title, html, `<script>
// SSE live reload for this page
const es = new EventSource('/api/events');
es.addEventListener('push',   e => { if(JSON.parse(e.data).slug==='${page.slug}') location.reload(); });
es.addEventListener('patch',  e => { if(JSON.parse(e.data).slug==='${page.slug}') location.reload(); });
es.addEventListener('delete', e => { if(JSON.parse(e.data).slug==='${page.slug}') window.location.href='/'; });
</script>`));
});

// ── Browser: delete page (cookie auth) ────────────────────────────────────
app.post('/pages/:slug/delete', cookieAuth, (req, res) => {
  const r = stmts.del.run(req.params.slug);
  if (r.changes > 0) broadcast('delete', { slug: req.params.slug });
  res.redirect('/');
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT}`);
  console.log(`Token: ${TOKEN}`);
  console.log(`DB: ${dbPath}`);
});
