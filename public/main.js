const state = { user: null, permissions: [], config: null };

const $ = (id) => document.getElementById(id);
const has = (id) => Boolean($(id));

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    ...options,
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function setText(id, value) { if (has(id)) $(id).textContent = value; }
function setHtml(id, value) { if (has(id)) $(id).innerHTML = value; }

function renderPodium(rows = []) {
  ['podium1', 'podium2', 'podium3'].forEach((id, idx) => {
    if (!has(id)) return;
    const r = rows[idx];
    $(id).querySelector('h3').textContent = r ? r.masked : '—';
    $(id).querySelector('strong').textContent = r ? `$${Number(r.wagerAmount).toLocaleString('ru-RU')}` : '$0';
  });
}

function renderMonthRange(range) {
  if (!has('monthRangeOutput') || !range) return;
  const end = new Date(range.endTime * 1000).getTime();
  const now = Date.now();
  const delta = Math.max(0, end - now);
  const d = Math.floor(delta / (1000 * 60 * 60 * 24));
  const h = Math.floor((delta / (1000 * 60 * 60)) % 24);
  const m = Math.floor((delta / (1000 * 60)) % 60);
  setText('monthRangeOutput', `До конца гонки: ${d}д ${h}ч ${m}м`);
}

function canAdmin() {
  return state.permissions.includes('*') || state.permissions.includes('manage_giveaways') || state.permissions.includes('manage_predictions');
}
function canManageUsers() {
  return state.permissions.includes('*') || state.permissions.includes('manage_users');
}
function updateAdminVisibility() {
  document.querySelectorAll('.admin-only').forEach((n) => { n.style.display = canAdmin() ? '' : 'none'; });
}

function renderAuthInfo(extra = null) {
  if (!state.user) {
    setText('authOutput', 'Вы не авторизованы');
    setText('statsOutput', '');
    updateAdminVisibility();
    return;
  }

  setText('authOutput', `Вход: ${state.user.displayName} (${state.user.role})`);
  if (extra?.stats) {
    setText('statsOutput', `Predictions: ${extra.stats.totalPredictions}, wins: ${extra.stats.wonPredictions}, winRate: ${extra.stats.winRate}`);
  }

  if (has('kickUsername')) $('kickUsername').value = state.user.kickUsername || '';
  if (has('telegram')) $('telegram').value = state.user.telegram || '';
  if (has('shuffleNick')) $('shuffleNick').value = state.user.shuffleNick || '';

  updateAdminVisibility();
}

async function loadConfig() {
  state.config = await api('/api/config');
  if (has('shopLink')) $('shopLink').href = state.config.externalShopUrl;
  if (has('supportLink')) $('supportLink').href = state.config.supportUrl;
  if (has('supportLink2')) $('supportLink2').href = state.config.supportUrl;
}

async function loadMe() {
  try {
    const data = await api('/api/auth/me');
    state.user = data.user;
    state.permissions = data.permissions || [];
    renderAuthInfo(data);
    return data;
  } catch (error) {
    if (String(error.message).includes('401') || /unauthorized/i.test(error.message)) {
      state.user = null;
      state.permissions = [];
      renderAuthInfo();
      return null;
    }
    throw error;
  }
}

function prefillProviderFromQuery() {
  if (!has('provider')) return;
  const params = new URLSearchParams(window.location.search);
  const provider = params.get('provider');
  if (provider && ['kick', 'telegram'].includes(provider)) $('provider').value = provider;
}

async function quickLogin(provider) {
  if (!has('providerId') || !has('displayName')) return;
  $('provider').value = provider;
  const random = Math.floor(Math.random() * 1_000_000);
  $('providerId').value = `${provider}_${random}`;
  $('displayName').value = provider === 'kick' ? `KickUser${random}` : `TelegramUser${random}`;
  await login();
}

async function login() {
  const payload = {
    provider: $('provider').value,
    providerId: $('providerId').value.trim(),
    displayName: $('displayName').value.trim(),
  };
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
  await loadMe();
  await refreshAll();
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  state.user = null;
  state.permissions = [];
  renderAuthInfo();
  setText('pointsOutput', 'Войдите, чтобы посмотреть баланс.');
  setText('pointsInline', '—');
}

async function saveProfile() {
  if (!state.user) return setText('profileOutput', 'Сначала авторизуйтесь');
  const payload = {
    kickUsername: has('kickUsername') ? $('kickUsername').value.trim() : '',
    telegram: has('telegram') ? $('telegram').value.trim() : '',
    shuffleNick: has('shuffleNick') ? $('shuffleNick').value.trim() : '',
  };
  const data = await api('/api/profile', { method: 'POST', body: JSON.stringify(payload) });
  state.user = data.user;
  const flags = (state.user.flags || []).map((x) => x.type).join(', ') || 'нет';
  setText('profileOutput', `Профиль сохранён. complete=${data.profileComplete ? 'да' : 'нет'}. flags=${flags}`);
  renderAuthInfo(data);
}

