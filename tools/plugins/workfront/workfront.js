/* eslint-disable import/no-unresolved */
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
// Spectrum 2 form components used by Experience Workspace: sl-input, sl-select, sl-checkbox, sl-button
import 'https://da.live/nx2/public/sl/components.js';
import {
  createWorkfrontClient,
  deriveCapabilities,
  isOverdue,
  pagePath,
  pageTarget,
  parseWfDate,
  PRIORITIES,
  STATUSES,
  taskMatchesPage,
} from './api.js';
import { createMockClient } from './mock.js';
import { demoComments, loadPageComments } from './comments.js';

const SDK_TIMEOUT = 3000;
const PAGE_ONLY_KEY = 'wf-panel:pageOnly';
// Task to reopen after "Go to page" reloads the panel on the new page.
const RESUME_KEY = 'wf-panel:resume';
const RESUME_TTL = 2 * 60 * 1000;
// Experience Workspace comment id → Workfront task created from it.
const COMMENT_TASKS_KEY = 'wf-panel:commentTasks';
const DEFAULTS = { mode: 'demo', host: 'markszulc.my.workfront.com', proxyUrl: '', apiVersion: 'v19.0' };
const MODES = [
  { value: 'demo', label: 'Demo data (no Workfront connection)' },
  { value: 'proxy', label: 'Proxy with IMS token (recommended)' },
  { value: 'ims', label: 'Direct with IMS token' },
  { value: 'apikey', label: 'Direct with API key (dev only)' },
];
const NX_ICONS = 'https://da.live/nx2/public/icons';
const ICONS = {
  add: `${NX_ICONS}/S2_Icon_Add_20_N.svg`,
  refresh: `${NX_ICONS}/S2_Icon_Refresh_20_N.svg`,
  settings: `${NX_ICONS}/S2_Icon_Properties_20_N.svg`,
  lock: `${NX_ICONS}/S2_Icon_Lock_20_N.svg`,
  openIn: `${NX_ICONS}/S2_Icon_OpenIn_20_N.svg`,
  edit: `${NX_ICONS}/S2_Icon_Edit_20_N.svg`,
  check: `${NX_ICONS}/S2_Icon_Checkmark_20_N.svg`,
  checkCircle: `${NX_ICONS}/S2_Icon_CheckmarkCircle_20_N.svg`,
  alert: `${NX_ICONS}/S2_Icon_AlertDiamond_20_N.svg`,
  assistant: 'https://da.live/nx2/img/icons/S2_Icon_Lightbulb_20_N.svg',
  back: 'https://da.live/nx/img/icons/S2_Icon_ChevronRight_20_N.svg',
};
const SCOPES = [
  { value: 'mine', label: 'My open tasks' },
  { value: 'created', label: 'Requested by me' },
  { value: 'done', label: 'Completed (14 days)' },
];

const state = {
  sdk: null,
  context: null,
  config: null,
  client: null,
  user: null,
  caps: null,
  view: 'loading',
  scope: 'mine',
  query: '',
  pageOnly: localStorage.getItem(PAGE_ONLY_KEY) === 'true',
  tasks: [],
  current: null,
  draft: null,
  readOnly: new Set(),
  error: null,
};

const root = document.getElementById('wf-root');

/* ---------- helpers ---------- */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  let value;
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === false) return;
    if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  });
  children.flat(Infinity).forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  });
  if (value !== undefined) el.value = value;
  return el;
}

function label(list, value) {
  return list.find((o) => String(o.value) === String(value))?.label ?? value ?? '—';
}

function formatDate(value) {
  const d = parseWfDate(value);
  return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
}

