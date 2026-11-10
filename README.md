# TaskFlow Node.js backend

The backend is a Node.js HTTP service for the dashboard. It provides PIN authentication, role permissions, persistent dashboard data, a change log, ClickUp snapshots, and protected file storage.

## Requirements

- Node.js 22.13 or newer
- npm

## Run locally

In one terminal:

```powershell
cd Backend
npm start
```

In another terminal:

```powershell
cd frontend
npm run dev
```

The Vite development server proxies `/api` requests to `http://localhost:8889`. Open the URL printed by Vite. On first use, create the dashboard admin PIN. The default frontend uses the shared backend database. Use `npm run dev:frontend-only` in the frontend folder only when you intentionally want isolated browser-only demo storage.

Run the backend tests with:

```powershell
npm test
```

## Deploy to Vercel

Import the backend repository into Vercel and set its **Root Directory** to the repository root. Use the **Other** framework preset and leave the build command and output directory empty. Vercel serves `/api/*` through `api/[...path].js`; do not configure `src/server.js` as a function entrypoint.

Add `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` to the Vercel project's Production environment (and Preview/Development if those deployments need the service). `DATABASE_URL` must point to a Postgres database, and the Blob token must belong to a private Vercel Blob store. The deployment's health check is available at `/api/health`.

## Data and configuration

For local development, dashboard records and the audit log are stored in the SQLite database `Backend/data/taskflow.sqlite`; uploaded files are stored in `Backend/uploads/`. Override these locations with `DATA_DIR` and `UPLOAD_DIR`. Both directories are intentionally excluded from version control. Back up both directories using your company’s approved process.

When `DATABASE_URL` is set, the backend uses Postgres for dashboard records, audit history, sessions, and login throttling, and uses a private Vercel Blob store for uploads. Configure `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` in the Vercel project. The Vercel deployment initializes an empty data store; it does not import the local SQLite database or local uploads.

Existing installations with `Backend/data/store.json` are imported into SQLite on first startup. The original JSON file is left in place as a backup.

Copy `.env.example` to `.env` to configure the service. Important options:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8889` | HTTP port |
| `HOST` | `127.0.0.1` | Listen address; use a reverse proxy for public access |
| `NODE_ENV` | development | Enables the `Secure` session cookie in production |
| `DATA_DIR` | `./data` | SQLite database directory |
| `UPLOAD_DIR` | `./uploads` | File storage directory |
| `DATABASE_URL` | unset | Optional Postgres connection string; enables Vercel persistence instead of local SQLite |
| `BLOB_READ_WRITE_TOKEN` | unset | Required with `DATABASE_URL`; read/write access to the private Vercel Blob store |
| `CRON_SECRET` | unset | Required to authorize Vercel's daily Gmail watch-renewal cron when Gmail Pub/Sub is enabled |
| `PIN_LOOKUP_SECRET` | unset | Optional secret to speed role PIN lookup for larger teams; keep it stable |
| `CLICKUP_API_TOKEN` | unset | Optional server-only ClickUp token |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | Google OAuth web client; keep the secret in the backend `.env` only |
| `GOOGLE_REDIRECT_URI` | `http://localhost:8889/api/mails/auth/google/callback` | OAuth callback URL registered with Google |
| `MAILS_TOKEN_ENCRYPTION_KEY` | unset | Required 32-byte base64 key for encrypting Gmail refresh tokens in SQLite |
| `MAILS_SEND_AS_EMAIL` | `bilel.m@natheelco.com` | Preferred verified Gmail send-as alias |
| `MAILS_APP_URL` | `http://localhost:5173/` | Frontend URL opened after Gmail authorization |
| `MAILS_PUBSUB_TOPIC` | unset | Optional Gmail watch topic resource name |
| `MAILS_PUBSUB_SUBSCRIPTION` | unset | Optional expected Pub/Sub push subscription resource name |
| `MAILS_PUBSUB_AUDIENCE` | unset | Optional exact audience expected in Pub/Sub OIDC tokens |
| `MAILS_PUBSUB_SERVICE_ACCOUNT` | unset | Optional service account email used to authenticate Pub/Sub push |

The server stores PINs as salted scrypt hashes. Session cookies are HttpOnly and SameSite strict; in-memory sessions are cleared when the backend restarts. Login attempts are rate limited. Uploaded files are limited to 100 MB each.