async function refreshPoints() {
  if (!state.user) return setText('pointsOutput', 'Войдите, чтобы посмотреть баланс.');
  const username = has('kickUsername') ? $('kickUsername').value.trim() || state.user.kickUsername : state.user.kickUsername;
  if (!username) return setText('pointsOutput', 'Укажите kick username в профиле');

  setText('pointsOutput', 'Обновляем...');
  try {
    const data = await api(`/api/points?username=${encodeURIComponent(username)}`);
    setText('pointsOutput', `Баланс ${data.username}: ${data.points}`);
    setText('pointsInline', data.points);
  } catch (error) {
    setText('pointsOutput', `Ошибка: ${error.message}`);
  }
}

async function loadLeaderboard() {
  if (!has('leaderboardBody')) return;
  setHtml('leaderboardBody', '<tr><td colspan="3">Загрузка...</td></tr>');
  try {
    const data = await api('/api/leaderboard');
    renderPodium(data.rows || []);
    renderMonthRange(data.range);
    setHtml('leaderboardBody', (data.rows || []).map((r) => `<tr><td>${r.rank}</td><td>${r.masked}</td><td>${Number(r.wagerAmount).toLocaleString('ru-RU')}</td></tr>`).join('') || '<tr><td colspan="3">Нет данных</td></tr>');
  } catch (e) {
    setHtml('leaderboardBody', `<tr><td colspan="3">Ошибка: ${e.message}</td></tr>`);
  }
}

async function loadGiveaways() {
  if (!has('giveawayList')) return;
  const data = await api('/api/giveaways');
  const rows = data.rows || [];
  setHtml('giveawayList', rows.map((g) => `<li><strong>#${g.id}</strong> ${g.title} • ${g.status} • вход: ${g.pointsCost} • участников: ${g.participants.length}${g.winnerUserId ? ` • победитель=${g.winnerUserId}` : ''}</li>`).join('') || '<li>Пока нет розыгрышей</li>');
  setText('activeGiveaways', rows.filter((r) => r.status === 'active').length);
  setText('giveawayParticipants', rows.reduce((a, r) => a + (r.participants?.length || 0), 0));
}

async function createGiveaway() {
  const payload = { title: $('gTitle').value.trim(), pointsCost: Number($('gCost').value || 0) };
  const data = await api('/api/giveaways', { method: 'POST', body: JSON.stringify(payload) });
  setText('giveawayOutput', `Создан розыгрыш #${data.giveaway.id}`);
  await loadGiveaways();
}
async function joinGiveaway() {
  const payload = { giveawayId: Number($('gJoinId').value) };
  const data = await api('/api/giveaways/join', { method: 'POST', body: JSON.stringify(payload) });
  setText('giveawayOutput', `Участие подтверждено. Всего=${data.participants}`);
  await Promise.all([loadGiveaways(), refreshPoints()]);
}
async function closeGiveaway() {
  const payload = { giveawayId: Number($('gJoinId').value) };
  const data = await api('/api/giveaways/close', { method: 'POST', body: JSON.stringify(payload) });
  setText('giveawayOutput', `Закрыт. Победитель: ${data.giveaway.winnerUserId || 'нет'}`);
  await loadGiveaways();
}

async function loadPredictions() {
  if (!has('predictionList')) return;
  const data = await api('/api/predictions');
  const rows = data.rows || [];
  setHtml('predictionList', rows.map((p) => `<li><strong>#${p.id}</strong> ${p.title} • ${p.status} • прогнозов: ${p.entries.length}${p.winnerUserId ? ` • победитель=${p.winnerUserId}` : ''}</li>`).join('') || '<li>Пока нет активностей</li>');
  setText('activePredictions', rows.filter((r) => r.status === 'active').length);
}
async function createPrediction() { const data = await api('/api/predictions', { method: 'POST', body: JSON.stringify({ title: $('pTitle').value.trim() }) }); setText('predictionOutput', `Создан #${data.prediction.id}`); await loadPredictions(); }
async function submitPrediction() { await api('/api/predictions/submit', { method: 'POST', body: JSON.stringify({ predictionId: Number($('pId').value), value: Number($('pValue').value) }) }); setText('predictionOutput', 'Прогноз отправлен'); await loadPredictions(); }
async function closePrediction() { const data = await api('/api/predictions/close', { method: 'POST', body: JSON.stringify({ predictionId: Number($('pCloseId').value), finalValue: Number($('pFinal').value) }) }); setText('predictionOutput', `Закрыт. Победитель: ${data.prediction.winnerUserId || 'нет'}`); await loadPredictions(); }