function toDateInput(value) {
  const d = parseWfDate(value);
  if (!d) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function icon(name) {
  return h('span', { class: 'wf-icon', style: `--wf-icon: url("${ICONS[name]}")`, 'aria-hidden': 'true' });
}

// sl-* fields render their own <label for={name}> in shadow DOM; the inner control copies the
// host's id, so id must equal name for the label to be associated.
function input(name, text, attrs = {}) {
  return h('sl-input', {
    type: 'text', name, id: name, label: text, value: '', ...attrs,
  });
}

// Native textarea styled like sl-* fields. sl-textarea is absolutely positioned and uses the
// field height as line-height, so it can't grow with its content.
function fitTextarea(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 4}px`;
}

function textarea(name, text, attrs = {}) {
  const { value = '', ...rest } = attrs;
  const area = h('textarea', {
    name, id: name, class: 'wf-textarea', ...rest, onInput: (e) => fitTextarea(e.target),
  });
  area.value = value;
  requestAnimationFrame(() => fitTextarea(area));
  return h('div', { class: 'wf-field' }, h('label', { class: 'wf-label', for: name }, text), area);
}

function select(name, text, options, current, attrs = {}) {
  return h(
    'sl-select',
    {
      name, label: text, value: current === undefined ? undefined : String(current), ...attrs,
    },
    options.map((o) => h('option', { value: String(o.value) }, o.label)),
  );
}

// Variants (nx2 sl-button): '' = accent, 'primary' = dark, 'primary outline' = secondary.
function button(text, attrs = {}, iconName = null) {
  return h('sl-button', { type: 'button', ...attrs }, iconName ? icon(iconName) : null, text);
}

function iconButton(iconName, text, onClick) {
  return h('button', {
    type: 'button', class: 'nx-action-btn-icon', 'aria-label': text, title: text, onClick,
  }, icon(iconName));
}

let toastTimer;
function toast(message, type = 'info') {
  const el = document.getElementById('wf-toast');
  if (!el) return;
  el.textContent = message;
  el.dataset.type = type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.textContent = ''; }, 5000);
}

function isEditable(task) {
  return !!state.caps?.canEdit && !state.readOnly.has(task.ID);
}

function handleError(e, task) {
  if (task && e.isPermission) {
    state.readOnly.add(task.ID);
    toast('Workfront says you don’t have permission to change this task.', 'error');
    return true;
  }
  toast(e.message || 'Something went wrong', 'error');
  return false;
}

function currentPath() {
  return state.context?.path || null;
}

function pageUrls() {
  const { org, repo, site, path } = state.context || {};
  const siteName = site || repo;
  if (!org || !siteName || !path) return null;
  const p = path.startsWith('/') ? path : `/${path}`;
  return {
    edit: `https://da.live/edit#/${org}/${siteName}${p}`,
    preview: `https://main--${siteName}--${org}.aem.page${p.replace(/\.html$/, '')}`,
  };
}

// The Experience Workspace document a task's URL points at, if it isn't the one open now.
function otherTaskPage(task) {
  const { org, repo, site } = state.context || {};
  const target = pageTarget(task?.URL, { org, site: site || repo });
  return target && !isCurrentPage(target) ? target : null;
}

function isCurrentPage(target) {
  const { org, repo, site, path } = state.context || {};
  return target.org === org && target.site === (site || repo) && pagePath(target.path) === pagePath(path);
}

function takeResumeTask() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(RESUME_KEY));
  } catch { /* ignore corrupt storage */ }
  localStorage.removeItem(RESUME_KEY);
  if (!saved?.taskID || Date.now() - saved.at > RESUME_TTL) return null;
  return isCurrentPage(saved.target) ? saved.taskID : null;
}

function goToPage(target, task) {
  const hash = `/${target.org}/${target.site}${target.path}`;
  if (task?.ID) {
    localStorage.setItem(RESUME_KEY, JSON.stringify({ taskID: task.ID, target, at: Date.now() }));
  }
  const { actions } = state.sdk || {};
  if (actions?.setHash) {
    actions.setHash(hash);
    // The editor may keep this panel open, so track the new page ourselves.
    state.context = { ...state.context, org: target.org, site: target.site, path: target.path };
    render();
  } else {
    window.open(`https://da.live/edit#${hash}`, '_blank', 'noopener');
  }
}

function pageLinks() {
  const urls = pageUrls();
  return urls ? `Related page: ${urls.edit}\nPreview: ${urls.preview}` : '';
}

/* ---------- config & connection ---------- */

function storageKey() {
  const c = state.context;
  return `wf-panel:${c?.org || 'standalone'}/${c?.site || c?.repo || ''}`;
}

function loadConfig() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = {};
  Object.keys(DEFAULTS).forEach((k) => {
    if (params.get(k)) fromUrl[k] = params.get(k);
  });
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(storageKey())) || {};
  } catch { /* ignore corrupt storage */ }
  const apiKey = sessionStorage.getItem(`${storageKey()}:apiKey`) || '';
  return { ...DEFAULTS, ...fromUrl, ...saved, apiKey, siteDefaults: { ...DEFAULTS, ...fromUrl } };
}

