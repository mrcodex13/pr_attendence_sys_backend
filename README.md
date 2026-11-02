# Backend

Express API for the PR Smart Attendance frontend. The code layout and AMB82-Mini integration boundary are described in [ARCHITECTURE.md](./ARCHITECTURE.md); API shapes and pending hardware/product decisions are in [API_CONTRACT.md](./API_CONTRACT.md).

## Local setup

1. Use Node.js 20.19 or newer (required by the installed Mongoose version).
2. Install dependencies with `npm install`.
3. Copy `.env.example` to `.env` and configure MongoDB, Supabase, and the encryption key. MongoDB stores the application records; Supabase stores only encrypted face descriptors.
4. Start the API with `npm run dev`; it listens on port `8000` by default. The frontend's Vite proxy is configured for this port.

Apply `supabase/migrations/20261031000000_create_camera_face_templates.sql` to the Supabase project before using camera enrollment. Configure `SUPABASE_URL` and `SUPABASE_SECRET_KEY` only in the backend environment; the secret key must never be placed in a `VITE_` variable. `FACE_TEMPLATE_ENCRYPTION_KEY` must be a stable private key of at least 32 characters.

### AMB82 Mini RTSP camera

Install FFmpeg on the backend machine and make it available on `PATH`, or set
`FFMPEG_PATH` in `.env`. Set `AMB82_RTSP_URL` to the RTSP URL provided by the
camera firmware, then restart the backend. Keep the URL and any camera
credentials private; do not put them in frontend variables. Use **Connect
AMB82 Mini** on the camera attendance page. FFmpeg uses low-delay flags and
outputs up to five preview frames per second; the browser polls independently
of face-detection work so inference does not pause frame updates. The first
frame can take a few seconds while FFmpeg connects. The board and backend must
be able to reach each other over the network, and the camera firmware must have
RTSP streaming enabled. RTSP path and authentication details depend on the
firmware build.

#### Use an AMB82 with the deployed website

The Render backend cannot reach a camera on a user's private Wi-Fi. To keep the
AMB82 firmware unchanged and use the deployed website, run the local connector
on the Windows laptop that can already open the camera stream in VLC:

1. Install FFmpeg on that laptop and ensure `ffmpeg.exe` is on `PATH` (or set
   `FFMPEG_PATH` in the backend `.env` file).
2. From this backend repository, run `npm run camera:bridge`. This local-only
   service listens on `127.0.0.1:8765`; it does not expose RTSP or listen on the
   network. Keep the terminal open while using attendance.
3. Sign into the deployed website on the same laptop, select **AMB82-Mini
   (Local)**, paste the exact RTSP URL that works in VLC, and choose **Save
   URL**. The browser may ask permission to connect to a local device; allow it.
4. Start the camera and scan. Face recognition runs in that browser, while
   attendance records continue to be sent to the deployed API.

The RTSP URL is sent only to the loopback connector, not saved in Render or
logged by the connector. The connector uses the website origins in
`CAMERA_BRIDGE_ALLOWED_ORIGINS` (or `ALLOWED_ORIGINS`/`CORS_ORIGINS` from the
backend `.env`). If the deployed site uses a different origin, set
`CAMERA_BRIDGE_ALLOWED_ORIGINS` before running the command, for example in
PowerShell:

```powershell
$env:CAMERA_BRIDGE_ALLOWED_ORIGINS = "https://your-actual-frontend.example"
npm run camera:bridge
```

By default, the connector allows the existing Vercel site origin and
`http://localhost:5173`. Do not add wildcard origins. The connector needs Node
dependencies installed in this repository and FFmpeg on the laptop. Press
Ctrl+C in its terminal when finished. If it is not running, the website cannot
read the local camera even if VLC is playing.

Existing encrypted templates can be moved from MongoDB with `npm run migrate:camera-templates` after applying the SQL migration and configuring both database connections. The script verifies every copied ciphertext before deleting the MongoDB source rows. Do not rotate or lose the face-template encryption key without a template migration plan.

In development, the server starts for local liveness checks even if MongoDB is not configured or is temporarily unreachable. When a URI is configured, it retries failed connections every five seconds; `/api/v1/health/ready` returns `503` until the database connects. Production startup requires MongoDB and Supabase settings, explicit `ALLOWED_ORIGINS` (or the legacy `CORS_ORIGINS` alias), and an access-token secret of at least 32 characters. SMTP is optional. The confirmed tenancy model is multiple organizations per deployment.

