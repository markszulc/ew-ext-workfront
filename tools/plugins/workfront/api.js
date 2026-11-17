/**
 * Workfront REST client used by the side-panel plugin.
 *
 * Connection modes:
 *  - proxy:  requests go to `proxyUrl` + /attask/api/... with the author's IMS token.
 *            The proxy adds CORS and exchanges/attaches Workfront credentials.
 *  - ims:    requests go straight to the Workfront host with `Authorization: Bearer <IMS>`.
 *            Only works if your Workfront instance accepts the token and allows CORS.
 *  - apikey: requests go straight to the Workfront host with `?apiKey=` (dev only).
 *  - demo:   in-memory mock data (see mock.js).
 */

export const TASK_FIELDS = [
  'name',
  'description',
  'status',
  'percentComplete',
  'priority',
  'plannedCompletionDate',
  'plannedStartDate',
  'lastUpdateDate',
  'projectID',
  'project:name',
  'assignedToID',
  'assignedTo:name',
  'enteredBy:name',
  'assignments:assignedTo:name',
].join(',');

export const STATUSES = [
  { value: 'NEW', label: 'New' },
  { value: 'INP', label: 'In Progress' },
  { value: 'CPL', label: 'Complete' },
];

export const PRIORITIES = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Low' },
  { value: 2, label: 'Normal' },
  { value: 3, label: 'High' },
  { value: 4, label: 'Urgent' },
];

const VIEW_ONLY_LICENSES = ['REVIEW', 'REQUESTOR', 'CONTRIBUTOR', 'LIMITED', 'EXTERNAL'];
const EDIT_CORE_ACTIONS = ['EDIT', 'MANAGE', 'DELETE'];

export class WorkfrontError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'WorkfrontError';
    this.status = status;
    this.code = code;
  }

  get isPermission() {
    return this.status === 403
      || /NotAllowed|Permission|Forbidden|Access/i.test(this.code || '');
  }
}

/**
 * Works out what the current user may do, from their Workfront access level and license.
 * This only gates the UI; Workfront remains authoritative and 403s are handled per task.
 */
export function deriveCapabilities(user) {
  const caps = { canView: true, canEdit: true, canCreate: true, canComment: true, source: 'default' };
  if (!user) return caps;

  const license = (user.licenseType || '').toUpperCase();
  if (VIEW_ONLY_LICENSES.includes(license)) {
    caps.canEdit = false;
    caps.canCreate = false;
    caps.source = `license:${license}`;
  }

  const perms = user.accessLevel?.accessLevelPermissions;
  const taskPerm = Array.isArray(perms) ? perms.find((p) => p.objObjCode === 'TASK') : null;
  if (taskPerm) {
    const core = (taskPerm.coreAction || '').toUpperCase();
    const forbidden = (taskPerm.forbiddenActions || []).map((a) => String(a).toUpperCase());
    caps.canView = core !== 'NONE' && core !== '';
    caps.canEdit = caps.canEdit && EDIT_CORE_ACTIONS.includes(core);
    caps.canCreate = caps.canCreate && caps.canEdit && !forbidden.includes('ADD');
    caps.source = `accessLevel:${user.accessLevel.name || core}`;
  }
  return caps;
}

/**
 * Workfront returns dates like `2027-01-15T09:00:00:000-0500` (colon before ms,
 * offset without colon), which `new Date()` can't parse. Also accepts plain ISO.
 */