function saveConfig(config) {
  const { apiKey, siteDefaults, ...persisted } = config;
  localStorage.setItem(storageKey(), JSON.stringify(persisted));
  if (apiKey) sessionStorage.setItem(`${storageKey()}:apiKey`, apiKey);
  else sessionStorage.removeItem(`${storageKey()}:apiKey`);
}

function buildClient(config) {
  if (config.mode === 'demo') return createMockClient();
  return createWorkfrontClient(config, { getToken: async () => state.sdk?.token || null });
}

async function connectSdk() {
  const timeout = new Promise((resolve) => { setTimeout(() => resolve(null), SDK_TIMEOUT); });
  try {
    return await Promise.race([DA_SDK, timeout]);
  } catch {
    return null;
  }
}

async function loadTasks() {
  const listEl = document.getElementById('wf-list');
  if (listEl) listEl.setAttribute('aria-busy', 'true');
  try {
    const path = state.pageOnly ? pagePath(currentPath()) : null;
    const tasks = await state.client.searchTasks({
      scope: state.scope,
      query: state.query,
      urlContains: path && path !== '/' ? path : '',
    });
    state.tasks = path ? tasks.filter((t) => taskMatchesPage(t, path)) : tasks;
  } catch (e) {
    state.tasks = [];
    handleError(e);
  }
  renderList();
}

async function connect() {
  state.view = 'loading';
  state.error = null;
  state.readOnly.clear();
  render();
  state.client = buildClient(state.config);
  try {
    state.user = await state.client.getCurrentUser();
    state.caps = deriveCapabilities(state.user);
    state.view = 'list';
    render();
    await loadTasks();
  } catch (e) {
    state.user = null;
    state.caps = null;
    state.error = e;
    state.view = 'error';
    render();
  }
}

/* ---------- views ---------- */

function renderHeader() {
  const user = state.user
    ? h('span', { class: 'wf-user', title: `${state.user.emailAddr || ''} · ${state.caps?.source || ''}` }, state.user.name)
    : null;
  return h(
    'header',
    { class: 'wf-header' },
    h('h1', {}, 'Adobe Workfront'),
    state.config?.mode === 'demo' ? h('span', { class: 'wf-badge' }, 'Demo') : null,
    h('span', { class: 'wf-spacer' }),
    user,
    state.view === 'list' ? iconButton('refresh', 'Refresh', () => { loadTasks(); loadComments(); }) : null,
    iconButton('settings', 'Settings', () => { state.view = 'settings'; render(); }),
  );
}

function renderTaskCard(task) {
  const overdue = isOverdue(task);
  const done = task.status === 'CPL';
  const canComplete = !done && isEditable(task);
  const pct = Math.max(0, Math.min(100, Number(task.percentComplete) || 0));

  const completeBtn = h('button', {
    type: 'button',
    class: `wf-check${done ? ' is-done' : ''}`,
    'aria-label': done ? 'Completed' : `Mark “${task.name}” complete`,
    title: canComplete ? 'Mark complete' : '',
    disabled: !canComplete,
    onClick: async (ev) => {
      ev.stopPropagation();
      ev.currentTarget.disabled = true;
      try {
        await state.client.completeTask(task.ID);
        toast(`Completed “${task.name}”`, 'success');
        await loadTasks();
      } catch (e) {
        handleError(e, task);
        renderList();
      }
    },
  }, icon('check'));

  return h(
    'li',
    { class: 'wf-card' },
    completeBtn,
    h(
      'button',
      { type: 'button', class: 'wf-card-body', onClick: () => openTask(task.ID) },
      h('span', { class: 'wf-card-title' }, task.name),
      h('span', { class: 'wf-card-project' }, task.project?.name || ''),
      h(
        'span',
        { class: 'wf-card-meta' },
        h('span', { class: `wf-status wf-status-${task.status}` }, label(STATUSES, task.status)),
        h('span', { class: `wf-due${overdue ? ' is-overdue' : ''}` }, overdue ? `Overdue · ${formatDate(task.plannedCompletionDate)}` : formatDate(task.plannedCompletionDate)),
        task.priority >= 3 ? h('span', { class: `wf-priority wf-priority-${task.priority}` }, label(PRIORITIES, task.priority)) : null,
        state.readOnly.has(task.ID) ? h('span', { class: 'wf-lock', title: 'View only' }, icon('lock'), h('span', { class: 'wf-sr-only' }, 'View only')) : null,
      ),
      h('span', { class: 'wf-progress', 'aria-hidden': 'true' }, h('span', { style: `width:${pct}%` })),
    ),
  );
}