Email is disabled unless `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, and `MAIL_FROM` are all set. When disabled, the app logs one startup warning; password reset by email and scheduled report delivery are unavailable. Invitation codes are still generated and shown to authorized administrators to share manually, and in-app notifications continue to work. To enable email later, add all four SMTP values (and optionally `SMTP_PORT` and `SMTP_SECURE`) to the backend environment, then restart or redeploy the service.

## Deploying to Render

This backend is an Express/Node.js service and can be deployed from the included `render.yaml` Blueprint.

- **Build command:** `npm ci`
- **Start command:** `npm start`
- **Health check:** `GET /health` (public, returns `{"status":"ok"}`)
- **Runtime:** Node.js 20.19 or newer; Render injects `PORT`, and the server binds to `0.0.0.0`.

Create a Render Blueprint from the repository containing this file, then enter the required values for all `sync: false` variables in Render's environment settings. Set `ALLOWED_ORIGINS` to the exact HTTPS origin(s) serving the frontend, comma-separated without paths; do not use `*`. Set `APP_URL` to the public frontend origin. `CORS_ORIGINS` remains accepted as a backwards-compatible alias, but new deployments should use `ALLOWED_ORIGINS`. SMTP variables are intentionally not required by the Blueprint; add all four required SMTP values later if email delivery is available.

### Database and first-time setup

This application uses **MongoDB**, not PostgreSQL. Set `MONGODB_URI` to the production MongoDB connection string, including the intended database name, and allow Render's outbound network access in the database provider. Do not set `DATABASE_URL` to a PostgreSQL URL; the application does not implement that database adapter.

There are no MongoDB schema migration files: Mongoose models define the collections and indexes. Before enabling camera enrollment, apply `supabase/migrations/20261031000000_create_camera_face_templates.sql` once to the production Supabase project. Set `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and a stable `FACE_TEMPLATE_ENCRYPTION_KEY` before starting the service. Existing MongoDB face templates need the separately documented `npm run migrate:camera-templates` process; do not run it unless migrating existing encrypted templates.

After MongoDB is ready, create the initial platform administrator by running `npm run seed:admin` once from a trusted machine configured with the production database and `SEED_ORG_NAME`, `SEED_ORG_SLUG`, `SEED_ADMIN_NAME`, `SEED_ADMIN_EMAIL`, and a unique strong `SEED_ADMIN_PASSWORD`. These one-time seed variables are not part of the running service's Blueprint configuration. Never commit production environment files or credentials.

### Frontend connection

The frontend uses relative `/api/v1` requests. In development, Vite proxies these requests to `http://127.0.0.1:8000`. In production, configure the frontend host to proxy `/api/*` (and `/uploads/*` if used) to the Render API, or change the frontend API base URL to the API's HTTPS origin and ensure `ALLOWED_ORIGINS` contains the exact frontend origin. A same-origin proxy avoids cross-origin browser configuration.

The current frontend stores bearer access and refresh tokens in browser local storage; it does not use authentication cookies. Consequently, `HttpOnly`, `Secure`, and `SameSite` cookie attributes do not apply to the existing auth flow. Moving authentication to HttpOnly cookies would require a coordinated frontend/backend and CSRF-protection change; it is not silently enabled by this deployment setup.

### Optional email delivery