async function createTicket() {
  const message = $('supportMessage').value.trim();
  if (!message) return setText('supportOutput', 'Введите текст обращения');
  const data = await api('/api/support', { method: 'POST', body: JSON.stringify({ message }) });
  setText('supportOutput', `Тикет #${data.ticket.id} создан`);
  $('supportMessage').value = '';
}

async function loadFlags() { if (!canAdmin() || !has('flagsList')) return; const data = await api('/api/admin/flags'); setHtml('flagsList', data.rows.map((u) => `<li>${u.id}: ${u.flags.map((f) => f.type).join(', ')}</li>`).join('') || '<li>Нет флагов</li>'); }
async function loadUsers() { if (!has('usersList')) return; if (!canManageUsers()) return setHtml('usersList', '<li>Нет permission manage_users</li>'); const data = await api('/api/admin/users'); setHtml('usersList', data.rows.map((u) => `<li>${u.id} | ${u.role} | banned=${u.banned}</li>`).join('') || '<li>Нет пользователей</li>'); }
async function updateUser() { if (!canManageUsers()) return setText('adminOutput', 'Нет permission manage_users'); const payload = { userId: $('adminUserId').value.trim(), role: $('adminRole').value, banned: $('adminBanned').checked, customPermissions: $('adminPerms').value.split(',').map((x) => x.trim()).filter(Boolean) }; const data = await api('/api/admin/users/update', { method: 'POST', body: JSON.stringify(payload) }); setText('adminOutput', `Пользователь ${data.user.id} обновлён`); await loadUsers(); }
async function loadAudit() { if (!canAdmin() || !has('auditList')) return; const data = await api('/api/admin/audit'); setHtml('auditList', data.rows.map((r) => `<li>${r.at} | ${r.actor} | ${r.action}</li>`).join('') || '<li>Пусто</li>'); }
async function loadTickets() { if (!canAdmin() || !has('ticketsList')) return; const data = await api('/api/support'); setHtml('ticketsList', data.rows.map((t) => `<li>#${t.id} ${t.userId}: ${t.message}</li>`).join('') || '<li>Пусто</li>'); }

async function refreshAll() {
  await Promise.allSettled([loadLeaderboard(), loadGiveaways(), loadPredictions(), loadFlags(), loadUsers(), loadAudit(), loadTickets(), refreshPoints()]);
}

function bind(id, event, handler, failTarget) {
  if (!has(id)) return;
  $(id).addEventListener(event, () => handler().catch((e) => { if (failTarget) setText(failTarget, e.message); }));
}

function bindEvents() {
  bind('loginBtn', 'click', login, 'authOutput');
  bind('logoutBtn', 'click', logout, 'authOutput');
  bind('saveProfile', 'click', saveProfile, 'profileOutput');
  bind('refreshPoints', 'click', refreshPoints, 'pointsOutput');
  bind('reloadLeaderboard', 'click', loadLeaderboard);

  bind('quickKickLogin', 'click', () => quickLogin('kick'), 'authOutput');
  bind('quickTelegramLogin', 'click', () => quickLogin('telegram'), 'authOutput');

  bind('createGiveaway', 'click', createGiveaway, 'giveawayOutput');
  bind('joinGiveaway', 'click', joinGiveaway, 'giveawayOutput');
  bind('closeGiveaway', 'click', closeGiveaway, 'giveawayOutput');

  bind('createPrediction', 'click', createPrediction, 'predictionOutput');
  bind('submitPrediction', 'click', submitPrediction, 'predictionOutput');
  bind('closePrediction', 'click', closePrediction, 'predictionOutput');

  bind('createTicket', 'click', createTicket, 'supportOutput');

  bind('reloadFlags', 'click', loadFlags);
  bind('reloadAudit', 'click', loadAudit);
  bind('reloadUsers', 'click', loadUsers);
  bind('reloadTickets', 'click', loadTickets);
  bind('updateUser', 'click', updateUser, 'adminOutput');

  if (has('ageYes')) $('ageYes').addEventListener('click', () => { localStorage.setItem('ageVerified', '1'); $('ageGate').classList.add('hidden'); });
  if (has('ageNo')) $('ageNo').addEventListener('click', () => { window.location.href = 'https://t.me/casino_alex'; });
}

async function bootstrap() {
  bindEvents();
  prefillProviderFromQuery();
  if (has('ageGate') && localStorage.getItem('ageVerified') === '1') $('ageGate').classList.add('hidden');
  await loadConfig();
  await loadMe();
  await refreshAll();
  setInterval(() => loadLeaderboard().catch(() => {}), 60 * 1000);
}

bootstrap().catch((e) => {
  console.error(e);
  setText('authOutput', 'Ошибка инициализации');
});