function renderList() {
  const listEl = document.getElementById('wf-list');
  if (!listEl) return;
  listEl.removeAttribute('aria-busy');
  listEl.replaceChildren();
  if (!state.tasks.length) {
    let msg = 'Nothing here — enjoy the calm.';
    if (state.query) msg = 'No tasks match your search.';
    else if (state.pageOnly && currentPath()) msg = 'No tasks are linked to this page. Set a task’s Page URL to link it.';
    listEl.append(h('li', { class: 'wf-empty' }, msg));
    return;
  }
  listEl.append(...state.tasks.map(renderTaskCard));
}

function renderListView() {
  let debounce;
  const search = input('search', '', {
    id: 'wf-search',
    placeholder: 'Search tasks',
    'aria-label': 'Search tasks',
    value: state.query,
    onInput: (e) => {
      const q = (e.target.value || '').trim();
      if (q === state.query) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => { state.query = q; loadTasks(); }, 300);
    },
  });
  const scope = select('scope', '', SCOPES, state.scope, {
    class: 'wf-scope',
    onChange: (e) => { state.scope = e.target.value; loadTasks(); },
  });
  const newBtn = state.caps?.canCreate
    ? button('New task', { onClick: () => { state.view = 'create'; render(); } }, 'add')
    : null;

  const path = currentPath();
  const pageToggle = path ? h('sl-checkbox', {
    name: 'pageOnly',
    class: 'wf-page-only',
    checked: state.pageOnly,
    title: `Show tasks whose URL points to ${path}`,
    onChange: (e) => {
      state.pageOnly = !!e.target.checked;
      localStorage.setItem(PAGE_ONLY_KEY, String(state.pageOnly));
      loadTasks();
    },
  }, `Only tasks for this page (${pagePath(path)})`) : null;

  return [
    h('div', { class: 'wf-toolbar' }, scope, newBtn),
    search,
    pageToggle,
    !state.caps?.canEdit ? h('p', { class: 'wf-note' }, icon('lock'), 'Your Workfront access level is view-only for tasks.') : null,
    h('ul', { class: 'wf-list', id: 'wf-list', 'aria-busy': 'true', 'aria-label': 'Tasks' }, h('li', { class: 'wf-empty' }, 'Loading tasks…')),
    currentPath() ? h('section', { class: 'wf-section wf-comments', id: 'wf-comments', hidden: true }) : null,
  ];
}

/* ---------- page comments ---------- */

function commentTasks() {
  try {
    return JSON.parse(localStorage.getItem(COMMENT_TASKS_KEY)) || {};
  } catch {
    return {};
  }
}

function rememberCommentTask(commentId, taskID) {
  localStorage.setItem(COMMENT_TASKS_KEY, JSON.stringify({ ...commentTasks(), [commentId]: taskID }));
}

