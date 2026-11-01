# Attendance API contract — draft

This is the initial REST contract for replacing the frontend mock API. It is deliberately versioned at `/api/v1`. Confirmed decisions: one deployment serves multiple organizations, MongoDB Atlas is the target database, and user API requests use bearer access tokens. Device payload fields and transport remain to confirm before implementation.

## Conventions

- Base URL in local development: `http://localhost:5000`; the Vite `/api` proxy targets this server.
- JSON is used for requests and responses except binary/file exports.
- Success response: `{ "data": <resource-or-result>, "meta": { "requestId": "<id>" } }`.
- Error response: `{ "error": { "code": "<stable-code>", "message": "<safe-message>", "details"?: [...] }, "meta": { "requestId": "<id>" } }`.
- Dates are ISO `YYYY-MM-DD`; timestamps are RFC 3339/ISO 8601 UTC. Business calculations use the organization's configured IANA timezone.
- List endpoints accept `page` (1-based, default 1), `limit` (default 25, maximum 100), documented filters, and return `{ data: [], meta: { page, limit, total, requestId } }`.
- Expected statuses: `200` read/update, `201` creation, `202` queued async work, `204` successful no-content deletion, `400` malformed/invalid input, `401` unauthenticated, `403` unauthorized, `404` missing resource, `409` uniqueness/state conflict, `413` oversized payload, and `429` rate limit.
- Mutating requests must be validated server-side. Protected reads and writes must enforce both role permission and assigned-group scope.
- Tenant-scoped requests use `X-Organization-Id` to select the active organization. The server must verify that the authenticated user belongs to that organization; the header is a selector, never proof of access. Persisted tenant-owned records must include an organization reference, and every read/write/query must be tenant-scoped.
- `X-Request-Id` is generated per request and returned in response metadata/header. Logs must not include credentials, device secrets, biometric data, or request bodies.

## Health and service setup (implemented)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Backwards-compatible basic server status |
| GET | `/api/v1/health/live` | Process liveness; does not depend on MongoDB |
| GET | `/api/v1/health/ready` | Readiness; returns 503 until MongoDB is connected |

