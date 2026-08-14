const dashboardState = {
  data: null,
  doneOverrides: readJsonStorage('opportunity-cloud-done', {}),
  filters: { search: '', status: 'all', programme: 'all', source: 'all' }
};

const elements = {};

function readJsonStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || '') || fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''), window.location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
  } catch {
    return '#';
  }
}

function formatDate(value) {
  if (!value) return 'Not confirmed';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric'
  }).format(new Date(year, month - 1, day));
}

function formatTimestamp(value) {
  if (!value) return 'No completed cloud scan yet';
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function isDone(opportunity) {
  if (Object.hasOwn(dashboardState.doneOverrides, opportunity.id)) {
    return dashboardState.doneOverrides[opportunity.id];
  }
  return Boolean(opportunity.initialDone);
}

function effectiveStatus(opportunity) {
  return isDone(opportunity) ? 'Done' : opportunity.status;
}

function statusKey(status) {
  if (status === 'Deadline unknown') return 'unknown';
  return String(status || '').toLowerCase();
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 2 } });
}

function deadlineDetail(opportunity, status) {
  if (status === 'Done') return 'Marked done on this device';
  if (status === 'Deadline unknown') return 'Confirm the deadline on the source page';
  if (status === 'Closed') return 'Confirmed deadline passed';
  if (opportunity.daysRemaining === 0) return 'Closes today';
  if (opportunity.daysRemaining === 1) return '1 day remaining';
  return `${opportunity.daysRemaining} days remaining`;
}

function renderStats() {
  const opportunities = dashboardState.data.opportunities || [];
  const open = opportunities.filter((item) => effectiveStatus(item) === 'Open').length;
  const done = opportunities.filter((item) => effectiveStatus(item) === 'Done').length;
  const next = opportunities.find((item) => effectiveStatus(item) === 'Open');
  const stats = dashboardState.data.stats || {};
  const telegram = dashboardState.data.alerts?.telegramConfigured ? 'Telegram active' : 'Telegram not connected';
  elements.statGrid.innerHTML = `
    <article class="stat-card open">
      <span class="stat-label">Open now</span>
      <strong>${open}</strong>
      <span>${next ? `${escapeHtml(formatDate(next.deadline))} - ${escapeHtml(next.title)}` : 'No future deadline found'}</span>
    </article>
    <article class="stat-card sources">
      <span class="stat-label">Healthy sources</span>
      <strong>${Number(stats.healthySources || 0)}/${Number(stats.sources || 0)}</strong>
      <span>${escapeHtml(telegram)}</span>
    </article>
    <article class="stat-card deadline">
      <span class="stat-label">Deadline unknown</span>
      <strong>${opportunities.filter((item) => effectiveStatus(item) === 'Deadline unknown').length}</strong>
      <span>Never guessed; verify these on the source</span>
    </article>
    <article class="stat-card done">
      <span class="stat-label">Done</span>
      <strong>${done}</strong>
      <span>Saved privately in this browser</span>
    </article>
  `;
}