function formatTime(ms) {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function fetchComments() {
  const { org, repo, site, path } = state.context || {};
  if (state.sdk?.token) {
    return loadPageComments({
      org, site: site || repo, path, token: state.sdk.token,
    });
  }
  return Promise.resolve(state.config.mode === 'demo' ? demoComments() : []);
}

function createTaskFromComment(thread) {
  const firstLine = (thread.body || '').split('\n')[0].trim();
  const name = firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
  const description = [
    thread.body,
    thread.anchorText ? `On: “${thread.anchorText}”` : '',
    `— ${thread.author?.name || 'Someone'}, ${formatTime(thread.createdAt)} (Experience Workspace comment)`,
    thread.replies.length
      ? `Replies:\n${thread.replies.map((r) => `${r.author?.name || 'Someone'}: ${r.body}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');
  state.draft = { name, description, commentId: thread.id };
  state.view = 'create';
  render();
}

function renderComment(thread, linked) {
  const taskID = linked[thread.id];
  let action = null;
  if (taskID) {
    action = h('button', {
      type: 'button', class: 'wf-comment-link nx-action-btn-quiet', onClick: () => openTask(taskID),
    }, icon('checkCircle'), 'Task created — view');
  } else if (state.caps?.canCreate) {
    action = button('Create task', { class: 'primary outline', onClick: () => createTaskFromComment(thread) }, 'add');
  }
  const replies = thread.replies.length;
  return h(
    'li',
    { class: 'wf-comment' },
    h('div', { class: 'wf-update-meta' }, `${thread.author?.name || 'Someone'} · ${formatTime(thread.createdAt)}`),
    thread.anchorText ? h('blockquote', { class: 'wf-comment-quote' }, thread.anchorText) : null,
    h('div', { class: 'wf-update-text' }, thread.body),
    h(
      'div',
      { class: 'wf-comment-footer' },
      replies ? h('span', { class: 'wf-comment-replies' }, `${replies} ${replies === 1 ? 'reply' : 'replies'}`) : null,
      h('span', { class: 'wf-spacer' }),
      action,
    ),
  );
}

async function loadComments() {
  const section = document.getElementById('wf-comments');
  if (!section) return;
  let threads;
  try {
    threads = await fetchComments();
  } catch (e) {
    section.hidden = false;
    section.replaceChildren(h('h3', {}, 'Page comments'), h('p', { class: 'wf-empty' }, e.message));
    return;
  }
  if (!section.isConnected) return;
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.length - open.length;
  section.hidden = !threads.length;
  if (!threads.length) return;
  const linked = commentTasks();
  section.replaceChildren(
    h('h3', {}, `Page comments (${open.length})`),
    open.length
      ? h('ul', { class: 'wf-updates wf-comment-list', 'aria-label': 'Page comments' }, open.map((t) => renderComment(t, linked)))
      : h('p', { class: 'wf-empty' }, 'All comments on this page are resolved.'),
    resolved ? h('p', { class: 'wf-comment-resolved' }, `${resolved} resolved ${resolved === 1 ? 'comment' : 'comments'} not shown.`) : '',
  );
}

async function openTask(id) {
  state.view = 'detail';
  state.current = null;
  render();
  try {
    state.current = await state.client.getTask(id);
  } catch (e) {
    handleError(e);
    state.view = 'list';
    render();
    await loadTasks();
    return;
  }
  render();
}

async function loadUpdates(task, listEl) {
  try {
    const notes = await state.client.getUpdates(task.ID);
    listEl.replaceChildren(...(notes.length
      ? notes.map((n) => h(
        'li',
        {},
        h('div', { class: 'wf-update-meta' }, `${n.owner?.name || 'Someone'} · ${formatDate(n.entryDate)}`),
        h('div', { class: 'wf-update-text' }, n.noteText),
      ))
      : [h('li', { class: 'wf-empty' }, 'No updates yet.')]));
  } catch (e) {
    listEl.replaceChildren(h('li', { class: 'wf-empty' }, `Couldn’t load updates: ${e.message}`));
  }
}

function backButton() {
  return h('button', {
    type: 'button',
    class: 'wf-back nx-action-btn-quiet',
    onClick: () => {
      state.draft = null;
      state.view = 'list';
      render();
      loadTasks();
    },
  }, icon('back'), 'Tasks');
}

function renderDetailView() {
  const task = state.current;
  if (!task) return [backButton(), h('p', { class: 'wf-loading' }, 'Loading task…')];

  const editable = isEditable(task);
  const done = task.status === 'CPL';
  const url = state.client.taskUrl(task.ID);
  const { actions } = state.sdk || {};

  const form = h('form', { class: 'wf-form', novalidate: true });
  const pctOut = h('output', { for: 'percentComplete' }, `${task.percentComplete || 0}%`);
  const saveBtn = button('Save changes', { type: 'submit', disabled: true });
  const off = !editable;
  const page = pageUrls();
  const otherPage = otherTaskPage(task);
  const urlInput = input('URL', 'Page URL', {
    inputmode: 'url', value: task.URL || '', disabled: off, placeholder: 'https://… page this task is about',
  });
  const linkBtn = editable && page && !taskMatchesPage(task, currentPath())
    ? h('button', {
      type: 'button',
      class: 'wf-link-page nx-action-btn-quiet',
      onClick: (e) => {
        urlInput.value = page.preview;
        e.currentTarget.remove();
        form.dispatchEvent(new Event('input'));
      },
    }, 'Link to this page')
    : null;

  form.append(
    input('name', 'Name', { required: true, value: task.name, disabled: off }),
    h(
      'div',
      { class: 'wf-row' },
      select('status', 'Status', STATUSES, task.status, { disabled: off }),
      select('priority', 'Priority', PRIORITIES, task.priority ?? 2, { disabled: off }),
    ),
    h(
      'div',
      { class: 'wf-field' },
      h('label', { for: 'percentComplete', class: 'wf-label' }, 'Progress'),
      h(
        'div',
        { class: 'wf-range' },
        h('input', {
          type: 'range', id: 'percentComplete', name: 'percentComplete', min: '0', max: '100', step: '5',
          value: String(task.percentComplete || 0),
          disabled: off,
          onInput: (e) => { pctOut.textContent = `${e.target.value}%`; },
        }),
        pctOut,
      ),
    ),
    input('plannedCompletionDate', 'Due date', { type: 'date', value: toDateInput(task.plannedCompletionDate), disabled: off }),
    h('div', { class: 'wf-url-field' }, urlInput, linkBtn),
    textarea('description', 'Description', { rows: '5', value: task.description || '', disabled: off }),
    editable ? h('div', { class: 'wf-actions' }, saveBtn) : null,
  );

  const readValues = () => {
    const fd = new FormData(form);
    return {
      name: fd.get('name')?.trim(),
      status: fd.get('status'),
      priority: Number(fd.get('priority')),
      percentComplete: Number(fd.get('percentComplete')),
      plannedCompletionDate: fd.get('plannedCompletionDate') || null,
      description: fd.get('description') ?? '',
      URL: (urlInput.value || '').trim(),
    };
  };
  const original = {
    name: task.name,
    status: task.status,
    priority: Number(task.priority ?? 2),
    percentComplete: Number(task.percentComplete || 0),
    plannedCompletionDate: toDateInput(task.plannedCompletionDate) || null,
    description: task.description || '',
    URL: task.URL || '',
  };
  const diff = () => {
    const now = readValues();
    return Object.fromEntries(Object.entries(now).filter(([k, v]) => v !== original[k]));
  };
  const syncSave = () => { saveBtn.disabled = Object.keys(diff()).length === 0; };
  form.addEventListener('input', syncSave);
  form.addEventListener('change', syncSave);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const updates = diff();
    if (!updates.name && 'name' in updates) { toast('Name is required', 'error'); return; }
    if (!Object.keys(updates).length) return;
    saveBtn.disabled = true;
    try {
      state.current = await state.client.updateTask(task.ID, updates);
      toast('Saved to Workfront', 'success');
    } catch (err) {
      handleError(err, task);
    }
    render();
  });

  const actionBar = h(
    'div',
    { class: 'wf-actions wf-actions-secondary' },
    editable && !done ? button('Mark complete', {
      onClick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          state.current = await state.client.completeTask(task.ID);
          toast('Task completed', 'success');
        } catch (err) {
          handleError(err, task);
        }
        render();
      },
    }, 'checkCircle') : null,
    actions?.setPrompt ? button('Ask Coworker', {
      class: 'primary outline',
      title: 'Ask Coworker to help complete this task',
      onClick: () => {
        const name = (form.querySelector('[name=name]')?.value || task.name || '').trim();
        const description = (form.querySelector('[name=description]')?.value ?? task.description ?? '').trim();
        const prompt = [
          `Coworker, please help me complete this Workfront task on the page I have open.`,
          `Task: ${name}`,
          description ? `Description:\n${description}` : '',
          'Suggest the changes first and wait for my confirmation before editing.',
        ].filter(Boolean).join('\n\n');
        actions.setPrompt(prompt, { autoSend: false });
        toast('Sent to Coworker — review and press send.', 'success');
      },
    }, 'assistant') : null,
    otherPage ? button('Go to page', {
      class: 'primary outline',
      title: `Open ${otherPage.path} (${otherPage.org}/${otherPage.site}) in the editor`,
      onClick: () => goToPage(otherPage, task),
    }, 'edit') : null,
    url ? h('a', {
      class: 'wf-link-btn', href: url, target: '_blank', rel: 'noopener',
    }, icon('openIn'), 'Open in Workfront') : null,
  );

  const assignees = (task.assignments || []).map((a) => a.assignedTo?.name).filter(Boolean);
  const info = h(
    'dl',
    { class: 'wf-info' },
    h('dt', {}, 'Project'), h('dd', {}, task.project?.name || '—'),
    h('dt', {}, 'Assignees'), h('dd', {}, assignees.join(', ') || task.assignedTo?.name || 'Unassigned'),
    h('dt', {}, 'Requested by'), h('dd', {}, task.enteredBy?.name || '—'),
    h('dt', {}, 'Last updated'), h('dd', {}, formatDate(task.lastUpdateDate)),
  );

  const updatesList = h('ul', { class: 'wf-updates' }, h('li', { class: 'wf-empty' }, 'Loading updates…'));
  loadUpdates(task, updatesList);
  const noteField = textarea('note', 'New update', { rows: '2', placeholder: 'Write an update…' });
  const noteInput = noteField.querySelector('textarea');
  const updateForm = state.caps?.canComment ? h(
    'form',
    {
      class: 'wf-update-form',
      onSubmit: async (e) => {
        e.preventDefault();
        const text = (noteInput.value || '').trim();
        if (!text) return;
        const btn = e.currentTarget.querySelector('sl-button');
        btn.disabled = true;
        try {
          await state.client.addUpdate(task.ID, text);
          noteInput.value = '';
          fitTextarea(noteInput);
          toast('Update posted', 'success');
          await loadUpdates(task, updatesList);
        } catch (err) {
          handleError(err);
        }
        btn.disabled = false;
      },
    },
    noteField,
    button('Post update', { type: 'submit', class: 'primary outline' }),
  ) : null;

  return [
    backButton(),
    h('h2', { class: 'wf-title' }, task.name),
    !editable ? h('p', { class: 'wf-note' }, icon('lock'), 'You can view this task but not edit it.') : null,
    actionBar,
    form,
    info,
    h('section', { class: 'wf-section' }, h('h3', {}, 'Updates'), updateForm, updatesList),
  ];
}