The service starts without SMTP configuration. Without all four of `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, and `MAIL_FROM`, password-reset email and scheduled report delivery are disabled; the forgot-password page shows a clear setup message, and scheduled-report creation returns `EMAIL_NOT_CONFIGURED`. Invitation codes remain available in the admin UI for manual sharing, and app notifications are in-app rather than email. Add the four values to the Render service environment when using an SMTP provider that permits outbound connections, then redeploy.

### Render free-tier and AMB82 limitations

Render's free web service can sleep after inactivity and has limited CPU/RAM. It is suitable for trying the dashboard/API, not for guaranteed always-on attendance processing. The backend does not persist application records or face templates to its local filesystem: records use MongoDB and encrypted face templates use Supabase. Any runtime state held in memory is lost on restart.

The current AMB82 RTSP integration is **not deployable as-is on the standard Render Node runtime**: it requires FFmpeg, and Render cannot ordinarily reach a camera's private LAN IP. The current face recognition also runs in the browser, so attendance only runs while an authorized user keeps the Camera attendance page open. For unattended, standalone attendance, keep an always-on recognition service on the camera's local network (or implement and validate recognition/attendance firmware on the board); deploy the dashboard/API separately. A powerbank only powers the camera and does not provide Wi-Fi or backend connectivity.

Face-api.js models are loaded by the browser camera workflow, not at backend startup. The Node service itself does not load ML models, but FFmpeg video processing and continuous camera access are not appropriate for a sleeping, resource-limited free instance.

## Checks

- `npm test` — run the backend tests.
- `npm start` — start the API without the development file watcher.

Implemented business APIs include authentication and organization membership, user administration, organization settings, sites, groups, people, schedules, attendance corrections, leave, dashboard aggregates, SSE live replay, in-app notifications, audit reads, privacy deletion-request review, CSV/XLSX exports, and optional scheduled SMTP report delivery. Device APIs now support tenant-scoped provisioning, encrypted one-time secrets, HMAC-signed requests, heartbeat/config, scan ingestion, command acknowledgements, and consent-gated enrollment state. The AMB82-Mini firmware must implement the documented protocol and be validated on the actual board before device attendance is considered operational. Automated retention/purge jobs remain disabled until custom retention periods and legal policy are approved; profile-photo upload remains deferred pending storage decisions.

### Device API setup

Set a stable private `DEVICE_SECRET_ENCRYPTION_KEY` in the backend environment (at least 32 random characters) before registering physical devices. If omitted, the backend derives the encryption key from `ACCESS_TOKEN_SECRET`; changing that secret will make existing device credentials unreadable, so rotate each device credential after changing it. The device HMAC format, endpoint payloads, clock window, scan contract, enrollment consent requirements, and retry behavior are documented in `API_CONTRACT.md`.

## Organization hierarchy

The platform super admin signs in without selecting an organization and opens **Organizations** to view all tenants, create school/company organizations, issue initial-admin registration codes, invite additional admins, and deactivate/reactivate organizations. Platform sessions are not bound to a tenant. Organization admins use their organization dashboard to manage staff and employees; teachers can invite students into assigned groups. Invite codes expire after 24 hours, are stored only as hashes, and are shown once for private sharing. Invitees register from `/register`, choosing a new password or entering their existing password to join another organization. Student and employee accounts receive a linked attendance record and can only view their own attendance. All roles use the same login page and are routed to role-appropriate features. Deactivation blocks sign-in and revokes tenant sessions without deleting organization records; the organization can be reactivated later.

## Initial super-admin account

Set `SEED_ORG_NAME`, `SEED_ORG_SLUG`, `SEED_ADMIN_NAME`, `SEED_ADMIN_EMAIL`, and a unique strong `SEED_ADMIN_PASSWORD` in the environment, then run `npm run seed:admin`. The script creates the organization and initial super admin if absent, never resets an existing account, and does not print the password. Do not commit real credentials.

For the local attendance demo roster, run `npm run seed:demo-accounts` from this backend directory. It reads the workspace-root `id_pas.md`, creates the documented organization/group and admin/employee accounts if missing, aligns only those accounts' password hashes to the listed demo passwords, and grants the configured seeded super admin membership in the demo organization. It does not print or copy passwords. Keep the credential file local and do not use this script with production data.

## Authentication

Access tokens use `Authorization: Bearer <token>`. Refresh tokens rotate and are stored hashed. User identities have a global unique email and separate role/group/status membership per organization. Organization users with multiple active memberships select a workspace after validating credentials. Platform super admins instead receive a tenant-independent session and go directly to the platform organization console.

Without SMTP, password-reset requests in production return a non-enumerating `EMAIL_NOT_CONFIGURED` response. For local development, set `DEV_PASSWORD_RESET_ENABLED=true` to show a one-time reset link only to loopback callers; the startup warning does not include credentials or reset tokens.

For local demos without SMTP, set `DEV_PASSWORD_RESET_ENABLED=true` while `NODE_ENV=development`. The forgot-password page will show a one-time reset link only for requests received over loopback. The link expires after one hour; the current password is never retrieved or displayed. This option is ignored in test and production environments.