function renderOpportunityCard(opportunity) {
  const status = effectiveStatus(opportunity);
  const statusClass = statusKey(status);
  const confidence = opportunity.confidence?.score == null
    ? opportunity.confidence?.level || 'Saved'
    : `${opportunity.confidence.level} ${opportunity.confidence.score}`;
  const additional = opportunity.additionalNames?.length
    ? `<p class="additional-names">Also listed: ${escapeHtml(opportunity.additionalNames.join('; '))}</p>`
    : '';
  const summary = opportunity.summary
    ? `<p class="summary">${escapeHtml(opportunity.summary)}</p>`
    : '';
  const focuses = (opportunity.focuses || [])
    .map((focus) => `<span class="focus-chip">${escapeHtml(focus)}</span>`)
    .join('');
  const done = status === 'Done';
  const primaryUrl = safeUrl(opportunity.primaryUrl);
  return `
    <article class="opportunity-card ${escapeHtml(statusClass)}" data-id="${escapeHtml(opportunity.id)}">
      <div class="card-body">
        <div class="card-topline">
          <span class="status-badge ${escapeHtml(statusClass)}">${escapeHtml(status)}</span>
          <span class="confidence-badge">${escapeHtml(confidence)}</span>
        </div>
        <p class="source-label">${escapeHtml(opportunity.siteName)} · ${escapeHtml(opportunity.sourceType)}</p>
        <h3><a class="opportunity-title" href="${escapeHtml(primaryUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(opportunity.title)}</a></h3>
        ${additional}
        ${opportunity.announcementTitle && opportunity.announcementTitle !== opportunity.title
          ? `<p class="announcement-title">${escapeHtml(opportunity.announcementTitle)}</p>`
          : ''}
        ${summary}
        <div class="badge-row">${focuses}</div>
        <div class="deadline-block">
          <span>Deadline</span>
          <strong>${escapeHtml(formatDate(opportunity.deadline))}</strong>
          <small>${escapeHtml(deadlineDetail(opportunity, status))}</small>
        </div>
      </div>
      <div class="card-actions">
        <a class="link-button" href="${escapeHtml(primaryUrl)}" target="_blank" rel="noopener noreferrer">
          <i data-lucide="external-link" aria-hidden="true"></i>
          <span>${opportunity.officialUrl ? 'Official page' : 'Open opportunity'}</span>
        </a>
        <button class="done-button ${done ? 'is-done' : ''}" type="button" data-done-id="${escapeHtml(opportunity.id)}">
          <i data-lucide="${done ? 'rotate-ccw' : 'check'}" aria-hidden="true"></i>
          <span>${done ? 'Undo' : 'Done'}</span>
        </button>
      </div>
    </article>
  `;
}

function matchesFilters(opportunity) {
  const status = statusKey(effectiveStatus(opportunity));
  const type = opportunity.programmeType.toLowerCase().includes('licence') ? 'licence' : 'master';
  const source = String(opportunity.sourceType || '').toLowerCase();
  const searchText = [
    opportunity.title,
    opportunity.additionalNames?.join(' '),
    opportunity.announcementTitle,
    opportunity.siteName,
    opportunity.focuses?.join(' ')
  ].join(' ').toLowerCase();
  return (
    (!dashboardState.filters.search || searchText.includes(dashboardState.filters.search)) &&
    (dashboardState.filters.status === 'all' || status === dashboardState.filters.status) &&
    (dashboardState.filters.programme === 'all' || type === dashboardState.filters.programme) &&
    (dashboardState.filters.source === 'all' || source === dashboardState.filters.source)
  );
}

function renderOpportunities() {
  const visible = (dashboardState.data.opportunities || []).filter(matchesFilters);
  elements.visibleCount.textContent = String(visible.length);
  elements.opportunityGrid.innerHTML = visible.length
    ? visible.map(renderOpportunityCard).join('')
    : '<div class="empty-state">No opportunities match these filters.</div>';
  refreshIcons();
}

function renderSources() {
  const sources = dashboardState.data.sources || [];
  elements.sourceHealthTotal.textContent = `${sources.filter((item) => item.status === 'ok').length}/${sources.length} healthy`;
  elements.sourceList.innerHTML = sources.length
    ? sources.map((source) => `
      <div class="source-row">
        <a href="${escapeHtml(safeUrl(source.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.name)}</a>
        <span class="health-dot ${source.status === 'ok' ? '' : 'error'}" title="${source.status === 'ok' ? 'Healthy' : 'Check error'}"></span>
        <span class="source-meta">${Number(source.matches || 0)} matches · ${escapeHtml(formatDuration(source.durationMs))}</span>
      </div>
    `).join('')
    : '<div class="empty-state">Source health will appear after the first cloud scan.</div>';
}