## User authentication and profile

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/auth/login` | Authenticate with email/password; return safe user and access/refresh credentials |
| POST | `/api/v1/auth/refresh` | Rotate/refresh credentials |
| POST | `/api/v1/auth/logout` | Revoke refresh session |
| GET | `/api/v1/auth/me` | Return authenticated user and group assignments |
| GET | `/api/v1/auth/organizations` | List organizations the authenticated user may access |
| POST | `/api/v1/auth/forgot-password` | Request reset; response must not reveal whether email exists |
| POST | `/api/v1/auth/reset-password` | Consume one-time reset token and set new password |
| POST | `/api/v1/auth/change-password` | Change current user's password |
| POST | `/api/v1/auth/accept-invitation` | Redeem a one-time registration code and activate a new or existing account |

Passwords are stored as hashes and cannot be recovered or returned by the reset flow. In local development only, setting `DEV_PASSWORD_RESET_ENABLED=true` returns a one-time reset URL to loopback requests; the token expires after one hour. This setting is ignored outside development. Production reset instructions continue to use email and the response does not reveal whether the account exists.

Login request: `{ "email": "person@example.edu", "password": "..." }`.
Login data: `{ "user": { "id", "name", "email", "role", "groupIds" }, "accessToken": "...", "refreshToken": "..." }`. Protected user requests send `Authorization: Bearer <accessToken>`. Organization selection is sent with `X-Organization-Id` and is validated against the user's memberships.

## Organization, users, groups, people, and schedules

Multi-organization login behavior: organization users with multiple active memberships must choose one after credential validation. Platform super admins instead receive a tenant-independent platform session and do not choose an organization. Platform sessions have no `organizationId` and must omit `X-Organization-Id`; they can access only platform-management routes.

For organization sessions, login accepts an optional `organizationId`; if omitted, the server requires organization selection when multiple active memberships exist and otherwise selects the sole active membership. The returned user includes the selected `organizationId` and active organization memberships. Platform super admins instead receive a tenant-independent session with no organization list or organization claim. Protected organization requests use a bearer token; an optional `X-Organization-Id` must match the tenant bound to an organization token and must be omitted for platform tokens. Refresh tokens are opaque, stored hashed, and rotated on use. Passwords are bcrypt-hashed and must be 12?128 characters with uppercase, lowercase, number, and symbol characters. Reset tokens are one-time, hashed, and expire after one hour. Production password-reset delivery requires SMTP configuration.

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/v1/organizations` | Platform-super-admin list/create organizations and issue each organization's initial admin code |
| POST | `/api/v1/organizations/:id/admin-invitations` | Platform-super-admin invite another organization admin or rotate an unclaimed admin invitation code |
| GET | `/api/v1/organizations/:id/admin-invitations` | Platform-super-admin list active admin invitations |
| DELETE | `/api/v1/organizations/:id/admin-invitations/:invitationId` | Platform-super-admin revoke an active admin invitation |
| PATCH | `/api/v1/organizations/:id` | Platform-super-admin deactivate/reactivate an organization without deleting its data |
| GET/POST | `/api/v1/invitations` | List active invitations or invite staff/students within authorized organization/group scope |
| DELETE | `/api/v1/invitations/:id` | Revoke an active staff/student invitation |
| GET/PATCH | `/api/v1/settings` | Read/update organization attendance settings |
| GET/POST | `/api/v1/sites` | List/create organization sites |
| PATCH | `/api/v1/sites/:id` | Update site metadata or active status |
| GET | `/api/v1/users` | Organization-admin list tenant-scoped accounts |
| GET/PATCH | `/api/v1/users/:id` | Read/update user, role, groups, active state |
| GET/POST | `/api/v1/groups` | List/create groups |
| GET/PATCH | `/api/v1/groups/:id` | Read/update/archive group |
| GET/POST | `/api/v1/people` | Search/list/create people; filters include `q`, `type`, `status`, `groupId` |
| GET/PATCH | `/api/v1/people/:id` | Read/update/deactivate person |
| POST | `/api/v1/people/import/preview` | Validate CSV rows and return preview/errors without writing |
| POST | `/api/v1/people/import` | Confirm validated import; support idempotency for safe retries |
| GET/POST/PATCH | `/api/v1/courses` and `/api/v1/courses/:id` | List/create/update/archive courses |
| GET/POST/PATCH | `/api/v1/timetable` and `/api/v1/timetable/:id` | List/create/update/archive class schedule slots; reject overlapping group/room sessions |
| GET/POST/PATCH | `/api/v1/shifts` and `/api/v1/shifts/:id` | List/create/update/archive employee shifts |
| GET/POST/PATCH | `/api/v1/holidays` and `/api/v1/holidays/:id` | List/create/update/archive site holidays |

Resource writes return the persisted resource. List endpoints use the pagination convention above and accept date/group filters where relevant. Import preview returns row numbers, normalized values, and validation errors; commit returns created/skipped counts and row-level results. The people import preview and commit endpoints accept raw `text/csv` request bodies (up to 2 MB); both may receive an `assignGroupId` query parameter to explicitly assign every row to one active organization group, ignoring CSV `groupId` values. Commit receives its idempotency key in the `Idempotency-Key` header. JSON `{ "csv": "...", "idempotencyKey": "..." }` requests remain supported.

