# Workfront Tasks — Experience Workspace side-panel plugin

View, update, complete and create Workfront tasks without leaving Experience Workspace.

Vanilla JS, no build step, no dependencies. It follows the
[App SDK](https://www.aem.live/docs/ew/developing/apps-plugins) pattern (`DA_SDK` → `{ context, token, actions }`).

## Features

| | |
|---|---|
| **Task list** | My open tasks / Requested by me / Completed (14 days), with search, status, due date (overdue in red), priority and progress |
| **Details** | Name, status, priority, progress, due date, description, project, assignees, requester, and updates (comments) |
| **Update** | Changes only the fields you edited (`PUT /task/{id}`) |
| **Complete** | One click from the list or the details view (`status=CPL`, `percentComplete=100`) |
| **Create** | Choose a project, set a due date and priority, assign the task to yourself, and optionally link the page you're editing |
| **Permissions** | Uses your Workfront license and access level for tasks to hide edit and create actions. Workfront still has the final say: if it returns a 403, the task becomes 🔒 view-only |
| **Ask Assistant** | Puts the task into the Experience Workspace Assistant prompt with `actions.setPrompt`. You review it before sending |

## Files

```
tools/plugins/workfront/
├── workfront.html   # entry point loaded in the side panel iframe
├── workfront.js     # UI and state (list / detail / create / settings)
├── workfront.css    # panel styles built on Spectrum 2 tokens (--s2-*)
├── api.js           # Workfront REST client, permission derivation, date parsing
└── mock.js          # in-memory demo data (same interface as api.js)
proxy/
└── workfront-proxy.mjs  # zero-dependency dev proxy (CORS + host pinning)
app-builder/             # production proxy (Adobe App Builder web action)
├── app.config.yaml
├── .env.example
└── actions/workfront-proxy/index.js
```

## UI: Spectrum 2

The panel uses the same Spectrum 2 building blocks as Experience Workspace (da.live "nx2"). They are loaded at runtime from da.live, so there's no build step:

- `https://da.live/nx2/styles/styles.css`: S2 tokens (`--s2-*`) and Adobe Clean fonts
- `https://da.live/nx2/styles/buttons.css`: action/icon button classes (`nx-action-btn-*`)
- `https://da.live/nx2/public/sl/components.js`: form components `sl-input`, `sl-textarea`, `sl-select`, `sl-checkbox`, `sl-button`
- S2 icons (`S2_Icon_*_20_N.svg`) from da.live's nx2/nx icon folders, applied as CSS masks

These are internal da.live assets rather than a published package, so they can change without notice. If one breaks, pin a copy under `tools/plugins/workfront/vendor/`.

## Connection modes

Workfront's API normally can't be called directly from the browser because it doesn't send CORS headers, so the plugin supports these modes:

| Mode | How it authenticates | Use for |
|---|---|---|
| `demo` (default) | Uses mock data and makes no network calls | Trying out the UI |
| `proxy` | Sends the author's IMS token (`Authorization: Bearer`) to your proxy, which calls Workfront | **Real deployments** |
| `ims` | Sends the IMS token straight to the Workfront host | Only works if your instance accepts the token and allows CORS |
| `apikey` | Adds `?apiKey=` and calls Workfront directly (the key is kept in sessionStorage) | Local development only |

Settings come from these places; later ones override earlier ones:
1. Defaults
2. Query parameters on the plugin URL (`mode`, `host`, `proxyUrl`, `apiVersion`), which set site-wide defaults
3. The author's own saved settings (⚙ in the panel)

## Run locally

```bash
# In your EDS project (copy tools/plugins/workfront into it):
aem up                                   # serves http://localhost:3000

# Optional, real data (dev): proxy with an API key
WF_HOST=https://markszulc.my.workfront.com WF_API_KEY=xxxx node proxy/workfront-proxy.mjs
```

Opening `http://localhost:3000/tools/plugins/workfront/workfront.html` directly shows **standalone mode**: the SDK times out after 3 seconds and the panel uses demo data.

## Register in the side panel

In `https://da.live/config#/{org}/{site}/`, add a row to the **library** sheet:

| title | path |
|---|---|
| Workfront (local) | `http://localhost:3000/tools/plugins/workfront/workfront.html` |
| Workfront | `https://main--{site}--{org}.aem.live/tools/plugins/workfront/workfront.html?mode=proxy&proxyUrl=https://<namespace>.adobeioruntime.net/api/v1/web/workfront/proxy&host=markszulc.my.workfront.com` |

Save the config, open a page in Canvas, and choose **Workfront** from the side-panel switcher.

## Production proxy (App Builder)

The `app-builder/` action handles each request like this:
1. It checks the author's IMS token against IMS (`/ims/profile/v1`) to get their email.
2. It optionally checks the email against `ALLOWED_EMAIL_DOMAINS`.
3. It calls Workfront **as that author**, so Workfront applies that author's own permissions.

```bash
cd app-builder
cp .env.example .env     # set WF_HOST, WF_ADMIN_API_KEY, ALLOWED_EMAIL_DOMAINS
aio app use              # choose your App Builder project/workspace
aio app deploy           # prints the action URL
```

Then set the plugin's `proxyUrl` to the action URL, for example
`https://<namespace>.adobeioruntime.net/api/v1/web/workfront/proxy`, and use `mode=proxy`.

`WF_AUTH_STRATEGY` controls how the action authenticates to Workfront:
- `impersonate` (default): uses a Workfront admin API key to log in as the author (`POST /login?username=<email>&apiKey=…`). Sessions are cached for 10 minutes. The admin key stays on the server.
- `passthrough`: forwards the IMS token. Use this only if your Workfront instance accepts Adobe IMS tokens.

The action only forwards `/attask/api/v*/…` to `WF_HOST`. It also strips `apiKey`, `sessionID`, `username` and `password` from the query string the caller sends.

## Production notes / TODO

- **Verify on your instance:** check that admin-key impersonation (`/login?username=`) is enabled, or that IMS passthrough works, and that each author's IMS email matches their Workfront username.
- `proxy/workfront-proxy.mjs` is for development only. It passes the IMS token through, or uses a shared API key.
- Both proxies only forward to `WF_HOST`, so they can't be used to reach other hosts (SSRF). CORS is limited to `localhost:3000`, `da.live` and `*--*--*.aem.page|live`.
- The status picker only offers the built-in `NEW`, `INP` and `CPL`. Custom statuses aren't loaded yet.
- "Complete" sets `status=CPL`. Tasks that need approval may need Workfront's approval flow instead.
