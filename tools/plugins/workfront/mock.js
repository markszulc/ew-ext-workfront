import { WorkfrontError } from './api.js';

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

const ME = { ID: 'u-me', name: 'Demo Author' };
const PEER = { ID: 'u-2', name: 'Jamie Rivera' };

const PROJECTS = [
  { ID: 'p-1', name: 'Spring Campaign 2027', status: 'CUR' },
  { ID: 'p-2', name: 'Website Refresh', status: 'CUR' },
  { ID: 'p-3', name: 'Product Launch — Atelier Nova', status: 'CUR' },
];

function task(id, name, project, extra = {}) {
  return {
    ID: id,
    name,
    description: '',
    status: 'NEW',
    percentComplete: 0,
    priority: 2,
    plannedStartDate: iso(-3),
    plannedCompletionDate: iso(5),
    lastUpdateDate: iso(-1),
    projectID: project.ID,
    project: { ID: project.ID, name: project.name },
    assignedToID: ME.ID,
    assignedTo: ME,
    enteredBy: PEER,
    assignments: [{ assignedTo: ME }],
    ...extra,
  };
}

export function createMockClient({ readOnlyTaskIDs = ['t-5'] } = {}) {
  const tasks = [
    task('t-1', 'Write hero copy for spring landing page', PROJECTS[0], {
      description: 'Headline + 2 lines of supporting copy. Follow the Frescopa voice guide.',
      status: 'INP',
      percentComplete: 40,
      priority: 3,
      plannedCompletionDate: iso(-1),
    }),
    task('t-2', 'Select imagery for product detail pages', PROJECTS[2], {
      description: 'Pick 6 lifestyle shots from the DAM; check usage rights.',
      plannedCompletionDate: iso(2),
    }),
    task('t-3', 'Review SEO metadata on /coffee pages', PROJECTS[1], {
      status: 'INP',
      percentComplete: 75,
      plannedCompletionDate: iso(7),
      priority: 1,
    }),
    task('t-4', 'Draft blog post: cold brew at home', PROJECTS[0], {
      description: '~400 words, casual tone, aimed at home baristas.',
      plannedCompletionDate: iso(10),
    }),
    task('t-5', 'Legal sign-off on sustainability claims', PROJECTS[2], {
      description: 'Shared with you as view-only.',
      assignedTo: PEER,
      assignedToID: PEER.ID,
      assignments: [{ assignedTo: ME }, { assignedTo: PEER }],
      priority: 4,
      plannedCompletionDate: iso(1),
    }),
    task('t-6', 'Publish FAQ page', PROJECTS[1], {
      status: 'CPL',
      percentComplete: 100,
      lastUpdateDate: iso(-2),
    }),
  ];
  const notes = {
    't-1': [
      { ID: 'n-1', noteText: 'First draft is in the doc, needs a punchier CTA.', entryDate: iso(-1), owner: PEER },
    ],
  };
  let seq = 100;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const delay = (v) => new Promise((r) => { setTimeout(() => r(clone(v)), 150); });
  const find = (id) => {
    const t = tasks.find((x) => x.ID === id);
    if (!t) throw new WorkfrontError('Task not found', { status: 404 });
    return t;
  };
  const guard = (id) => {
    if (readOnlyTaskIDs.includes(id)) {
      throw new WorkfrontError('You do not have permission to edit this task.', {
        status: 403, code: 'NotAllowedException',
      });
    }
  };

  return {
    mode: 'demo',
    taskUrl: () => null,

    getCurrentUser: () => delay({
      ...ME,
      emailAddr: 'demo@example.com',
      licenseType: 'STANDARD',
      accessLevel: {
        name: 'Standard',
        accessLevelPermissions: [{ objObjCode: 'TASK', coreAction: 'EDIT', forbiddenActions: [] }],
      },
    }),

    searchTasks: ({ scope = 'mine', query = '' } = {}) => {
      let list = tasks.filter((t) => (scope === 'done' ? t.status === 'CPL' : t.status !== 'CPL'));
      if (scope === 'created') list = list.filter((t) => t.enteredBy.ID === ME.ID);
      else list = list.filter((t) => t.assignments.some((a) => a.assignedTo.ID === ME.ID));
      if (query) list = list.filter((t) => t.name.toLowerCase().includes(query.toLowerCase()));
      list.sort((a, b) => a.plannedCompletionDate.localeCompare(b.plannedCompletionDate));
      return delay(list);
    },

    getTask: (id) => delay(find(id)),

    updateTask: (id, updates) => {
      guard(id);
      const t = find(id);
      Object.assign(t, updates, { lastUpdateDate: new Date().toISOString() });
      if (updates.status === 'CPL') t.percentComplete = 100;
      if (updates.projectID) {
        const p = PROJECTS.find((x) => x.ID === updates.projectID);
        t.project = { ID: p.ID, name: p.name };
      }
      return delay(t);
    },

    completeTask(id) {
      return this.updateTask(id, { status: 'CPL', percentComplete: 100 });
    },

    createTask: (data) => {
      if (!data.name) throw new WorkfrontError('Task name is required', { status: 422 });
      const p = PROJECTS.find((x) => x.ID === data.projectID);
      if (!p) throw new WorkfrontError('Choose a project', { status: 422 });
      seq += 1;
      const assignee = data.assignedToID === ME.ID ? ME : null;
      const t = task(`t-${seq}`, data.name, p, {
        description: data.description || '',
        priority: data.priority ?? 2,
        plannedCompletionDate: data.plannedCompletionDate || iso(7),
        assignedToID: assignee?.ID || null,
        assignedTo: assignee,
        assignments: assignee ? [{ assignedTo: ME }] : [],
        enteredBy: ME,
      });
      tasks.push(t);
      return delay(t);
    },

    searchProjects: (query = '') => delay(
      PROJECTS.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())),
    ),

    getUpdates: (id) => delay(notes[id] || []),

    addUpdate: (id, noteText) => {
      seq += 1;
      const note = { ID: `n-${seq}`, noteText, entryDate: new Date().toISOString(), owner: ME };
      notes[id] = [note, ...(notes[id] || [])];
      return delay(note);
    },
  };
}