The platform super admin creates isolated school/company organizations and receives a one-time code for the initial organization admin. The super admin can invite additional admins or rotate an unclaimed admin invitation code; rotating it invalidates the previous code. Organization admins invite teachers, managers, and employees; teachers can invite students only into their assigned active groups. Codes expire in 24 hours and are stored only as SHA-256 hashes. Invitees use the shared registration page to create a password, or verify their existing password to join another organization. Student/employee redemption creates or links an attendance person record; these accounts can read only their own attendance. Direct account creation is not exposed by the users endpoint. Deactivating a user's organization membership revokes that user's sessions for the organization; reactivation requires a fresh sign-in. Organization deactivation also blocks sign-in and revokes tenant sessions while retaining organization records for possible reactivation. Platform sessions are tenant-independent and remain usable to manage any organization, including the one associated with the super-admin membership.

Phase 2 directory details: people have an organization-scoped unique `personCode`; group, parent, and optional supervisor references must belong to the same organization. Person creation/import validates an active group. Consent evidence stores the actor, choice, source, and timestamp on the person record; enrollment must check current consent. CSV imports require `personCode` and `name`; `groupId` is required unless the explicit `assignGroupId` override is supplied. Optional columns include `type`, `email`, `phone`, `rollNumber`, `semester`, `employeeId`, `designation`, and `consentGiven`. Preview does not write; commit rejects invalid rows, skips duplicate codes, and replays a matching `idempotencyKey` safely. CSV imports are limited to 5,000 rows and 2 MB. Profile photo upload is not enabled until storage and retention are decided.

The existing `consentGiven` field gates AMB82-Mini enrollment only. Webcam enrollment records a separate `cameraConsentGiven` decision and history after explicit confirmation in the camera workflow; withdrawing webcam consent or deactivating the person removes the server-side camera template.

