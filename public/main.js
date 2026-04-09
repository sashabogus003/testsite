const state = {
  user: null,
  permissions: [],
  config: null,
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    ...options,
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function setText(id, value) {
  $(id).textContent = value;
}

function canAdmin() {
  return state.permissions.includes('*') || state.permissions.includes('manage_giveaways') || state.permissions.includes('manage_predictions');
}

function canManageUsers() {
  return state.permissions.includes('*') || state.permissions.includes('manage_users');
}

function updateAdminVisibility() {
  const visible = canAdmin();
  document.querySelectorAll('.admin-only').forEach((node) => {
    node.style.display = visible ? '' : 'none';
  });
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

  $('kickUsername').value = state.user.kickUsername || '';
  $('telegram').value = state.user.telegram || '';
  $('shuffleNick').value = state.user.shuffleNick || '';
  updateAdminVisibility();
}

async function loadConfig() {
  state.config = await api('/api/config');
  $('shopLink').href = state.config.externalShopUrl;
  $('supportLink').href = state.config.supportUrl;
}

async function loadMe() {
  const data = await api('/api/auth/me');
  state.user = data.user;
  state.permissions = data.permissions || [];
  renderAuthInfo(data);
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
}

async function saveProfile() {
  if (!state.user) return setText('profileOutput', 'Сначала авторизуйтесь');

  const payload = {
    kickUsername: $('kickUsername').value.trim(),
    telegram: $('telegram').value.trim(),
    shuffleNick: $('shuffleNick').value.trim(),
  };

  const data = await api('/api/profile', { method: 'POST', body: JSON.stringify(payload) });
  state.user = data.user;

  const flags = (state.user.flags || []).map((x) => x.type).join(', ') || 'нет';
  setText('profileOutput', `Профиль сохранён. complete=${data.profileComplete ? 'да' : 'нет'}. flags=${flags}`);
  renderAuthInfo(data);
}

async function refreshPoints() {
  if (!state.user) return setText('pointsOutput', 'Войдите, чтобы посмотреть баланс.');
  const username = $('kickUsername').value.trim() || state.user.kickUsername;
  if (!username) return setText('pointsOutput', 'Укажите kick username');

  setText('pointsOutput', 'Обновляем...');
  try {
    const data = await api(`/api/points?username=${encodeURIComponent(username)}`);
    setText('pointsOutput', `Баланс ${data.username}: ${data.points}`);
  } catch (error) {
    setText('pointsOutput', `Ошибка: ${error.message}`);
  }
}

async function loadLeaderboard() {
  const body = $('leaderboardBody');
  body.innerHTML = '<tr><td colspan="3">Загрузка...</td></tr>';

  try {
    const data = await api('/api/leaderboard');
    body.innerHTML = data.rows.map((row) => `<tr><td>${row.rank}</td><td>${row.masked}</td><td>${row.wagerAmount.toLocaleString('ru-RU')}</td></tr>`).join('') || '<tr><td colspan="3">Нет данных</td></tr>';
  } catch (error) {
    body.innerHTML = `<tr><td colspan="3">Ошибка: ${error.message}</td></tr>`;
  }
}

async function loadGiveaways() {
  const data = await api('/api/giveaways');
  $('giveawayList').innerHTML = data.rows.map((g) => `<li>#${g.id} ${g.title} | ${g.status} | cost=${g.pointsCost} | users=${g.participants.length}${g.winnerUserId ? ` | winner=${g.winnerUserId}` : ''}</li>`).join('') || '<li>Пусто</li>';
}

async function createGiveaway() {
  const payload = { title: $('gTitle').value.trim(), pointsCost: Number($('gCost').value || 0) };
  const data = await api('/api/giveaways', { method: 'POST', body: JSON.stringify(payload) });
  setText('giveawayOutput', `Создан #${data.giveaway.id}`);
  await loadGiveaways();
}

async function joinGiveaway() {
  const payload = { giveawayId: Number($('gJoinId').value) };
  const data = await api('/api/giveaways/join', { method: 'POST', body: JSON.stringify(payload) });
  const writeback = data.botrixWriteback?.skipped ? ' (writeback skipped)' : '';
  setText('giveawayOutput', `Участие подтверждено. Всего=${data.participants}${writeback}`);
  await Promise.all([loadGiveaways(), refreshPoints()]);
}

async function closeGiveaway() {
  const payload = { giveawayId: Number($('gJoinId').value) };
  const data = await api('/api/giveaways/close', { method: 'POST', body: JSON.stringify(payload) });
  setText('giveawayOutput', `Закрыт. Победитель: ${data.giveaway.winnerUserId || 'нет'}`);
  await loadGiveaways();
}

async function loadPredictions() {
  const data = await api('/api/predictions');
  $('predictionList').innerHTML = data.rows.map((p) => `<li>#${p.id} ${p.title} | ${p.status} | entries=${p.entries.length}${p.winnerUserId ? ` | winner=${p.winnerUserId}` : ''}</li>`).join('') || '<li>Пусто</li>';
}

async function createPrediction() {
  const payload = { title: $('pTitle').value.trim() };
  const data = await api('/api/predictions', { method: 'POST', body: JSON.stringify(payload) });
  setText('predictionOutput', `Создан #${data.prediction.id}`);
  await loadPredictions();
}

async function submitPrediction() {
  const payload = { predictionId: Number($('pId').value), value: Number($('pValue').value) };
  await api('/api/predictions/submit', { method: 'POST', body: JSON.stringify(payload) });
  setText('predictionOutput', 'Прогноз отправлен');
  await loadPredictions();
}

async function closePrediction() {
  const payload = { predictionId: Number($('pCloseId').value), finalValue: Number($('pFinal').value) };
  const data = await api('/api/predictions/close', { method: 'POST', body: JSON.stringify(payload) });
  setText('predictionOutput', `Закрыт. Победитель: ${data.prediction.winnerUserId || 'нет'}`);
  await loadPredictions();
}

async function createTicket() {
  const payload = { message: $('supportMessage').value.trim() };
  const data = await api('/api/support', { method: 'POST', body: JSON.stringify(payload) });
  setText('supportOutput', `Тикет #${data.ticket.id} создан`);
  $('supportMessage').value = '';
}

async function loadFlags() {
  if (!canAdmin()) return;
  const data = await api('/api/admin/flags');
  $('flagsList').innerHTML = data.rows.map((u) => `<li>${u.id}: ${u.flags.map((f) => f.type).join(', ')}</li>`).join('') || '<li>Нет флагов</li>';
}

async function loadUsers() {
  if (!canManageUsers()) {
    $('usersList').innerHTML = '<li>Нет permission manage_users</li>';
    return;
  }

  const data = await api('/api/admin/users');
  $('usersList').innerHTML = data.rows.map((u) => `<li>${u.id} | ${u.role} | banned=${u.banned} | perms=${(u.customPermissions || []).join(',')}</li>`).join('') || '<li>Нет пользователей</li>';
}

async function updateUser() {
  if (!canManageUsers()) return setText('adminOutput', 'Нет permission manage_users');

  const payload = {
    userId: $('adminUserId').value.trim(),
    role: $('adminRole').value,
    banned: $('adminBanned').checked,
    customPermissions: $('adminPerms').value.split(',').map((x) => x.trim()).filter(Boolean),
  };

  const data = await api('/api/admin/users/update', { method: 'POST', body: JSON.stringify(payload) });
  setText('adminOutput', `Пользователь ${data.user.id} обновлён`);
  await loadUsers();
}

async function loadAudit() {
  if (!canAdmin()) return;
  const data = await api('/api/admin/audit');
  $('auditList').innerHTML = data.rows.map((row) => `<li>${row.at} | ${row.actor} | ${row.action}</li>`).join('') || '<li>Пусто</li>';
}

async function loadTickets() {
  if (!canAdmin()) return;
  const data = await api('/api/support');
  $('ticketsList').innerHTML = data.rows.map((t) => `<li>#${t.id} ${t.userId}: ${t.message} (${t.status})</li>`).join('') || '<li>Пусто</li>';
}

async function refreshAll() {
  await Promise.all([
    loadLeaderboard(),
    loadGiveaways(),
    loadPredictions(),
    loadFlags().catch(() => {}),
    loadUsers().catch(() => {}),
    loadAudit().catch(() => {}),
    loadTickets().catch(() => {}),
  ]);
}

function bindEvents() {
  $('ageYes').addEventListener('click', () => {
    localStorage.setItem('ageVerified', '1');
    $('ageGate').classList.add('hidden');
  });

  $('ageNo').addEventListener('click', () => {
    window.location.href = 'https://t.me/casino_alex';
  });

  $('loginBtn').addEventListener('click', () => login().catch((e) => setText('authOutput', e.message)));
  $('logoutBtn').addEventListener('click', () => logout().catch((e) => setText('authOutput', e.message)));

  $('saveProfile').addEventListener('click', () => saveProfile().catch((e) => setText('profileOutput', e.message)));
  $('refreshPoints').addEventListener('click', () => refreshPoints());
  $('reloadLeaderboard').addEventListener('click', () => loadLeaderboard());

  $('createGiveaway').addEventListener('click', () => createGiveaway().catch((e) => setText('giveawayOutput', e.message)));
  $('joinGiveaway').addEventListener('click', () => joinGiveaway().catch((e) => setText('giveawayOutput', e.message)));
  $('closeGiveaway').addEventListener('click', () => closeGiveaway().catch((e) => setText('giveawayOutput', e.message)));

  $('createPrediction').addEventListener('click', () => createPrediction().catch((e) => setText('predictionOutput', e.message)));
  $('submitPrediction').addEventListener('click', () => submitPrediction().catch((e) => setText('predictionOutput', e.message)));
  $('closePrediction').addEventListener('click', () => closePrediction().catch((e) => setText('predictionOutput', e.message)));

  $('createTicket').addEventListener('click', () => createTicket().catch((e) => setText('supportOutput', e.message)));

  $('reloadFlags').addEventListener('click', () => loadFlags().catch((e) => { $('flagsList').innerHTML = `<li>${e.message}</li>`; }));
  $('reloadAudit').addEventListener('click', () => loadAudit().catch((e) => { $('auditList').innerHTML = `<li>${e.message}</li>`; }));
  $('reloadUsers').addEventListener('click', () => loadUsers().catch((e) => { $('usersList').innerHTML = `<li>${e.message}</li>`; }));
  $('reloadTickets').addEventListener('click', () => loadTickets().catch((e) => { $('ticketsList').innerHTML = `<li>${e.message}</li>`; }));
  $('updateUser').addEventListener('click', () => updateUser().catch((e) => setText('adminOutput', e.message)));
}

async function bootstrap() {
  bindEvents();

  if (localStorage.getItem('ageVerified') === '1') {
    $('ageGate').classList.add('hidden');
  }

  await loadConfig();
  await loadMe();
  await refreshAll();

  setInterval(() => refreshPoints().catch(() => {}), 60 * 1000);
  setInterval(() => loadLeaderboard().catch(() => {}), 60 * 1000);
}

bootstrap().catch((error) => {
  console.error(error);
  setText('authOutput', 'Ошибка инициализации');
});
