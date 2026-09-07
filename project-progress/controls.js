(() => {
  const data = JSON.parse(document.getElementById('progress-data').textContent);
  const $ = id => document.getElementById(id);
  const body = document.querySelector('tbody');
  const table = document.querySelector('table');
  const wrap = document.querySelector('.table-wrap');
  const fields = ['search', 'status', 'phase', 'sort'];
  let view = 'remaining', descending = false, pages = [], page = 0, matches = [], printing = false;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const rows = items => items.map(i => '<tr data-id="' + escape(i.id) + '"><th scope="row">' + escape(i.title) + '<small>' + escape(i.phase) + '</small></th><td><span class="badge ' + (i.status === 'Complete' ? 'complete' : ['Partial', 'In Progress'].includes(i.status) ? 'partial' : 'unknown') + '">' + escape(i.status) + '</span></td><td>' + escape(i.dateLabel) + '</td><td>' + escape(i.notes) + ' <a href="' + escape(i.evidence) + '">Evidence ↗</a></td></tr>').join('');
  const source = () => data.items.filter(i => (i.status === 'Complete') === (view === 'completed'));
  const phases = [...new Set(data.items.map(i => i.phase))];
  const statuses = ['In Progress', 'Partial', 'Blocked', 'Pending', 'Unverified', 'Not Started', 'Complete'];
  const statusOption = (value, text) => '<option value="' + escape(value) + '">' + escape(text) + '</option>';
  function options() {
    $('status').innerHTML = statusOption('', 'All statuses') + [...new Set(source().map(i => i.status))].map(s => statusOption(s, s)).join('');
    $('phase').innerHTML = statusOption('', 'All milestones') + [...new Set(source().map(i => i.phase))].map(s => statusOption(s, s)).join('');
  }
  function sorted() {
    const search = $('search').value.trim().toLowerCase();
    const items = source().filter(i => (!$('status').value || i.status === $('status').value) && (!$('phase').value || i.phase === $('phase').value) && (!search || [i.title, i.notes, i.phase, i.status, i.dateLabel].join(' ').toLowerCase().includes(search)));
    const key = $('sort').value, dir = descending ? -1 : 1;
    return items.sort((a,b) => {
      let delta = 0;
      if (key === 'title') delta = a.title.localeCompare(b.title);
      if (key === 'status') delta = statuses.indexOf(a.status) - statuses.indexOf(b.status);
      if (key === 'phase') delta = phases.indexOf(a.phase) - phases.indexOf(b.phase);
      if (key === 'date') {
        const ad = a.actualDate || a.plannedDate, bd = b.actualDate || b.plannedDate;
        if (!ad && bd) return 1;
        if (ad && !bd) return -1;
        delta = (ad || '').localeCompare(bd || '');
      }
      if (key === 'order') delta = data.items.indexOf(a) - data.items.indexOf(b);
      return delta * dir || data.items.indexOf(a) - data.items.indexOf(b);
    });
  }
  function showPage() {
    page = Math.min(page, Math.max(0, pages.length - 1));
    body.innerHTML = rows(pages[page] || []);
    $('empty').hidden = matches.length > 0;
    const start = pages.slice(0, page).reduce((sum, p) => sum + p.length, 0);
    $('page-status').textContent = matches.length ? (start + 1) + '–' + (start + pages[page].length) + ' of ' + matches.length + ' · Page ' + (page + 1) + ' / ' + pages.length : '0 matching items';
    $('previous').disabled = page === 0;
    $('next').disabled = page >= pages.length - 1;
  }
  function paginate(reset = false) {
    if (printing || view === 'maintenance') return;
    if (reset) page = 0;
    matches = sorted();
    pages = [];
    body.innerHTML = '';
    let current = [];
    // Fit complete rows to the available region; reserve horizontal scrollbar space.
    const available = wrap.clientHeight - (table.scrollWidth > wrap.clientWidth ? 18 : 2);
    for (const item of matches) {
      body.insertAdjacentHTML('beforeend', rows([item]));
      if (table.offsetHeight > available && current.length) {
        pages.push(current);
        current = [item];
        body.innerHTML = rows(current);
      } else current.push(item);
    }
    if (current.length) pages.push(current);
    showPage();
    document.querySelectorAll('th[data-sort]').forEach(th => {
      th.setAttribute('aria-sort', th.dataset.sort === $('sort').value ? (descending ? 'descending' : 'ascending') : 'none');
    });
    $('direction').textContent = descending ? 'Descending ↓' : 'Ascending ↑';
  }
  function reset() {
    $('search').value = '';
    $('status').value = '';
    $('phase').value = '';
    $('sort').value = 'order';
    descending = false;
    paginate(true);
  }
  function selectView() {
    const hash = location.hash.slice(1);
    view = ['completed', 'maintenance'].includes(hash) ? hash : 'remaining';
    $('work').hidden = view === 'maintenance';
    $('maintenance').hidden = view !== 'maintenance';
    document.querySelectorAll('nav a').forEach(a => {
      if (a.hash === '#' + view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    $('caption').textContent = view === 'completed' ? 'Completed work' : 'Remaining work';
    $('hint').textContent = view === 'completed' ? 'Actual completion dates · Select a column heading to sort.' : 'Future work is unscheduled · Roadmap order follows dependencies. Select a column heading to sort.';
    options();
    reset();
  }
  fields.forEach(id => $(id).addEventListener(id === 'search' ? 'input' : 'change', () => paginate(true)));
  $('direction').addEventListener('click', () => {descending = !descending; paginate(true);});
  $('reset').addEventListener('click', reset);
  $('previous').addEventListener('click', () => {page--; showPage();});
  $('next').addEventListener('click', () => {page++; showPage();});
  document.querySelectorAll('th[data-sort] button').forEach(button => button.addEventListener('click', () => {
    const key = button.parentElement.dataset.sort;
    descending = $('sort').value === key ? !descending : false;
    $('sort').value = key;
    paginate(true);
  }));
  $('remaining-count').textContent = data.items.filter(i => i.status !== 'Complete').length;
  $('completed-count').textContent = data.items.filter(i => i.status === 'Complete').length;
  $('verification').textContent = 'VERIFIED ' + data.verifiedLabel + ' · CODE ' + data.codeRevision.slice(0,7) + ' · SNAPSHOT';
  const themeButton = $('theme-toggle');
  function syncTheme() {themeButton.setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'light'));}
  syncTheme();
  themeButton.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    try {localStorage.setItem('agent-chatroom-progress-theme', theme);} catch {}
    syncTheme();
  });
  $('print').addEventListener('click', () => window.print());
  window.addEventListener('beforeprint', () => {
    printing = true;
    $('work').hidden = false;
    $('empty').hidden = true;
    $('caption').textContent = 'Agent Chatroom — All work items';
    body.innerHTML = rows(data.items);
  });
  window.addEventListener('afterprint', () => {printing = false; selectView();});
  window.addEventListener('hashchange', selectView);
  let resize;
  new ResizeObserver(() => {cancelAnimationFrame(resize);resize = requestAnimationFrame(() => paginate());}).observe(wrap);
  selectView();
})();
