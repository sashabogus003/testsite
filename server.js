const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const SHUFFLE_URL = process.env.SHUFFLE_URL || 'https://affiliate.shuffle.com/stats/bca8e311-d298-439d-915b-42c8b79bf3b1';
const BOTRIX_CHANNEL = process.env.BOTRIX_CHANNEL || 'alexcasino';
const BOTRIX_PLATFORM = 'kick';
const BOTRIX_SECRET = process.env.BOTRIX_SECRET || '';
const BOTRIX_UID_FIELD = process.env.BOTRIX_UID_FIELD || 'username';
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

const DEFAULT_ADMIN_PERMS = ['manage_giveaways', 'manage_predictions', 'review_flags', 'view_audit'];

const ROLE_PERMISSIONS = {
  superadmin: ['*'],
  admin: DEFAULT_ADMIN_PERMS,
  user: [],
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function ensureDb() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(DB_FILE)) {
    const now = new Date().toISOString();
    const initial = {
      users: {
        owner: {
          id: 'owner',
          displayName: 'Owner',
          role: 'superadmin',
          customPermissions: [],
          banned: false,
          provider: 'telegram',
          providerId: 'owner',
          kickUsername: 'alexcasino',
          telegram: 'casino_alex',
          shuffleNick: '',
          flags: [],
          createdAt: now,
          updatedAt: now,
        },
      },
      sessions: {},
      giveaways: [],
      predictions: [],
      supportTickets: [],
      auditLogs: [],
      seq: { giveaway: 1, prediction: 1, supportTicket: 1 },
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }

  const db = safeJsonParse(fs.readFileSync(DB_FILE, 'utf8'), null);
  if (!db) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      users: {}, sessions: {}, giveaways: [], predictions: [], supportTickets: [], auditLogs: [],
      seq: { giveaway: 1, prediction: 1, supportTicket: 1 },
    }, null, 2));
    return;
  }

  db.users = db.users || {};
  db.sessions = db.sessions || {};
  db.giveaways = db.giveaways || [];
  db.predictions = db.predictions || [];
  db.supportTickets = db.supportTickets || [];
  db.auditLogs = db.auditLogs || [];
  db.seq = db.seq || { giveaway: 1, prediction: 1, supportTicket: 1 };

  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return raw.split(';').reduce((acc, part) => {
    const [key, ...rest] = part.trim().split('=');
    if (!key) return acc;
    acc[key] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

function sendJson(res, code, payload, extraHeaders = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

function monthRangeMoscow(date = new Date()) {
  const local = new Date(date.getTime() + MOSCOW_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const start = Date.UTC(y, m, 1, 0, 0, 0) - MOSCOW_OFFSET_MS;
  const end = Date.UTC(y, m + 1, 0, 23, 59, 59) - MOSCOW_OFFSET_MS;
  return { startTime: Math.floor(start / 1000), endTime: Math.floor(end / 1000) };
}

function addAudit(db, actor, action, payload = {}) {
  db.auditLogs.unshift({ at: nowIso(), actor: actor || 'system', action, payload });
  db.auditLogs = db.auditLogs.slice(0, 400);
}

function userPermissions(user) {
  if (!user) return [];
  if (user.role === 'superadmin') return ['*'];
  if (user.role === 'admin') return [...new Set([...(ROLE_PERMISSIONS.admin || []), ...(user.customPermissions || [])])];
  return [];
}

function hasPermission(user, perm) {
  const perms = userPermissions(user);
  return perms.includes('*') || perms.includes(perm);
}

function requirePermission(user, perm) {
  if (!user) return { ok: false, code: 401, error: 'Unauthorized' };
  if (user.banned) return { ok: false, code: 403, error: 'Banned user' };
  if (!hasPermission(user, perm)) return { ok: false, code: 403, error: `Missing permission: ${perm}` };
  return { ok: true };
}

function normalizeStr(v) {
  return String(v || '').trim();
}

function mask(name) {
  if (!name || name.length < 3) return name || '';
  return `${name[0]}${'*'.repeat(Math.max(name.length - 2, 1))}${name[name.length - 1]}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: { accept: 'application/json', ...(options.headers || {}) },
    body: options.body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  }

  return response.json();
}

async function pointsForUsername(username) {
  const url = `https://botrix.live/api/public/leaderboard?platform=${BOTRIX_PLATFORM}&user=${encodeURIComponent(BOTRIX_CHANNEL)}&search=${encodeURIComponent(username)}`;
  const data = await fetchJson(url);
  const rows = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
  if (!rows.length) return { points: 0, found: false };
  const row = rows[0] || {};
  const points = Number(row.points ?? row.value ?? row.score ?? 0);
  return { points: Number.isFinite(points) ? points : 0, found: true };
}

async function subtractPointsBotrix({ username, points }) {
  if (!BOTRIX_SECRET) {
    return { ok: false, skipped: true, reason: 'BOTRIX_SECRET is not configured' };
  }

  const uid = BOTRIX_UID_FIELD === 'username' ? username : username;
  const url = `https://botrix.live/api/extension/substractPoints?uid=${encodeURIComponent(uid)}&platform=${BOTRIX_PLATFORM}&points=${encodeURIComponent(points)}&bid=${encodeURIComponent(BOTRIX_SECRET)}`;

  try {
    const result = await fetchJson(url);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, skipped: false, reason: String(error.message || error) };
  }
}

function profileComplete(user) {
  return Boolean(user?.telegram && user?.shuffleNick);
}

function detectFlags(db, currentUserId) {
  const current = db.users[currentUserId];
  if (!current) return [];

  const sameTelegramWith = [];
  const sameShuffleWith = [];

  for (const user of Object.values(db.users)) {
    if (user.id === currentUserId) continue;

    if (current.telegram && user.telegram && current.telegram.toLowerCase() === user.telegram.toLowerCase()) {
      sameTelegramWith.push(user.id);
    }

    if (current.shuffleNick && user.shuffleNick && current.shuffleNick.toLowerCase() === user.shuffleNick.toLowerCase()) {
      sameShuffleWith.push(user.id);
    }
  }

  const flags = [];
  if (sameTelegramWith.length) flags.push({ type: 'duplicate_telegram', withUserIds: sameTelegramWith });
  if (sameShuffleWith.length) flags.push({ type: 'duplicate_shuffle_nick', withUserIds: sameShuffleWith });
  return flags;
}

function getAuthUser(db, req) {
  const cookies = parseCookies(req);
  const token = cookies.sessionToken;
  if (!token) return null;
  const session = db.sessions[token];
  if (!session) return null;
  const user = db.users[session.userId];
  if (!user || user.banned) return null;
  return user;
}

function setSessionCookie(token) {
  return `sessionToken=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}

function clearSessionCookie() {
  return 'sessionToken=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

function sanitizeUser(user) {
  return {
    id: user.id,
    displayName: user.displayName,
    role: user.role,
    customPermissions: user.customPermissions || [],
    banned: Boolean(user.banned),
    provider: user.provider,
    providerId: user.providerId,
    kickUsername: user.kickUsername,
    telegram: user.telegram,
    shuffleNick: user.shuffleNick,
    flags: user.flags || [],
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function userPredictionStats(db, userId) {
  let total = 0;
  let won = 0;
  for (const p of db.predictions) {
    if (p.entries.some((e) => e.userId === userId)) total += 1;
    if (p.winnerUserId === userId) won += 1;
  }
  return { totalPredictions: total, wonPredictions: won, winRate: total ? Number((won / total).toFixed(3)) : 0 };
}

async function handleApi(req, reqUrl, res) {
  const db = readDb();
  const authUser = getAuthUser(db, req);

  if (req.method === 'GET' && reqUrl.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/config') {
    return sendJson(res, 200, {
      timezone: 'Europe/Moscow',
      leaderboardPollSeconds: 60,
      pointsPollSeconds: 60,
      supportUrl: 'https://t.me/casino_alex',
      externalShopUrl: 'https://alexcasino-botrix-shop-pro.vercel.app/',
      availablePermissions: [...new Set([...DEFAULT_ADMIN_PERMS, 'manage_users'])],
    });
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/auth/login') {
    const body = await readBody(req);
    const provider = normalizeStr(body.provider);
    const providerId = normalizeStr(body.providerId);
    const displayName = normalizeStr(body.displayName);

    if (!provider || !providerId) return sendJson(res, 400, { error: 'provider and providerId are required' });
    if (!['kick', 'telegram'].includes(provider)) return sendJson(res, 400, { error: 'provider must be kick or telegram' });

    let user = Object.values(db.users).find((u) => u.provider === provider && u.providerId === providerId);
    if (!user) {
      const userId = `${provider}-${providerId.toLowerCase()}`;
      user = {
        id: userId,
        displayName: displayName || providerId,
        role: 'user',
        customPermissions: [],
        banned: false,
        provider,
        providerId,
        kickUsername: provider === 'kick' ? providerId : '',
        telegram: provider === 'telegram' ? providerId : '',
        shuffleNick: '',
        flags: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.users[user.id] = user;
      addAudit(db, user.id, 'auth_signup', { provider });
    } else {
      if (user.banned) return sendJson(res, 403, { error: 'Your account is banned' });
      if (displayName) user.displayName = displayName;
      user.updatedAt = nowIso();
      addAudit(db, user.id, 'auth_login', { provider });
    }

    user.flags = detectFlags(db, user.id);
    const token = randomToken();
    db.sessions[token] = { userId: user.id, createdAt: nowIso() };
    writeDb(db);

    return sendJson(res, 200, { user: sanitizeUser(user), profileComplete: profileComplete(user) }, { 'Set-Cookie': setSessionCookie(token) });
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/auth/logout') {
    const cookies = parseCookies(req);
    const token = cookies.sessionToken;
    if (token && db.sessions[token]) delete db.sessions[token];
    writeDb(db);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/auth/me') {
    if (!authUser) return sendJson(res, 200, { user: null, profileComplete: false, permissions: [] });
    return sendJson(res, 200, {
      user: sanitizeUser(authUser),
      profileComplete: profileComplete(authUser),
      permissions: userPermissions(authUser),
      stats: userPredictionStats(db, authUser.id),
    });
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/profile') {
    if (!authUser) return sendJson(res, 401, { error: 'Unauthorized' });

    const body = await readBody(req);
    authUser.kickUsername = normalizeStr(body.kickUsername || authUser.kickUsername);
    authUser.telegram = normalizeStr(body.telegram || authUser.telegram);
    authUser.shuffleNick = normalizeStr(body.shuffleNick || authUser.shuffleNick);
    authUser.updatedAt = nowIso();
    authUser.flags = detectFlags(db, authUser.id);

    addAudit(db, authUser.id, 'profile_updated', { flags: authUser.flags.map((f) => f.type) });
    writeDb(db);

    return sendJson(res, 200, {
      user: sanitizeUser(authUser),
      profileComplete: profileComplete(authUser),
      stats: userPredictionStats(db, authUser.id),
    });
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/points') {
    if (!authUser) return sendJson(res, 401, { error: 'Unauthorized' });

    const username = normalizeStr(reqUrl.searchParams.get('username') || authUser.kickUsername);
    if (!username) return sendJson(res, 400, { error: 'kick username is required' });

    try {
      const data = await pointsForUsername(username);
      return sendJson(res, 200, { username, ...data, source: 'botrix' });
    } catch (error) {
      return sendJson(res, 502, { error: 'Botrix unavailable', details: String(error.message || error) });
    }
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/leaderboard') {
    const range = monthRangeMoscow();
    const url = `${SHUFFLE_URL}?startTime=${range.startTime}&endTime=${range.endTime}`;
    try {
      const data = await fetchJson(url);
      const rows = (Array.isArray(data) ? data : [])
        .map((x) => ({ username: x.username || 'unknown', wagerAmount: Number(x.wagerAmount || 0) }))
        .sort((a, b) => b.wagerAmount - a.wagerAmount)
        .slice(0, 20)
        .map((x, idx) => ({ rank: idx + 1, username: x.username, masked: mask(x.username), wagerAmount: x.wagerAmount }));

      return sendJson(res, 200, { range, rows });
    } catch (error) {
      return sendJson(res, 502, { error: 'Shuffle unavailable', details: String(error.message || error) });
    }
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/giveaways') {
    return sendJson(res, 200, { rows: db.giveaways });
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/giveaways') {
    const perm = requirePermission(authUser, 'manage_giveaways');
    if (!perm.ok) return sendJson(res, perm.code, { error: perm.error });

    const body = await readBody(req);
    const title = normalizeStr(body.title);
    const pointsCost = Number(body.pointsCost || 0);
    if (!title) return sendJson(res, 400, { error: 'title is required' });

    const giveaway = {
      id: db.seq.giveaway++,
      title,
      pointsCost: Number.isFinite(pointsCost) ? Math.max(0, pointsCost) : 0,
      status: 'active',
      participants: [],
      createdAt: nowIso(),
      closedAt: null,
      winnerUserId: null,
    };

    db.giveaways.unshift(giveaway);
    addAudit(db, authUser.id, 'giveaway_created', { giveawayId: giveaway.id });
    writeDb(db);

    return sendJson(res, 201, { giveaway });
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/giveaways/join') {
    if (!authUser) return sendJson(res, 401, { error: 'Unauthorized' });
    if (authUser.banned) return sendJson(res, 403, { error: 'Banned user' });

    const body = await readBody(req);
    const giveawayId = Number(body.giveawayId);
    if (!Number.isFinite(giveawayId)) return sendJson(res, 400, { error: 'giveawayId is required' });

    const giveaway = db.giveaways.find((x) => x.id === giveawayId);
    if (!giveaway) return sendJson(res, 404, { error: 'Giveaway not found' });
    if (giveaway.status !== 'active') return sendJson(res, 409, { error: 'Giveaway closed' });
    if (!profileComplete(authUser)) return sendJson(res, 403, { error: 'Fill telegram and shuffle nick first' });
    if (giveaway.participants.includes(authUser.id)) return sendJson(res, 409, { error: 'Already joined' });

    let botrixWriteback = { ok: true, skipped: true };

    if (giveaway.pointsCost > 0) {
      if (!authUser.kickUsername) return sendJson(res, 400, { error: 'Kick username missing in profile' });

      try {
        const p = await pointsForUsername(authUser.kickUsername);
        if (p.points < giveaway.pointsCost) return sendJson(res, 409, { error: 'Not enough points' });
      } catch {
        return sendJson(res, 502, { error: 'Cannot verify points now' });
      }

      botrixWriteback = await subtractPointsBotrix({ username: authUser.kickUsername, points: giveaway.pointsCost });
      if (!botrixWriteback.ok && !botrixWriteback.skipped) {
        return sendJson(res, 502, { error: 'Points deduction failed', details: botrixWriteback.reason });
      }
    }

    giveaway.participants.push(authUser.id);
    addAudit(db, authUser.id, 'giveaway_joined', { giveawayId, pointsCost: giveaway.pointsCost, botrixWriteback });
    writeDb(db);

    return sendJson(res, 200, { ok: true, participants: giveaway.participants.length, botrixWriteback });
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/giveaways/close') {
    const perm = requirePermission(authUser, 'manage_giveaways');
    if (!perm.ok) return sendJson(res, perm.code, { error: perm.error });

    const body = await readBody(req);
    const giveawayId = Number(body.giveawayId);
    if (!Number.isFinite(giveawayId)) return sendJson(res, 400, { error: 'giveawayId is required' });

    const giveaway = db.giveaways.find((x) => x.id === giveawayId);
    if (!giveaway) return sendJson(res, 404, { error: 'Giveaway not found' });
    if (giveaway.status !== 'active') return sendJson(res, 409, { error: 'Already closed' });

    giveaway.status = 'closed';
    giveaway.closedAt = nowIso();
    if (giveaway.participants.length > 0) {
      giveaway.winnerUserId = giveaway.participants[Math.floor(Math.random() * giveaway.participants.length)];
    }

    addAudit(db, authUser.id, 'giveaway_closed', { giveawayId, winnerUserId: giveaway.winnerUserId });
    writeDb(db);

    return sendJson(res, 200, { giveaway });
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/predictions') {
    return sendJson(res, 200, { rows: db.predictions });
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/predictions') {
    const perm = requirePermission(authUser, 'manage_predictions');
    if (!perm.ok) return sendJson(res, perm.code, { error: perm.error });

    const body = await readBody(req);
    const title = normalizeStr(body.title);
    if (!title) return sendJson(res, 400, { error: 'title is required' });

    const prediction = {
      id: db.seq.prediction++,
      title,
      status: 'active',
      finalValue: null,
      entries: [],
      winnerUserId: null,
      createdAt: nowIso(),
      closedAt: null,
    };

    db.predictions.unshift(prediction);
    addAudit(db, authUser.id, 'prediction_created', { predictionId: prediction.id });
    writeDb(db);

    return sendJson(res, 201, { prediction });
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/predictions/submit') {
    if (!authUser) return sendJson(res, 401, { error: 'Unauthorized' });
    if (!profileComplete(authUser)) return sendJson(res, 403, { error: 'Fill telegram and shuffle nick first' });

    const body = await readBody(req);
    const predictionId = Number(body.predictionId);
    const value = Number(body.value);

    if (!Number.isFinite(predictionId) || !Number.isFinite(value)) {
      return sendJson(res, 400, { error: 'predictionId and value are required' });
    }

    const prediction = db.predictions.find((x) => x.id === predictionId);
    if (!prediction) return sendJson(res, 404, { error: 'Prediction not found' });
    if (prediction.status !== 'active') return sendJson(res, 409, { error: 'Prediction closed' });
    if (prediction.entries.some((x) => x.userId === authUser.id)) return sendJson(res, 409, { error: 'Already submitted' });

    prediction.entries.push({ userId: authUser.id, value, submittedAt: nowIso() });
    addAudit(db, authUser.id, 'prediction_submitted', { predictionId, value });
    writeDb(db);

    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/predictions/close') {
    const perm = requirePermission(authUser, 'manage_predictions');
    if (!perm.ok) return sendJson(res, perm.code, { error: perm.error });

    const body = await readBody(req);
    const predictionId = Number(body.predictionId);
    const finalValue = Number(body.finalValue);

    if (!Number.isFinite(predictionId) || !Number.isFinite(finalValue)) {
      return sendJson(res, 400, { error: 'predictionId and finalValue are required' });
    }

    const prediction = db.predictions.find((x) => x.id === predictionId);
    if (!prediction) return sendJson(res, 404, { error: 'Prediction not found' });
    if (prediction.status !== 'active') return sendJson(res, 409, { error: 'Already closed' });

    prediction.status = 'closed';
    prediction.finalValue = finalValue;
    prediction.closedAt = nowIso();

    if (prediction.entries.length > 0) {
      prediction.entries.sort((a, b) => {
        const deltaA = Math.abs(a.value - finalValue);
        const deltaB = Math.abs(b.value - finalValue);
        if (deltaA !== deltaB) return deltaA - deltaB;
        return new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime();
      });
      prediction.winnerUserId = prediction.entries[0].userId;
    }

    addAudit(db, authUser.id, 'prediction_closed', { predictionId, finalValue, winnerUserId: prediction.winnerUserId });
    writeDb(db);

    return sendJson(res, 200, { prediction });
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/support') {
    if (!authUser) return sendJson(res, 401, { error: 'Unauthorized' });

    const body = await readBody(req);
    const message = normalizeStr(body.message);
    if (!message) return sendJson(res, 400, { error: 'message is required' });

    const ticket = {
      id: db.seq.supportTicket++,
      userId: authUser.id,
      message,
      status: 'open',
      createdAt: nowIso(),
    };

    db.supportTickets.unshift(ticket);
    addAudit(db, authUser.id, 'support_created', { ticketId: ticket.id });
    writeDb(db);

    return sendJson(res, 201, { ticket });
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/support') {
    const perm = requirePermission(authUser, 'view_audit');
    if (!perm.ok) return sendJson(res, perm.code, { error: perm.error });
    return sendJson(res, 200, { rows: db.supportTickets.slice(0, 200) });
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/admin/flags') {
    const perm = requirePermission(authUser, 'review_flags');
    if (!perm.ok) return sendJson(res, perm.code, { error: perm.error });

    const rows = Object.values(db.users)
      .filter((u) => Array.isArray(u.flags) && u.flags.length > 0)
      .map((u) => ({ id: u.id, displayName: u.displayName, flags: u.flags }));

    return sendJson(res, 200, { rows });
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/admin/users') {
    const perm = requirePermission(authUser, 'manage_users');
    if (!perm.ok) return sendJson(res, perm.code, { error: perm.error });

    const rows = Object.values(db.users).map((u) => sanitizeUser(u));
    return sendJson(res, 200, { rows });
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/admin/users/update') {
    const perm = requirePermission(authUser, 'manage_users');
    if (!perm.ok) return sendJson(res, perm.code, { error: perm.error });

    const body = await readBody(req);
    const userId = normalizeStr(body.userId);
    if (!userId || !db.users[userId]) return sendJson(res, 404, { error: 'User not found' });

    const user = db.users[userId];
    const role = normalizeStr(body.role || user.role);
    const banned = Boolean(body.banned);
    const customPermissions = Array.isArray(body.customPermissions) ? body.customPermissions.map((x) => normalizeStr(x)).filter(Boolean) : user.customPermissions;

    if (!['user', 'admin', 'superadmin'].includes(role)) return sendJson(res, 400, { error: 'Invalid role' });

    user.role = role;
    user.banned = banned;
    user.customPermissions = customPermissions;
    user.updatedAt = nowIso();

    addAudit(db, authUser.id, 'admin_user_updated', { userId, role, banned, customPermissions });
    writeDb(db);

    return sendJson(res, 200, { user: sanitizeUser(user) });
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/admin/audit') {
    const perm = requirePermission(authUser, 'view_audit');
    if (!perm.ok) return sendJson(res, perm.code, { error: perm.error });
    return sendJson(res, 200, { rows: db.auditLogs.slice(0, 200) });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function serveStatic(reqUrl, res) {
  let pathname = reqUrl.pathname;
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.join(__dirname, 'public', pathname);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (reqUrl.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, reqUrl, res);
    } catch (error) {
      sendJson(res, 500, { error: 'Unhandled server error', details: String(error.message || error) });
    }
    return;
  }

  serveStatic(reqUrl, res);
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
