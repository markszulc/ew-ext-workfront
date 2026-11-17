# Workfront Tasks for Experience Workspace

A side-panel extension for [Experience Workspace](https://www.aem.live/docs/ew/developing/apps-plugins) (da.live) that lets authors view, update, complete and create Workfront tasks without leaving the editor. What each author can do follows their own Workfront permissions.

- **No build step:** vanilla JS that uses the Experience Workspace App SDK (`DA_SDK`)
- **Spectrum 2 UI:** uses da.live's own nx2 components, so it matches Experience Workspace
- **Demo mode:** works out of the box with mock data
- **Secure production proxy:** an Adobe App Builder action calls Workfront as the signed-in author

## Features

- See your tasks: assigned to me, requested by me, and recently completed, with search
- View task details and updates (comments)
- Edit name, status, priority, progress, due date and description
- Complete a task in one click
- Create tasks in a project, optionally linked to the page you're editing
- Send a task to the Experience Workspace Assistant prompt

## Repository layout

| Path | Purpose |
|---|---|
| [`tools/plugins/workfront/`](tools/plugins/workfront/) | The side-panel plugin (HTML, JS, CSS, Workfront client, demo data) |
| [`proxy/workfront-proxy.mjs`](proxy/workfront-proxy.mjs) | Zero-dependency Node proxy for local development |
| [`app-builder/`](app-builder/) | Production proxy as an Adobe App Builder web action |

## Try it now (GitHub Pages)

The plugin is hosted at:

**https://markszulc.github.io/ew-ext-workfront/tools/plugins/workfront/workfront.html**

- Open it directly to see the UI in standalone demo mode.
- To try it inside Experience Workspace, go to `https://da.live/config#/{org}/{site}/` and add a row to the **library** sheet with title `Workfront` and that URL as the path. Then open a page and choose **Workfront** in the side panel.
- To use live data, add query parameters, e.g. `…/workfront.html?mode=proxy&proxyUrl=<proxy URL>`. Both proxies already allow `https://markszulc.github.io` (CORS).

Every push to `main` redeploys the site within a minute or two.

## Quick start (your own project)

1. Copy `tools/plugins/workfront/` into your Edge Delivery Services project and run `aem up`.
2. In `https://da.live/config#/{org}/{site}/`, add a row to the **library** sheet:

   | title | path |
   |---|---|
   | Workfront | `http://localhost:3000/tools/plugins/workfront/workfront.html` |

3. Open a page in Experience Workspace and choose **Workfront** in the side panel. It starts in demo mode.

To use real Workfront data locally, start the dev proxy and pick **Proxy** in the panel's settings:

```bash
WF_HOST=https://markszulc.my.workfront.com WF_API_KEY=xxxx node proxy/workfront-proxy.mjs
```

For production, deploy the App Builder proxy:

```bash
cd app-builder
cp .env.example .env   # set WF_HOST and WF_ADMIN_API_KEY
aio app deploy
```

Then register the plugin with `?mode=proxy&proxyUrl=<action URL>&host=<your host>.my.workfront.com`.

## Documentation

See the [plugin README](tools/plugins/workfront/README.md) for connection modes, settings, the App Builder auth strategies, security notes and known limitations.