function renderCreateView() {
  const draft = state.draft || {};
  // sl-select moves its <option>s into shadow DOM, so build a new one once projects arrive.
  const projectSlot = h('div', { class: 'wf-field' }, select('projectID', 'Project', [{ value: '', label: 'Loading projects…' }], '', { disabled: true }));
  state.client.searchProjects().then((projects) => {
    projectSlot.replaceChildren(select('projectID', 'Project', [
      { value: '', label: projects.length ? 'Choose a project' : 'No active projects available' },
      ...projects.map((p) => ({ value: p.ID, label: p.name })),
    ], ''));
  }).catch((e) => {
    projectSlot.replaceChildren(select('projectID', 'Project', [{ value: '', label: 'Could not load projects' }], '', { disabled: true }));
    toast(e.message, 'error');
  });

  const links = pageLinks();
  const form = h(
    'form',
    { class: 'wf-form' },
    input('name', 'Task name', { required: true, maxlength: '255', value: draft.name || '' }),
    projectSlot,
    h(
      'div',
      { class: 'wf-row' },
      input('plannedCompletionDate', 'Due date', { type: 'date' }),
      select('new-priority', 'Priority', PRIORITIES, 2),
    ),
    textarea('description', 'Description', { rows: '5', value: draft.description || '' }),
    links ? h('sl-checkbox', { name: 'linkPage', checked: true }, 'Link to the page I’m editing') : null,
    h('sl-checkbox', { name: 'assignMe', checked: true }, 'Assign to me'),
    h('div', { class: 'wf-actions' }, button('Create task', { type: 'submit' })),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const name = (fd.get('name') || '').trim();
    if (!name || !fd.get('projectID')) { toast('Name and project are required', 'error'); return; }
    let description = (fd.get('description') || '').trim();
    if (links && fd.get('linkPage')) description = [description, links].filter(Boolean).join('\n\n');
    const data = {
      name,
      projectID: fd.get('projectID'),
      description,
      priority: Number(fd.get('new-priority')),
    };
    if (fd.get('plannedCompletionDate')) data.plannedCompletionDate = fd.get('plannedCompletionDate');
    if (fd.get('assignMe') && state.user?.ID) data.assignedToID = state.user.ID;
    if (links && fd.get('linkPage')) data.URL = pageUrls().preview;

    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const created = await state.client.createTask(data);
      if (draft.commentId) rememberCommentTask(draft.commentId, created.ID);
      state.draft = null;
      toast('Task created in Workfront', 'success');
      await openTask(created.ID);
    } catch (err) {
      handleError(err);
      btn.disabled = false;
    }
  });

  return [
    backButton(),
    h('h2', { class: 'wf-title' }, draft.commentId ? 'New task from comment' : 'New task'),
    form,
  ];
}