## Devices and hardware (backend protocol v1)

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/v1/devices` | List/register devices; registration returns the generated secret once |
| GET/PATCH | `/api/v1/devices/:id` | Read/update device metadata or active state |
| POST | `/api/v1/devices/:id/rotate-secret` | Rotate device credential; reveal new secret once |
| POST | `/api/v1/devices/:id/commands` | Queue an admin reboot or directory-sync request |
| GET | `/api/v1/devices/:id/commands` | Authenticated device polls pending commands (repeated until acknowledged) |
| GET | `/api/v1/device/config` | Authenticated device config and server-time retrieval |
| POST | `/api/v1/device/heartbeat` | Authenticated device heartbeat and health telemetry |
| POST | `/api/v1/device/scans` | Authenticated, idempotent scan batch ingestion |
| POST | `/api/v1/device/commands/:commandId/ack` | Device acknowledges command completion/failure |
| GET/POST | `/api/v1/enrollments` | List/start consent-gated local face enrollment on a device |
| GET | `/api/v1/enrollments/:id` | Read enrollment status |
| DELETE | `/api/v1/enrollments/:id` | Cancel or request acknowledged removal from the device |
| GET | `/api/v1/camera/templates?groupId=:id` | List active people and template-enrollment status for an authorized group |
| POST | `/api/v1/camera/templates` | Create/replace an encrypted template for a person with current biometric consent |
| DELETE | `/api/v1/camera/templates/:personId` | Delete a camera face template |
| GET | `/api/v1/camera/amb82/frame` | Return the latest JPEG from the backend-configured AMB82 RTSP stream |
| POST | `/api/v1/camera/recognize` | Match one browser-computed face descriptor and record attendance on a confident match |

Organization admins manage devices using their user bearer token and organization context. Each registration returns a random device secret once; the backend stores it encrypted at rest. Rotate it immediately if it is lost. Set `DEVICE_SECRET_ENCRYPTION_KEY` to a stable, private key in production; if omitted, the key is derived from `ACCESS_TOKEN_SECRET`, so rotating that secret also requires rotating every device secret.

Device routes require `X-Device-Id`, `X-Device-Timestamp` (13-digit Unix milliseconds), `X-Device-Nonce` (16–128 URL-safe characters), and `X-Device-Signature` (64 hex characters). The signature is HMAC-SHA256 using the device secret over these bytes:

```text
<timestamp>\n<nonce>\n<uppercase HTTP method>\n<path including /api/v1>\n<exact UTF-8 request body bytes>
```

GET requests sign an empty body. Requests outside a five-minute clock window or with a reused nonce are rejected. The nonce cache expires after ten minutes. Use HTTPS. If a batch response is lost, retry the same event IDs with a **new request nonce**; the server treats identical events idempotently and rejects an event ID reused with different data.

Device scan ingestion accepts batches of 1–25 items no more than 24 hours old. Each item contains an `eventId` of 1–96 ASCII letters, digits, dots, underscores, colons, or hyphens; `personCode`; `confidence` (0–1); ISO-8601 `scannedAt`; and `direction` (`IN` or `OUT`). The device must already identify the enrolled person and report the person's organization-scoped `personCode`; face detection alone is not identity. This device endpoint never trusts a device-supplied name and never accepts or stores a face image or template. An `IN` event creates/updates that person's daily attendance record; an `OUT` event requires a prior `IN`. Organization confidence and debounce settings are applied server-side. Unrecognized, inactive, and low-confidence events, plus `OUT` events without a prior `IN`, are retained for review and are not marked present. Malformed batches are rejected.

Enrollment commands send person ID/code/name to the assigned device so its firmware can capture and store a local face model. The backend requires recorded biometric consent and stores enrollment status, not the biometric. Commands are returned until acknowledged and expire after 24 hours; firmware must deduplicate by `commandId`. A face-template delete is complete only after the device acknowledges the `DELETE_PERSON` command.

The AMB82 RTSP camera flow is admin-only. Configure `AMB82_RTSP_URL` and, if needed, `FFMPEG_PATH` in the backend environment; install FFmpeg on the backend host. The RTSP URL (including any credentials) must never be placed in frontend configuration. The backend uses FFmpeg to relay JPEG frames through the authenticated, tenant-protected frame endpoint. The browser runs the locally bundled face-api.js detector/recognizer and sends only a 128-value face descriptor over the authenticated API; frames are not persisted. This flow uses the AMB82 as an RTSP video source; it does not use or verify on-device face identification. Enrollment requires separate, explicit camera face-storage consent (`cameraConsentGiven`); existing AMB82 device-enrollment consent does not grant it. The backend also requires an active person, an active organization group, and tenant authorization. Descriptors are encrypted with AES-256-GCM before storage in Supabase; configure `SUPABASE_URL`, a backend-only `SUPABASE_SECRET_KEY`, and a stable private `FACE_TEMPLATE_ENCRYPTION_KEY` of at least 32 characters (all required at startup in production). Apply the Supabase SQL migration before enabling enrollment. The biometric table has row-level security enabled and no browser policies; all access is through the authenticated backend. Ciphertext authentication is bound to the template's organization, person, and model version. Do not rotate or lose the encryption key without a template migration plan. Existing MongoDB templates must be migrated and verified with `npm run migrate:camera-templates` before switching deployments. Camera-consent withdrawal or person deactivation deletes that person's stored template. The API matches only within the selected group, rejects ambiguous/low-similarity matches, prevents duplicate daily camera attendance, and audits consent, enrollment, deletion, and attendance outcomes without recording descriptors.

This pilot does not provide liveness detection or spoofing resistance and is not a high-assurance identity check. Provide manual attendance as a fallback and assess applicable biometric privacy/consent requirements before deployment.

This defines a backend/firmware contract; it does not mean the AMB82 firmware has been built or flashed. Firmware compatibility, face-identification support, TLS support, clock synchronization, and on-device storage limits must be validated on the actual board before production use.

## Attendance, exceptions, enrollment, leave, and live data

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/dashboard` | Scoped dashboard aggregates; optional `date` in organization timezone |
| GET | `/api/v1/my-attendance` | Student/employee attendance for the authenticated person's linked record only |
| GET | `/api/v1/attendance` | Attendance list; filters include date range, status, person, group, session |
| GET | `/api/v1/people/:id/attendance` | Person attendance history/heatmap |
| POST | `/api/v1/attendance` | Create manual attendance with required reason and audit record |
| POST | `/api/v1/attendance/:id/corrections` | Correct status with required reason; retain history |
| GET | `/api/v1/attendance/sessions` | Planned: session timetable and attendance summary; schedule-to-device mapping is not enabled |
| GET | `/api/v1/exceptions` | Unresolved scan exception queue |
| POST | `/api/v1/exceptions/:eventId/resolve` | Resolve with required note; record actor/time |
| GET/POST | `/api/v1/leave` | List/create leave requests |
| PATCH | `/api/v1/leave/:id` | Approve/reject pending request |
| GET | `/api/v1/events/live` | Server-Sent Events stream for registered-device scans and camera attendance check-ins, scoped to assigned groups; reconnect with `Last-Event-ID` |
| GET/PATCH | `/api/v1/notifications` | List notifications and update read state |