function renderRuns() {
  const runs = dashboardState.data.runs || [];
  elements.runList.innerHTML = runs.length
    ? runs.slice(0, 6).map((run) => {
      const hasErrors = run.status !== 'completed';
      return `
        <div class="run-row">
          <strong class="${hasErrors ? 'error' : ''}">${hasErrors ? 'Review' : 'Complete'}</strong>
          <span>${escapeHtml(formatTimestamp(run.completedAt))}</span>
          <small>${Number(run.sitesChecked || 0)} sites · ${Number(run.matchesFound || 0)} matches · ${Number(run.newOpportunities || 0)} new · ${escapeHtml(formatDuration(run.durationMs))}</small>
        </div>
      `;
    }).join('')
    : '<div class="empty-state">No scan history yet.</div>';
}

function renderDashboard() {
  const data = dashboardState.data;
  elements.cycleChip.textContent = `${data.targetCycle} cycle`;
  elements.cloudStatus.textContent = data.lastScan?.status === 'completed'
    ? 'Cloud monitor healthy'
    : data.lastScan
      ? 'Cloud monitor completed with warnings'
      : 'Cloud website ready';
  elements.lastUpdated.textContent = `Last scan: ${formatTimestamp(data.lastScan?.completedAt)}`;
  renderStats();
  renderOpportunities();
  renderSources();
  renderRuns();
  refreshIcons();
}

async function loadDashboard() {
  elements.refreshButton.disabled = true;
  elements.cloudStatus.textContent = 'Refreshing published data...';
  try {
    const response = await fetch(`./data/dashboard.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    dashboardState.data = await response.json();
    renderDashboard();
  } catch (error) {
    elements.cloudStatus.textContent = 'Could not load published opportunities';
    elements.lastUpdated.textContent = String(error.message || error);
    elements.opportunityGrid.innerHTML = '<div class="empty-state">The cloud data is temporarily unavailable. Refresh this page in a moment.</div>';
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function bindFilters() {
  elements.searchInput.addEventListener('input', () => {
    dashboardState.filters.search = elements.searchInput.value.trim().toLowerCase();
    renderOpportunities();
  });
  for (const [element, key] of [
    [elements.statusFilter, 'status'],
    [elements.programmeFilter, 'programme'],
    [elements.sourceFilter, 'source']
  ]) {
    element.addEventListener('change', () => {
      dashboardState.filters[key] = element.value;
      renderOpportunities();
    });
  }
  elements.clearFilters.addEventListener('click', () => {
    dashboardState.filters = { search: '', status: 'all', programme: 'all', source: 'all' };
    elements.searchInput.value = '';
    elements.statusFilter.value = 'all';
    elements.programmeFilter.value = 'all';
    elements.sourceFilter.value = 'all';
    renderOpportunities();
  });
}

function bindDoneButtons() {
  elements.opportunityGrid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-done-id]');
    if (!button || !dashboardState.data) return;
    const opportunity = dashboardState.data.opportunities.find((item) => item.id === button.dataset.doneId);
    if (!opportunity) return;
    dashboardState.doneOverrides[opportunity.id] = !isDone(opportunity);
    localStorage.setItem('opportunity-cloud-done', JSON.stringify(dashboardState.doneOverrides));
    renderStats();
    renderOpportunities();
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const isDark = theme === 'dark';
  elements.themeButton.setAttribute('aria-pressed', String(isDark));
  elements.themeLabel.textContent = isDark ? 'Light' : 'Dark';
  elements.themeButton.querySelector('i, svg')?.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
  localStorage.setItem('opportunity-cloud-theme', theme);
  refreshIcons();
}

document.addEventListener('DOMContentLoaded', () => {
  for (const id of [
    'refreshButton', 'themeButton', 'themeLabel', 'cloudStatus', 'lastUpdated', 'cycleChip',
    'statGrid', 'visibleCount', 'searchInput', 'statusFilter', 'programmeFilter', 'sourceFilter',
    'clearFilters', 'opportunityGrid', 'sourceHealthTotal', 'sourceList', 'runList'
  ]) {
    elements[id] = document.getElementById(id);
  }

  applyTheme(localStorage.getItem('opportunity-cloud-theme') || 'dark');
  elements.themeButton.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  elements.refreshButton.addEventListener('click', loadDashboard);
  bindFilters();
  bindDoneButtons();
  loadDashboard();
});