function renderSettingsView() {
  const cfg = state.config;
  const form = h('form', { class: 'wf-form' });
  const modeSelect = select('mode', 'Connection', MODES, cfg.mode);
  const hostField = input('host', 'Workfront host', { placeholder: 'markszulc.my.workfront.com', value: cfg.host });
  const proxyField = input('proxyUrl', 'Proxy URL', { placeholder: 'https://<namespace>.adobeioruntime.net/api/v1/web/workfront/proxy', value: cfg.proxyUrl });
  const keyField = h(
    'div',
    { class: 'wf-form' },
    input('apiKey', 'API key', { type: 'password', autocomplete: 'off', value: cfg.apiKey }),
    h('p', { class: 'wf-note wf-note-warn' }, icon('alert'), 'API keys act as you with full rights. Kept only for this browser session — use the proxy for real deployments.'),
  );
  const versionField = input('apiVersion', 'API version', { value: cfg.apiVersion });

  const sync = () => {
    const m = modeSelect.value;
    hostField.hidden = m === 'demo';
    versionField.hidden = m === 'demo';
    proxyField.hidden = m !== 'proxy';
    keyField.hidden = m !== 'apikey';
  };
  modeSelect.addEventListener('change', sync);

  form.append(
    modeSelect,
    hostField,
    proxyField,
    keyField,
    versionField,
    h(
      'div',
      { class: 'wf-actions' },
      button('Reset to site defaults', {
        class: 'primary outline',
        onClick: () => {
          localStorage.removeItem(storageKey());
          sessionStorage.removeItem(`${storageKey()}:apiKey`);
          state.config = loadConfig();
          connect();
        },
      }),
      button('Save & connect', { type: 'submit' }),
    ),
  );
  sync();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const val = (k) => (fd.get(k) || '').trim();
    const next = {
      ...state.config,
      mode: fd.get('mode'),
      host: val('host'),
      proxyUrl: val('proxyUrl'),
      apiVersion: val('apiVersion') || DEFAULTS.apiVersion,
      apiKey: val('apiKey'),
    };
    if (next.mode !== 'demo' && !next.host && next.mode !== 'proxy') { toast('Enter your Workfront host', 'error'); return; }
    if (next.mode === 'proxy' && !next.proxyUrl) { toast('Enter the proxy URL', 'error'); return; }
    if (next.mode === 'apikey' && !next.apiKey) { toast('Enter an API key', 'error'); return; }
    saveConfig(next);
    state.config = next;
    connect();
  });

  const caps = state.caps;
  return [
    state.user ? backButton() : null,
    h('h2', { class: 'wf-title' }, 'Settings'),
    state.user ? h(
      'p',
      { class: 'wf-note' },
      `Connected as ${state.user.name}. Permissions: ${[
        caps.canEdit ? 'edit' : 'view only',
        caps.canCreate ? 'create' : null,
      ].filter(Boolean).join(', ')} (${caps.source}).`,
    ) : null,
    form,
  ];
}