export function parseWfDate(value) {
  if (!value) return null;
  const normalized = String(value)
    .replace(/T(\d{2}:\d{2}:\d{2}):(\d{3})/, 'T$1.$2')
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isOverdue(task, now = new Date()) {
  if (!task?.plannedCompletionDate || task.status === 'CPL') return false;
  const due = parseWfDate(task.plannedCompletionDate);
  return !!due && due < now;
}

function normalizeHost(host) {
  if (!host) return '';
  const trimmed = host.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function createWorkfrontClient(config, { getToken } = {}) {
  const host = normalizeHost(config.host);
  const version = config.apiVersion || 'v19.0';
  const base = config.mode === 'proxy' ? normalizeHost(config.proxyUrl) : host;
  const apiRoot = `${base}/attask/api/${version}`;

  async function request(path, { method = 'GET', params = {}, body } = {}) {
    const url = new URL(`${apiRoot}/${path}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v === undefined || v === null || v === '') return;
      (Array.isArray(v) ? v : [v]).forEach((item) => url.searchParams.append(k, item));
    });

    const headers = { Accept: 'application/json' };
    if (config.mode === 'apikey') {
      url.searchParams.set('apiKey', config.apiKey);
    } else {
      const token = getToken ? await getToken() : null;
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (config.mode === 'proxy' && host) headers['X-Workfront-Host'] = host;
    if (body) headers['Content-Type'] = 'application/json';

    let resp;
    try {
      resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new WorkfrontError(
        `Could not reach Workfront (${e.message}). Check the host/proxy and CORS settings.`,
        { code: 'NETWORK' },
      );
    }

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json.error) {
      const err = json.error || {};
      throw new WorkfrontError(
        err.message || `Workfront returned ${resp.status}`,
        { status: resp.status, code: err.class || err.title },
      );
    }
    return json.data;
  }

  return {
    mode: config.mode,

    taskUrl(id) {
      return host ? `${host}/task/${id}/overview` : null;
    },

    async getCurrentUser() {
      const fields = [
        'name', 'emailAddr', 'licenseType', 'avatarDownloadURL',
        'accessLevel:name', 'accessLevel:accessLevelPermissions:*',
      ].join(',');
      const data = await request('user/search', { params: { ID: '$$USER.ID', fields } });
      return Array.isArray(data) ? data[0] : data;
    },

    async searchTasks({ scope = 'mine', query = '', limit = 50 } = {}) {
      const params = {
        fields: TASK_FIELDS,
        $$LIMIT: limit,
        plannedCompletionDate_Sort: 'asc',
      };
      if (scope === 'mine' || scope === 'done') params['assignments:assignedToID'] = '$$USER.ID';
      if (scope === 'created') params.enteredByID = '$$USER.ID';
      if (scope === 'done') {
        params.status = 'CPL';
        params.lastUpdateDate = '$$TODAY-14d';
        params.lastUpdateDate_Mod = 'gte';
        delete params.plannedCompletionDate_Sort;
        params.lastUpdateDate_Sort = 'desc';
      } else {
        params.status = 'CPL';
        params.status_Mod = 'ne';
      }
      if (query) {
        params.name = query;
        params.name_Mod = 'cicontains';
      }
      return request('task/search', { params });
    },

    getTask(id) {
      return request(`task/${id}`, { params: { fields: TASK_FIELDS } });
    },

    updateTask(id, updates) {
      return request(`task/${id}`, { method: 'PUT', params: { fields: TASK_FIELDS }, body: updates });
    },

    completeTask(id) {
      return request(`task/${id}`, {
        method: 'PUT',
        params: { fields: TASK_FIELDS },
        body: { status: 'CPL', percentComplete: 100 },
      });
    },

    createTask(data) {
      return request('task', { method: 'POST', params: { fields: TASK_FIELDS }, body: data });
    },

    searchProjects(query = '') {
      const params = {
        fields: 'name,status',
        status: 'CUR',
        $$LIMIT: 100,
        name_Sort: 'asc',
      };
      if (query) {
        params.name = query;
        params.name_Mod = 'cicontains';
      }
      return request('proj/search', { params });
    },

    getUpdates(taskID) {
      return request('note/search', {
        params: {
          taskID,
          fields: 'noteText,entryDate,owner:name',
          entryDate_Sort: 'desc',
          $$LIMIT: 20,
        },
      });
    },

    addUpdate(taskID, noteText) {
      return request('note', {
        method: 'POST',
        body: { noteObjCode: 'TASK', objID: taskID, noteText },
      });
    },
  };
}