Attendance creation/corrections and exception/leave decisions require authorization and audit records. Scan events remain immutable. Enrollment completion is based on device acknowledgement, not a browser timer. Invitation codes are one-time and expire after 24 hours; a same-target reissue replaces the prior code, while admins can list and revoke active invitations. A changed role or group assignment requires revoking the current invitation first.

Implemented workflow APIs include tenant-scoped dashboard and attendance reads, audited manual attendance and correction history, scan exception resolution, leave request/review, per-user notification read state, audit reads, device scan ingestion, device-derived attendance, and consent-gated device enrollment state.

Device health uses heartbeat age: `ONLINE` under 10 minutes, `STALE` from 10 through 30 minutes, and `OFFLINE` after 30 minutes or when the device is inactive.

## Reports, audit, and privacy

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/reports/attendance` | Attendance report preview/filter |
| GET | `/api/v1/reports/person-history` | Person history report |
| GET | `/api/v1/reports/exceptions` | Exception report |
| GET | `/api/v1/reports/device-health` | Device health report |
| GET | `/api/v1/reports/attendance/export` | Download filtered server-generated CSV or XLSX |
| GET/POST | `/api/v1/reports/schedules` | List/create attendance report schedule; requires active organization-member recipients and SMTP |
| GET/PATCH/DELETE | `/api/v1/reports/schedules/:id` | Inspect delivery attempts, pause/resume, or archive a report schedule |
| GET | `/api/v1/audit` | Authorized, paginated audit history |
| GET/POST | `/api/v1/privacy/deletion-requests` | List/request privacy deletion operation |
| GET | `/api/v1/privacy/deletion-requests/:id` | Inspect deletion progress and device acknowledgements |
| PATCH | `/api/v1/privacy/deletion-requests/:id` | Approve or reject request; does not purge data |

CSV and XLSX attendance export, scheduled email delivery, and request approval are implemented. Export results apply group scope and CSV formula-injection protection. No deletion/retention worker is enabled: approved retention durations and device-side deletion acknowledgements must be confirmed before purging data.

## Decisions before treating this contract as final

- [x] Multi-organization tenancy in one deployment; tenant-owned resources require an organization reference and tenant-scoped queries.
- [x] MongoDB Atlas is the target database provider; production operations, backup/restore, and exact cluster configuration remain to be established.
- [x] SMTP email delivery selected for scheduled reports. Optional photo/file storage remains undecided.
- [x] Backend device protocol: signed requests, heartbeat/config, scan ingestion, command delivery/acknowledgement, enrollment lifecycle, idempotency, clock window, and retry rules are specified and implemented; actual-board firmware compatibility remains unverified.
- [x] Bearer access/refresh token API authentication. Token storage/rotation/expiry details remain to be finalized during auth implementation.
- [x] CSV and XLSX attendance exports; Server-Sent Events selected for live event delivery. PDF is not a current requirement.
- [ ] Approved custom retention periods and consent, privacy, and deletion policy for the operating region; deletion jobs remain disabled.
