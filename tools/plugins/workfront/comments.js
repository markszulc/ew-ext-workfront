/*
 * Experience Workspace page comments.
 *
 * Comments live next to the content as one JSON file per comment:
 *   HEAD https://admin.da.live/source/{org}/{site}{path}.html     → x-da-id: {docId}
 *   GET  https://admin.da.live/list/{org}/{site}/.da/comments/{docId}/
 *   GET  https://admin.da.live/source/{org}/{site}/.da/comments/{docId}/{commentId}.json
 * Root comments have threadId: null; replies carry their root's id as threadId.
 * Replies are saved like the editor does: POST multipart `data` (JSON blob) to
 *   https://admin.da.live/source/{org}/{site}/.da/comments/{docId}/{newId}.json
 */

const DA_ADMIN = 'https://admin.da.live';

async function daFetch(url, token, opts = {}) {
  return fetch(url, {
    cache: 'no-store',
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
  });
}

/** Group flat comments into threads: [{ ...root, replies: [...] }], oldest first. */
export function toThreads(comments) {
  const byTime = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);
  const roots = comments.filter((c) => c && !c.threadId).sort(byTime);
  return roots.map((root) => ({
    ...root,
    replies: comments.filter((c) => c?.threadId === root.id).sort(byTime),
  }));
}

export async function loadPageComments({
  org, site, path, token,
}) {
  if (!org || !site || !path || !token) return [];
  const docPath = `${path.startsWith('/') ? path : `/${path}`}`.replace(/\.html$/, '');
  const head = await daFetch(`${DA_ADMIN}/source/${org}/${site}${docPath}.html`, token, { method: 'HEAD' });
  if (!head.ok) throw new Error(`Couldn’t read the page (${head.status})`);
  const docId = head.headers.get('x-da-id');
  if (!docId) return [];

  const base = `${org}/${site}/.da/comments/${docId}`;
  const list = await daFetch(`${DA_ADMIN}/list/${base}/`, token);
  if (list.status === 404) return [];
  if (!list.ok) throw new Error(`Couldn’t list comments (${list.status})`);
  const entries = (await list.json()).filter((e) => e.ext === 'json' || /\.json$/.test(e.name));

  const comments = await Promise.all(entries.map((e) => {
    const id = e.name.replace(/\.json$/, '');
    return daFetch(`${DA_ADMIN}/source/${base}/${id}.json`, token)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => (c ? { id, ...c } : null))
      .catch(() => null);
  }));
  return toThreads(comments.filter(Boolean)).map((t) => ({ ...t, docId }));
}

/** IMS user id from the access token (the editor uses it as comment author id). */
function tokenUserId(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.user_id || payload.sub || null;
  } catch {
    return null;
  }
}

/** Comment author in the editor's shape: { id, name, email }. */
export function commentAuthor(token, user = {}) {
  const email = user.emailAddr || user.email || '';
  return {
    id: tokenUserId(token) || email || 'workfront-panel',
    name: user.name || email || 'Workfront panel',
    email,
  };
}

const demoReplies = [];

/** Add a reply to a comment thread. Returns the saved reply. */
export async function replyToComment({
  org, site, docId, threadId, body, author, token, now = Date.now(),
}) {
  const id = crypto.randomUUID();
  const reply = {
    id, threadId, author, body, createdAt: now,
  };
  if (!token) {
    demoReplies.push(reply);
    return reply;
  }
  const form = new FormData();
  form.append('data', new Blob([JSON.stringify(reply)], { type: 'application/json' }));
  const resp = await daFetch(`${DA_ADMIN}/source/${org}/${site}/.da/comments/${docId}/${id}.json`, token, {
    method: 'POST', body: form,
  });
  if (!resp.ok) throw new Error(`Couldn’t reply to the comment (${resp.status})`);
  return reply;
}

/** Sample comments for demo / standalone mode. */
export function demoComments() {
  const now = Date.now();
  const ago = (mins) => now - mins * 60 * 1000;
  const reviewer = { id: 'u-2', name: 'Jamie Rivera', email: 'jamie@example.com' };
  const me = { id: 'u-me', name: 'Demo Author', email: 'demo@example.com' };
  return toThreads([
    {
      id: 'c-1',
      threadId: null,
      author: reviewer,
      body: 'Hero image feels dark on mobile — can we swap for the lighter crop from the spring shoot?',
      anchorText: 'Brewed for spring mornings',
      createdAt: ago(180),
      resolved: false,
    },
    {
      id: 'c-2', threadId: 'c-1', author: me, body: 'Agreed, I’ll check the DAM for usage rights.', createdAt: ago(120),
    },
    {
      id: 'c-3',
      threadId: null,
      author: reviewer,
      body: 'Legal needs to approve the “100% sustainable” claim before publish.',
      anchorText: '100% sustainable beans',
      createdAt: ago(60),
      resolved: false,
    },
    {
      id: 'c-4',
      threadId: null,
      author: me,
      body: 'Fix typo in the footer.',
      createdAt: ago(600),
      resolved: true,
    },
    ...demoReplies,
  ]);
}