## Gmail Mails

The Mails page connects one Gmail account per signed-in TaskFlow user. Gmail access tokens are kept in backend memory; refresh tokens are encrypted with AES-256-GCM before being stored in SQLite. The encryption key is not stored in the database, so back it up separately and keep the same key across restarts. Losing or changing the key requires users to disconnect and reconnect Gmail. Never commit OAuth credentials or the encryption key.

To configure the integration:

1. In Google Cloud Console, create/select a project, enable the Gmail API, and configure the OAuth consent screen and an OAuth Client ID of type **Web application**.
2. Register the exact `GOOGLE_REDIRECT_URI` from `.env.example` as an authorized redirect URI. The callback hostname must match the browser-facing app hostname so the short-lived OAuth state cookie is returned; for production, route a same-origin HTTPS callback path such as `https://app.example.com/api/mails/auth/google/callback` through the reverse proxy to this backend.
3. Copy `.env.example` to `.env`, then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Generate a strong encryption key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` and place its output in `MAILS_TOKEN_ENCRYPTION_KEY`. Set `MAILS_APP_URL` to the browser-facing frontend URL.
4. In the Gmail account you connect, add and verify `bilel.m@natheelco.com` under **Settings → Accounts → Send mail as**. Gmail only permits sending from the primary account or a verified alias on that account; this setting does not grant access to Bilel’s mailbox by itself.
5. Restart the backend, sign in, open **Mails**, and choose **Connect with Google**. Grant Gmail modify, send, and send-as settings access. Existing connections must disconnect and reconnect to grant the added send-as permission.

For optional Pub/Sub push updates, deploy the API behind a public HTTPS URL first. Create a Pub/Sub topic in the Google Cloud project, grant `gmail-api-push@system.gserviceaccount.com` permission to publish to it, and create a push subscription targeting `https://<your-api-host>/api/mails/pubsub`. Configure OIDC authentication on that subscription with a dedicated service account and audience, grant the Pub/Sub service agent permission to mint tokens for that account, then set the exact topic and subscription resource names, audience, and service-account email in the four `MAILS_PUBSUB_*` variables. Restart the backend; it registers a Gmail watch when an account connects and renews watches daily. Leave all four settings blank to use history polling only. Push requests are accepted only with a valid Google-signed OIDC token matching the configured audience and service account and the expected subscription.

The dashboard shows the latest messages and unread count from the signed-in user’s connected Gmail inbox; it does not forward messages to another person. The Mails page retrieves messages and labels directly from Gmail, uses Gmail History API checkpoints, and checks for updates while the page is open; optional Pub/Sub notifications also advance the history checkpoint. It does not create a local mailbox copy. Google OAuth consent-screen verification may be required before using Gmail scopes with accounts outside a configured test-user list. Mail content is displayed as plain text; attachments are delivered as downloads rather than rendered in the browser.

## CEO Dashboard API

`GET /api/dashboard/ceo` returns the CEO dashboard's server-calculated task totals, status breakdown, overdue and recent tasks, project progress, and employee KPI scorecard. It uses the existing SQLite-backed TaskFlow tasks and history together with the latest saved ClickUp snapshot. Optional `project`, `assignee`, and `status` query parameters apply the dashboard's current filters. Access requires an admin session or the CEO Dashboard (`dash`) permission. The dashboard refreshes this summary alongside its existing task and integration refreshes.

## Production notes

Without `DATABASE_URL`, this SQLite-backed service is intended for a single Node.js instance with persistent disk. Run it behind HTTPS and a reverse proxy; do not expose the development server directly to the internet. Configure persistent backups and restrict filesystem access to the service account. In Vercel mode, keep the Postgres database and Blob store private, enable backups, and configure their access in Vercel. Gmail OAuth state and login sessions are stored in Postgres so they work across serverless instances.

The admin-only Activity Log records sign-ins, data changes, file operations, user changes, and ClickUp syncs without storing submitted field contents. It does not record reads, unsaved form drafts, or temporary UI messages. The complete records themselves are stored separately in the SQLite application state.

Meeting records are stored, but Google Meet and Zoom OAuth integrations are not configured by this service; it returns provider launch links. Meeting-minute drafts are local rule-based drafts, not an AI integration.