function renderErrorView() {
  const e = state.error;
  const needsSdk = !state.sdk && ['ims', 'proxy'].includes(state.config.mode);
  return [
    h(
      'div',
      { class: 'wf-error', role: 'alert' },
      h('h2', {}, icon('alert'), 'Couldn’t connect to Workfront'),
      h('p', {}, e?.message || 'Unknown error'),
      needsSdk ? h('p', {}, 'This mode needs your Adobe sign-in from Experience Workspace. Open the panel inside Experience Workspace, or switch mode.') : null,
    ),
    h(
      'div',
      { class: 'wf-actions' },
      button('Settings', { class: 'primary outline', onClick: () => { state.view = 'settings'; render(); } }),
      button('Retry', { onClick: connect }),
    ),
  ];
}

function render() {
  const views = {
    loading: () => [h('p', { class: 'wf-loading' }, 'Connecting to Workfront…')],
    list: renderListView,
    detail: renderDetailView,
    create: renderCreateView,
    settings: renderSettingsView,
    error: renderErrorView,
  };
  root.replaceChildren(...[
    renderHeader(),
    !state.sdk ? h('p', { class: 'wf-note wf-note-warn' }, 'Standalone mode: not connected to Experience Workspace.') : null,
    h('main', { class: `wf-body wf-view-${state.view}` }, views[state.view]()),
  ].filter(Boolean));
  if (state.view === 'list') {
    renderList();
    loadComments();
  }
}

(async function init() {
  state.sdk = await connectSdk();
  state.context = state.sdk?.context || null;
  if (!state.context) {
    // Standalone testing: ?org=…&site=…&path=… stands in for the Experience Workspace page.
    const params = new URLSearchParams(window.location.search);
    if (params.get('path')) {
      state.context = { org: params.get('org'), site: params.get('site'), path: params.get('path') };
    }
  }
  state.config = loadConfig();
  const resumeID = takeResumeTask();
  await connect();
  if (resumeID && state.view === 'list') await openTask(resumeID);
}());
