# TaskFlow Node.js backend

The backend is a dependency-free Node.js HTTP service for the dashboard. It provides PIN authentication, role permissions, persistent dashboard data, a change log, ClickUp snapshots, and protected file storage.

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

The Vite development server proxies `/api` requests to `http://localhost:8889`. Open the URL printed by Vite. On first use, create the dashboard admin PIN. Use `npm run dev:frontend-only` in the frontend folder only when you intentionally want the browser-only demo.

Run the backend tests with:

```powershell
npm test
```

## Data and configuration

By default, dashboard records and the audit log are stored in the SQLite database `Backend/data/taskflow.sqlite`; uploaded files are stored in `Backend/uploads/`. Override these locations with `DATA_DIR` and `UPLOAD_DIR`. Both directories are intentionally excluded from version control. Back up both directories using your company’s approved process.

Existing installations with `Backend/data/store.json` are imported into SQLite on first startup. The original JSON file is left in place as a backup.

Copy `.env.example` to `.env` to configure the service. Important options:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8889` | HTTP port |
| `HOST` | `127.0.0.1` | Listen address; use a reverse proxy for public access |
| `NODE_ENV` | development | Enables the `Secure` session cookie in production |
| `DATA_DIR` | `./data` | SQLite database directory |
| `UPLOAD_DIR` | `./uploads` | File storage directory |
| `PIN_LOOKUP_SECRET` | unset | Optional secret to speed role PIN lookup for larger teams; keep it stable |
| `CLICKUP_API_TOKEN` | unset | Optional server-only ClickUp token |

The server stores PINs as salted scrypt hashes. Session cookies are HttpOnly and SameSite strict; in-memory sessions are cleared when the backend restarts. Login attempts are rate limited. Uploaded files are limited to 100 MB each.

## Production notes

This SQLite-backed service is intended for a single Node.js instance with persistent disk. Run it behind HTTPS and a reverse proxy; do not expose the development server directly to the internet. Configure persistent backups and restrict filesystem access to the service account. The database and uploaded documents are not encrypted at rest. Vercel serverless storage is not a suitable persistence location for this backend.

The admin-only Activity Log records sign-ins, data changes, file operations, user changes, and ClickUp syncs without storing submitted field contents. It does not record reads, unsaved form drafts, or temporary UI messages. The complete records themselves are stored separately in the SQLite application state.

Meeting records are stored, but Google Meet and Zoom OAuth integrations are not configured by this service; it returns provider launch links. Meeting-minute drafts are local rule-based drafts, not an AI integration.
