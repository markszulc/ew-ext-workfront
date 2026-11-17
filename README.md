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
- Ask Coworker to help complete a task, using its name and description

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

For production, follow [Set up the production proxy](#set-up-the-production-proxy-app-builder) below.

## Set up the production proxy (App Builder)

### Why a proxy is needed

Browsers can't call the Workfront API directly, because Workfront doesn't send CORS headers. The panel instead sends each request, together with the author's Adobe sign-in token (IMS token), to a small server-side function, which calls Workfront for them.

That function runs on **Adobe App Builder**, Adobe's serverless platform (I/O Runtime). You don't need to manage a server. For each request it:

1. Checks the author's Adobe token with Adobe IMS and reads their email address.
2. Logs in to Workfront **as that author**, using a Workfront admin API key that stays on the server. This means Workfront applies the author's own permissions.
3. Forwards the request to your Workfront host and returns the result to the panel.

The code is in [`app-builder/actions/workfront-proxy/index.js`](app-builder/actions/workfront-proxy/index.js).

### What you need

| Requirement | How to check |
|---|---|
| An Adobe ID in an Adobe organization that is entitled to **App Builder** | Sign in at [developer.adobe.com/console](https://developer.adobe.com/console), select your organization (top right), and choose **Create project from template**. If **App Builder** is listed, you're entitled. If not, ask your Adobe admin or [request a trial](https://developer.adobe.com/app-builder/trial/). |
| **Workfront administrator** access | Needed once, to generate the admin API key |
| **Node.js 20 or later** | `node -v` |
| **Matching emails:** each author's Adobe ID email must match their Workfront username or the email address on their Workfront user | Spot-check a few users in Workfront under **Setup › People** |

### Step 1: Install the Adobe I/O CLI

```bash
npm install -g @adobe/aio-cli
aio --version          # should print a version number
aio login              # opens a browser; sign in with your Adobe ID
```

### Step 2: Create an App Builder project

1. Go to [developer.adobe.com/console](https://developer.adobe.com/console) and make sure the correct organization is selected at the top right.
2. Choose **Create project from template**, then **App Builder**.
3. Give it a name, such as `Workfront Panel Proxy`. Keep the default **Stage** and **Production** workspaces, and choose **Save**.

A workspace is an isolated environment with its own URL. Use **Stage** for testing and **Production** for real use.

### Step 3: Connect this folder to the project

1. In the [Developer Console](https://developer.adobe.com/console), open your project and select the **Stage** workspace.
2. Choose **Download all** (top right). This downloads a workspace configuration file named something like `<org>-<project>-Stage.json`.
3. Connect this folder to that workspace using the file:

   ```bash
   git clone https://github.com/markszulc/ew-ext-workfront.git
   cd ew-ext-workfront/app-builder
   aio app use ~/Downloads/<org>-<project>-Stage.json
   ```

`aio app use` writes your deployment credentials to `app-builder/.env` and `app-builder/.aio`. Both are git-ignored, so never commit them. If it asks about an existing `.env`, choose **Merge**.

The downloaded JSON file contains credentials. Delete it, or keep it somewhere safe outside the repo.

### Step 4: Create a Workfront admin API key

1. Sign in to Workfront as an administrator.
2. Open the **Main Menu**, then go to **Setup › System › Customer Info**.
3. In **API Key Settings**, choose **Generate API Key**, and copy the key.

This key lets the proxy act as **any** Workfront user. Treat it like a password: never put it in the plugin, a URL or git. It goes only in `.env` on your machine, and into App Builder when you deploy. Check the key's expiry date in API Key Settings.

### Step 5: Configure the proxy

Add these settings to the end of `app-builder/.env`, below the `AIO_…` lines that `aio app use` added. [`.env.example`](app-builder/.env.example) shows the same settings.

```bash
WF_HOST=https://markszulc.my.workfront.com
WF_AUTH_STRATEGY=impersonate
WF_ADMIN_API_KEY=paste-the-key-from-step-4
ALLOWED_ORIGINS=http://localhost:3000,https://da.live,https://markszulc.github.io
ALLOWED_EMAIL_DOMAINS=yourcompany.com
```

| Setting | Meaning |
|---|---|
| `WF_HOST` | Your Workfront URL. This is the only host the proxy will call. |
| `WF_AUTH_STRATEGY` | `impersonate` (recommended): log in as each author with the admin key. `passthrough`: forward the Adobe token directly, which only works if your Workfront accepts Adobe IMS tokens. |
| `WF_ADMIN_API_KEY` | The key from step 4 |
| `ALLOWED_ORIGINS` | Web pages allowed to call the proxy. Pages on `*.aem.page` and `*.aem.live` sites are always allowed. |
| `ALLOWED_EMAIL_DOMAINS` | Recommended. Only authors with these email domains (comma-separated) can use the proxy. Leave it empty to allow any Adobe ID that has a Workfront user. |

### Step 6: Deploy

```bash
aio app deploy
```

When it finishes, the CLI prints the action's URL, for example:

```
https://123456-workfrontpanelproxy-stage.adobeioruntime.net/api/v1/web/workfront/proxy
```

You can print it again at any time with `aio app get-url`. **This URL is your `proxyUrl`.**

### Step 7: Check that it responds

```bash
PROXY=https://<your-url>/api/v1/web/workfront/proxy

# Without a token you should get 401 {"error":{"message":"Missing IMS token"}}, which means the proxy is running
curl -i "$PROXY/attask/api/v19.0/user/search"

# CORS check: the response headers should include access-control-allow-origin: https://da.live
curl -i -X OPTIONS -H "Origin: https://da.live" "$PROXY/attask/api/v19.0/task/search"
```

### Step 8: Point the panel at the proxy

You can set this up for a whole site, or just for yourself.

- **For everyone on a site:** in `https://da.live/config#/{org}/{site}/`, set the **library** sheet path to:
  ```
  https://markszulc.github.io/ew-ext-workfront/tools/plugins/workfront/workfront.html?mode=proxy&host=markszulc.my.workfront.com&proxyUrl=<your proxyUrl>
  ```
- **For just you:** in the panel, open **Settings** (the sliders icon), set **Connection** to *Proxy with IMS token*, fill in the Workfront host and the proxy URL, and choose **Save & connect**.

Open a page in Experience Workspace and choose **Workfront** in the side panel. Your own Workfront tasks should appear, and the header should show your Workfront name.

### Updating, logs and production

| Task | Command |
|---|---|
| Redeploy after changing code or `.env` | `aio app deploy` |
| See recent requests and errors | `aio app logs`, or `aio rt activation list` and then `aio rt activation logs <id>` |
| Deploy to production | In the Developer Console, select the **Production** workspace and choose **Download all**. Run `aio app use ~/Downloads/<org>-<project>-Production.json`, add your `WF_…` settings to `.env` again, then run `aio app deploy`. Production gets its own URL. |
| Remove the deployment | `aio app undeploy` |

### Troubleshooting

| What you see | Likely cause and fix |
|---|---|
| `401 Missing IMS token` in the panel | The panel isn't running inside Experience Workspace, so it has no token. Open it from the da.live side panel. |
| `401 Invalid or expired IMS token` | Sign out of da.live and sign back in. |
| `403 … is not allowed to use this proxy` | The author's email domain isn't listed in `ALLOWED_EMAIL_DOMAINS`. |
| `… Workfront rejected WF_ADMIN_API_KEY` or `You are not currently logged in` | Test the key directly: `curl "https://<host>.my.workfront.com/attask/api/v19.0/user/search?fields=username,emailAddr&apiKey=<key>"`. If that also fails, generate a new key (step 4). If it works, the deployed value is wrong: check `.env` for typos and quotes, run `aio app deploy`, and confirm with `aio rt action get workfront/proxy`. |
| `403 Couldn't sign in to Workfront as …` | The proxy tries the author's email as their Workfront username, then looks up an active user whose email address matches. The message includes Workfront's reason. Common fixes: set the author's Workfront email address to match their Adobe ID, check that the user is active, and check that the admin API key is valid and hasn't expired. |
| `500 WF_HOST / WF_ADMIN_API_KEY is not configured` | The setting is missing from `.env`. Add it and run `aio app deploy` again. |
| A CORS error in the browser console | The page's origin isn't in `ALLOWED_ORIGINS`. Add it and run `aio app deploy` again. |
| `aio app deploy` says no workspace or credentials | Run `aio app use <downloaded workspace JSON>` from inside the `app-builder/` folder (see step 3). |
| App Builder doesn't appear in the Developer Console | Your organization isn't entitled to App Builder, or the wrong organization is selected. |

## Documentation

See the [plugin README](tools/plugins/workfront/README.md) for connection modes, settings, security notes and known limitations.
