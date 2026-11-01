# Project architecture

The frontend and backend remain separate projects. The current UI and its route
structure are preserved; hardware integration belongs behind the backend API.

```text
attendence system/
├── pr_attendence_sys_frontent/
│   └── src/
│       ├── api/                 # HTTP client and live event stream
│       ├── auth/                # Session and organization selection
│       ├── components/          # Shared UI and application shell
│       ├── lib/                 # Formatting, permissions, and helpers
│       ├── pages/               # Role and workflow screens
│       └── types/               # Frontend domain/API types
└── pr_attendence_sys_backend/
    ├── src/
    │   ├── app.js               # Middleware and router composition
    │   ├── config.js            # Environment and runtime configuration
    │   ├── lib/                 # Shared validation and domain utilities
    │   ├── middleware/          # Authentication and authorization
    │   ├── models/              # Tenant-scoped MongoDB models
    │   ├── routes/              # Versioned HTTP API
    │   └── services/            # Reusable business and integration services
    ├── test/                    # API and domain tests
    ├── API_CONTRACT.md
    └── ARCHITECTURE.md
```

## AMB82-Mini RTSP camera pilot

The camera page uses an AMB82 RTSP stream instead of a workstation webcam.
Because browsers cannot play RTSP directly, the backend uses FFmpeg to relay
JPEG frames through an authenticated endpoint. The browser runs the bundled
face detector and descriptor model; only encrypted descriptors are stored in
Supabase, while frames are not persisted. The RTSP URL and any credentials stay
in the backend environment. Face-template enrollment requires separate,
explicit camera-storage consent and does not provide liveness or spoofing
protection. This pilot uses the board as a video source; it does not imply
on-device face identification.

## AMB82-Mini integration boundary

The intended event path is:

```text
AMB82-Mini camera/AI
    -> HMAC-signed device request
    -> device authentication and tenant scope
    -> validated, tenant-scoped attendance event
    -> attendance record and audit/event history
    -> existing live feed and reports
```

Device transport and firmware-specific parsing must stay separate from
attendance rules. The device adapter will translate a confirmed firmware
message into the backend's canonical event shape; the attendance service will
then validate organization, device, person, timestamp, duplicate/replay
protection, and attendance policy before writing records. The existing
`ScanEvent` history and live-feed API are the intended integration points.

The backend protocol is implemented. Before production rollout, the firmware
must be built and verified against:

- Whether the board only detects faces or also identifies enrolled people.
- Transport and message format, including stable device and person identifiers.
- Device authentication, credential provisioning, signature support, and
  credential rotation.
- Timestamp trust, event IDs/nonces, duplicate handling, and offline retries.
- Enrollment and device-command acknowledgements, if those features are needed.

The current dashboard UI is intentionally unchanged. Device APIs do not imply
that a board is connected: hardware compatibility and attendance behavior must
be verified on the AMB82-Mini before production rollout.

## Tenant and biometric boundaries

Every device is explicitly assigned to an organization and one or more groups
before it can submit events. A device-provided display name is never an identity
credential; events resolve by person code to an active person in an assigned
group. AMB82 enrollment requires recorded consent. Its backend command path
tracks acknowledgements but does not receive or store that device's face image
or template. The separate workstation-camera pilot stores only encrypted face
descriptors and deletes them when consent is withdrawn or the person is
deactivated.

## Incremental implementation rule

Keep the current login, organization hierarchy, attendance workflows, and UI
working while the firmware adapter is developed. Keep API authentication,
tenant checks, event processing, command delivery, and persistence independently
testable. Firmware and real-board verification remain separate deliverables.
