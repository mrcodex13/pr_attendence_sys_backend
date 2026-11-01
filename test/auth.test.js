const assert = require('node:assert/strict')
const { after, before, beforeEach, test } = require('node:test')
const mongoose = require('mongoose')
const { MongoMemoryServer } = require('mongodb-memory-server')
const { createApp } = require('../src/app')
const AttendanceRecord = require('../src/models/AttendanceRecord')
const AuditEvent = require('../src/models/AuditEvent')
const Course = require('../src/models/Course')
const Device = require('../src/models/Device')
const DeviceCommand = require('../src/models/DeviceCommand')
const DeviceNonce = require('../src/models/DeviceNonce')
const Enrollment = require('../src/models/Enrollment')
const Group = require('../src/models/Group')
const LeaveRequest = require('../src/models/LeaveRequest')
const Notification = require('../src/models/Notification')
const Holiday = require('../src/models/Holiday')
const Invitation = require('../src/models/Invitation')
const Organization = require('../src/models/Organization')
const Person = require('../src/models/Person')
const PrivacyDeletionRequest = require('../src/models/PrivacyDeletionRequest')
const ReportDelivery = require('../src/models/ReportDelivery')
const ReportSchedule = require('../src/models/ReportSchedule')
const RefreshSession = require('../src/models/RefreshSession')
const ScanEvent = require('../src/models/ScanEvent')
const Site = require('../src/models/Site')
const Shift = require('../src/models/Shift')
const TimetableSlot = require('../src/models/TimetableSlot')
const User = require('../src/models/User')
const { hashPassword } = require('../src/lib/passwords')
const { signDeviceRequest } = require('../src/services/deviceSecurity')
const { dateInTimezone } = require('../src/services/deviceAttendance')
const { deliverOne } = require('../src/services/reportScheduler')

const password = 'Test-Password-123!'
const config = {
  nodeEnv: 'test',
  devPasswordResetEnabled: false,
  accessTokenSecret: 'test-secret-that-is-at-least-thirty-two-characters',
  accessTokenTtl: '15m',
  refreshTokenDays: 30,
  corsOrigins: ['http://localhost:5173'],
  jsonBodyLimit: '1mb',
  appUrl: 'http://localhost:5173',
  mailEnabled: false,
  smtpHost: null,
  faceTemplateEncryptionKey: 'test-face-template-encryption-key-32-chars',
}
const logger = { info() {}, warn() {}, error() {} }
const faceTemplateRows = new Map()
const faceTemplateStore = {
  async listPersonIds(organizationId, personIds) {
    const requestedIds = new Set(personIds.map((id) => id.toString()))
    return [...faceTemplateRows.values()]
      .filter((row) => row.organizationId === organizationId.toString() && requestedIds.has(row.personId))
      .map((row) => row.personId)
  },
  async upsert(template) {
    const row = {
      ...template,
      organizationId: template.organizationId.toString(),
      personId: template.personId.toString(),
      enrolledByUserId: template.enrolledByUserId.toString(),
    }
    faceTemplateRows.set(`${row.organizationId}:${row.personId}`, row)
    return { personId: row.personId, enrolledAt: row.enrolledAt.toISOString() }
  },
  async deleteForPerson(organizationId, personId) {
    faceTemplateRows.delete(`${organizationId.toString()}:${personId.toString()}`)
  },
  async listForPeople(organizationId, personIds) {
    const requestedIds = new Set(personIds.map((id) => id.toString()))
    return [...faceTemplateRows.values()]
      .filter((row) => row.organizationId === organizationId.toString() && requestedIds.has(row.personId))
  },
}
let mongod
let server
let baseUrl
let resetToken

async function request(path, { method = 'GET', token, organizationId, body, extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  if (organizationId) headers['X-Organization-Id'] = organizationId
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { response, body: await response.json() }
}

async function requestCsv(path, { token, organizationId, csv, idempotencyKey } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/csv',
      ...(token ? { Authorization: ['Bearer', token].join(' ') } : {}),
      ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: csv,
  })
  return { response, body: await response.json() }
}

async function deviceRequest(path, { deviceId, secret, method = 'POST', body = method === 'GET' ? undefined : {}, nonce = require('node:crypto').randomBytes(16).toString('hex'), timestamp = Date.now(), signatureOverride } = {}) {
  const rawBody = body === undefined ? '' : JSON.stringify(body)
  const timestampHeader = String(timestamp)
  const signature = signDeviceRequest(secret, {
    timestamp: timestampHeader,
    nonce,
    method,
    path,
    rawBody: Buffer.from(rawBody),
  })
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-Device-Id': deviceId,
      'X-Device-Timestamp': timestampHeader,
      'X-Device-Nonce': nonce,
      'X-Device-Signature': signatureOverride || signature,
    },
    ...(body === undefined ? {} : { body: rawBody }),
  })
  return { response, body: await response.json(), nonce, timestamp }
}

async function createAccount({ email = 'admin@example.edu', role = 'ADMIN', groupIds = [] } = {}) {
  const organization = await Organization.create({ name: 'Test Campus', slug: `campus-${Date.now()}-${Math.random()}` })
  const user = await User.create({
    name: 'Test Admin',
    email,
    passwordHash: await hashPassword(password),
    memberships: [{ organizationId: organization._id, role, groupIds, status: 'ACTIVE' }],
  })
  return { organization, user }
}

async function login(email, organizationId) {
  const result = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { email, password, organizationId },
  })
  assert.equal(result.response.status, 200)
  return result.body.data
}

async function readLiveEvents(token, organizationId, lastEventId) {
  const controller = new AbortController()
  const response = await fetch(`${baseUrl}/api/v1/events/live`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Organization-Id': organizationId,
      ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
    },
    signal: controller.signal,
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes(': connected')) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  controller.abort()
  reader.releaseLock()
  return { response, text }
}

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri())
  const app = createApp({
    config,
    getDatabaseReady: () => mongoose.connection.readyState === 1,
    logger,
    mailer: { async sendPasswordReset(_email, token) { resetToken = token } },
    authRateLimits: { login: 100, reset: 100 },
    faceTemplateStore,
  })
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

beforeEach(async () => {
  resetToken = null
  faceTemplateRows.clear()
  await Promise.all([
    Organization.deleteMany({}),
    Group.deleteMany({}),
    Device.deleteMany({}),
    DeviceCommand.deleteMany({}),
    DeviceNonce.deleteMany({}),
    Enrollment.deleteMany({}),
    Invitation.deleteMany({}),
    User.deleteMany({}),
    RefreshSession.deleteMany({}),
    Site.deleteMany({}),
    Course.deleteMany({}),
    TimetableSlot.deleteMany({}),
    Shift.deleteMany({}),
    Holiday.deleteMany({}),
    AttendanceRecord.deleteMany({}),
    AuditEvent.deleteMany({}),
    LeaveRequest.deleteMany({}),
    Notification.deleteMany({}),
    PrivacyDeletionRequest.deleteMany({}),
    ReportDelivery.deleteMany({}),
    ReportSchedule.deleteMany({}),
    ScanEvent.deleteMany({}),
  ])
})

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await mongoose.disconnect()
  if (mongod) await mongod.stop()
})

test('organization-admin login rejects bad credentials and returns the requested organization membership', async () => {
  const { organization } = await createAccount()
  const invalid = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'admin@example.edu', password: 'incorrect' },
  })
  assert.equal(invalid.response.status, 401)
  assert.equal(invalid.body.error.code, 'INVALID_CREDENTIALS')

  const session = await login('admin@example.edu', organization._id.toString())
  assert.equal(session.user.role, 'ADMIN')
  assert.equal(session.user.organizationId, organization._id.toString())
  assert.equal(session.user.email, 'admin@example.edu')
  assert.equal(session.organizations.length, 1)
})

test('platform super admins sign in without choosing or being tied to an organization', async () => {
  const { organization } = await createAccount({ role: 'SUPER_ADMIN' })
  const session = await login('admin@example.edu')

  assert.equal(session.user.role, 'SUPER_ADMIN')
  assert.equal(session.user.organizationId, undefined)
  assert.equal(session.organizations, undefined)
  assert.equal(await RefreshSession.countDocuments({ organizationId: null }), 1)

  const me = await request('/api/v1/auth/me', { token: session.accessToken })
  assert.equal(me.response.status, 200)
  assert.equal(me.body.data.role, 'SUPER_ADMIN')
  assert.equal(me.body.data.organizationId, undefined)

  const organizations = await request('/api/v1/organizations', { token: session.accessToken })
  assert.equal(organizations.response.status, 200)
  assert.ok(organizations.body.data.some((item) => item.id === organization._id.toString()))

  const tenantInvitations = await request('/api/v1/invitations', { token: session.accessToken })
  assert.equal(tenantInvitations.response.status, 403)
  const tenantUsers = await request('/api/v1/users', { token: session.accessToken })
  assert.equal(tenantUsers.response.status, 403)

  const refreshed = await request('/api/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: session.refreshToken },
  })
  assert.equal(refreshed.response.status, 200)
  assert.equal(refreshed.body.data.user.organizationId, undefined)
})

test('multi-organization login requires an explicit tenant selection after password verification', async () => {
  const { organization, user } = await createAccount()
  const secondOrganization = await Organization.create({ name: 'Second Campus', slug: 'second-campus' })
  user.memberships.push({
    organizationId: secondOrganization._id,
    role: 'MANAGER',
    groupIds: ['ops'],
    status: 'ACTIVE',
  })
  await user.save()

  const selection = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'admin@example.edu', password },
  })
  assert.equal(selection.response.status, 200)
  assert.equal(selection.body.data.organizationSelectionRequired, true)
  assert.equal(selection.body.data.organizations.length, 2)
  assert.equal(selection.body.data.accessToken, undefined)
  assert.equal(await RefreshSession.countDocuments({}), 0)

  const session = await login('admin@example.edu', secondOrganization._id.toString())
  assert.equal(session.user.organizationId, secondOrganization._id.toString())
  assert.equal(session.user.role, 'MANAGER')
  assert.deepEqual(session.user.groupIds, ['ops'])
  assert.notEqual(organization._id.toString(), session.user.organizationId)
})

test('disabled users and inactive tenant memberships cannot sign in', async () => {
  const first = await createAccount({ email: 'disabled@example.edu' })
  await User.updateOne({ _id: first.user._id }, { $set: { status: 'DISABLED' } })
  const disabledAccount = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'disabled@example.edu', password },
  })
  assert.equal(disabledAccount.response.status, 401)

  const second = await createAccount({ email: 'inactive-membership@example.edu' })
  await User.updateOne(
    { _id: second.user._id },
    { $set: { 'memberships.$[membership].status': 'INACTIVE' } },
    { arrayFilters: [{ 'membership.organizationId': second.organization._id }] },
  )
  const inactiveMembership = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'inactive-membership@example.edu', password },
  })
  assert.equal(inactiveMembership.response.status, 401)
})

test('bearer authentication enforces organization context and returns current user', async () => {
  const { organization } = await createAccount({ role: 'TEACHER', groupIds: ['group-a'] })
  const other = await Organization.create({ name: 'Other Campus', slug: 'other-campus' })
  const session = await login('admin@example.edu', organization._id.toString())

  const unauthenticated = await request('/api/v1/auth/me')
  assert.equal(unauthenticated.response.status, 401)

  const own = await request('/api/v1/auth/me', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(own.response.status, 200)
  assert.deepEqual(own.body.data.groupIds, ['group-a'])

  const crossTenant = await request('/api/v1/auth/me', {
    token: session.accessToken,
    organizationId: other._id.toString(),
  })
  assert.equal(crossTenant.response.status, 403)
  assert.equal(crossTenant.body.error.code, 'ORGANIZATION_ACCESS_DENIED')
})

test('refresh tokens rotate once and logout revokes the active session', async () => {
  const { organization } = await createAccount()
  const session = await login('admin@example.edu', organization._id.toString())
  const rotated = await request('/api/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: session.refreshToken },
  })
  assert.equal(rotated.response.status, 200)
  assert.notEqual(rotated.body.data.refreshToken, session.refreshToken)

  const replay = await request('/api/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: session.refreshToken },
  })
  assert.equal(replay.response.status, 401)

  const logout = await request('/api/v1/auth/logout', {
    method: 'POST',
    body: { refreshToken: rotated.body.data.refreshToken },
  })
  assert.equal(logout.response.status, 200)
  const revoked = await request('/api/v1/auth/me', { token: rotated.body.data.accessToken })
  assert.equal(revoked.response.status, 401)
})

test('user management enforces permissions and tenant scoping', async () => {
  const { organization } = await createAccount()
  const group = await Group.create({ organizationId: organization._id, name: 'Class A', kind: 'CLASS' })
  const otherOrganization = await Organization.create({ name: 'Other Org', slug: 'other-org' })
  await User.create({
    name: 'Other Tenant User',
    email: 'other@example.edu',
    passwordHash: await hashPassword(password),
    memberships: [{ organizationId: otherOrganization._id, role: 'ADMIN', groupIds: [], status: 'ACTIVE' }],
  })
  const session = await login('admin@example.edu', organization._id.toString())

  const created = await request('/api/v1/invitations', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: {
      name: 'A Teacher',
      email: 'teacher@example.edu',
      role: 'TEACHER',
      groupIds: [group._id.toString()],
    },
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.data.role, 'TEACHER')
  assert.equal(created.body.data.code.length, 32)
  assert.ok(Math.abs(new Date(created.body.data.expiresAt).getTime() - Date.now() - 24 * 60 * 60 * 1000) < 5000)
  const invitation = await Invitation.findById(created.body.data.id).select('+codeHash')
  assert.ok(invitation.codeHash)
  assert.notEqual(invitation.codeHash, created.body.data.code)

  const incorrectPassword = await request('/api/v1/auth/accept-invitation', {
    method: 'POST',
    body: { code: created.body.data.code, password: 'wrong-password' },
  })
  assert.equal(incorrectPassword.response.status, 400)

  const accepted = await request('/api/v1/auth/accept-invitation', {
    method: 'POST',
    body: { code: created.body.data.code, password },
  })
  assert.equal(accepted.response.status, 201)
  assert.deepEqual(accepted.body.data.user.groupIds, [group._id.toString()])

  const list = await request('/api/v1/users?limit=100', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(list.response.status, 200)
  assert.equal(list.body.meta.total, 2)
  assert.ok(list.body.data.every((user) => user.email !== 'other@example.edu'))

  const invalidRoleFilter = await request('/api/v1/users?role=INVALID', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(invalidRoleFilter.response.status, 400)
  assert.equal(invalidRoleFilter.body.error.code, 'VALIDATION_ERROR')
  const invalidStatusFilter = await request('/api/v1/users?status=INVALID', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(invalidStatusFilter.response.status, 400)

  const escalation = await request(`/api/v1/users/${accepted.body.data.user.id}`, {
    method: 'PATCH',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { role: 'SUPER_ADMIN' },
  })
  assert.equal(escalation.response.status, 400)

  const forbiddenList = await request('/api/v1/users', {
    token: accepted.body.data.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(forbiddenList.response.status, 403)

  const reuse = await request('/api/v1/auth/accept-invitation', {
    method: 'POST',
    body: { code: created.body.data.code, password },
  })
  assert.equal(reuse.response.status, 400)

  const expiring = await request('/api/v1/invitations', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: {
      name: 'Expiring Teacher',
      email: 'expiring-teacher@example.edu',
      role: 'TEACHER',
      groupIds: [group._id.toString()],
    },
  })
  await Invitation.updateOne({ _id: expiring.body.data.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } })
  const expired = await request('/api/v1/auth/accept-invitation', {
    method: 'POST',
    body: { code: expiring.body.data.code, password },
  })
  assert.equal(expired.response.status, 400)
})

test('deactivating a membership revokes only its tenant sessions and reactivation requires sign-in', async () => {
  const { organization } = await createAccount()
  const { organization: otherOrganization } = await createAccount({ email: 'other-admin@example.edu' })
  const member = await User.create({
    name: 'Managed Member',
    email: 'managed-member@example.edu',
    passwordHash: await hashPassword(password),
    memberships: [
      { organizationId: organization._id, role: 'MANAGER', groupIds: [], status: 'ACTIVE' },
      { organizationId: otherOrganization._id, role: 'MANAGER', groupIds: [], status: 'ACTIVE' },
    ],
  })
  const adminSession = await login('admin@example.edu', organization._id.toString())
  const memberSession = await login(member.email, organization._id.toString())
  const otherMemberSession = await login(member.email, otherOrganization._id.toString())

  const deactivated = await request(`/api/v1/users/${member._id}`, {
    method: 'PATCH',
    token: adminSession.accessToken,
    organizationId: organization._id.toString(),
    body: { status: 'INACTIVE' },
  })
  assert.equal(deactivated.response.status, 200)
  assert.equal(deactivated.body.data.status, 'INACTIVE')
  assert.ok(await RefreshSession.exists({
    userId: member._id,
    organizationId: organization._id,
    revokedAt: { $ne: null },
  }))
  assert.ok(await RefreshSession.exists({
    userId: member._id,
    organizationId: otherOrganization._id,
    revokedAt: null,
  }))

  const reactivated = await request(`/api/v1/users/${member._id}`, {
    method: 'PATCH',
    token: adminSession.accessToken,
    organizationId: organization._id.toString(),
    body: { status: 'ACTIVE' },
  })
  assert.equal(reactivated.response.status, 200)

  const oldAccessToken = await request('/api/v1/auth/me', {
    token: memberSession.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(oldAccessToken.response.status, 401)
  const oldRefreshToken = await request('/api/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: memberSession.refreshToken },
  })
  assert.equal(oldRefreshToken.response.status, 401)
  const otherTenantAccessToken = await request('/api/v1/auth/me', {
    token: otherMemberSession.accessToken,
    organizationId: otherOrganization._id.toString(),
  })
  assert.equal(otherTenantAccessToken.response.status, 200)
})

test('malformed resource identifiers return a validation error instead of an internal error', async () => {
  const { organization } = await createAccount()
  const session = await login('admin@example.edu', organization._id.toString())
  const result = await request('/api/v1/attendance/not-an-object-id/corrections', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { status: 'PRESENT', reason: 'Corrected after review' },
  })

  assert.equal(result.response.status, 400)
  assert.equal(result.body.error.code, 'VALIDATION_ERROR')
  assert.equal(result.body.error.message, 'A supplied identifier is invalid.')
})

test('existing account can accept an invite and use the same login for both organizations', async () => {
  const { organization: existingOrganization } = await createAccount({ email: 'shared-user@example.edu' })
  const { organization: targetOrganization } = await createAccount({ email: 'target-admin@example.edu' })
  const group = await Group.create({ organizationId: targetOrganization._id, name: 'Shared Group', kind: 'CLASS' })
  const targetAdmin = await login('target-admin@example.edu', targetOrganization._id.toString())
  const invitation = await request('/api/v1/invitations', {
    method: 'POST',
    token: targetAdmin.accessToken,
    organizationId: targetOrganization._id.toString(),
    body: {
      name: 'Shared User',
      email: 'shared-user@example.edu',
      role: 'TEACHER',
      groupIds: [group._id.toString()],
    },
  })
  assert.equal(invitation.response.status, 201)
  const incorrectPassword = await request('/api/v1/auth/accept-invitation', {
    method: 'POST',
    body: { code: invitation.body.data.code, password: 'Another-Wrong-Password-123!' },
  })
  assert.equal(incorrectPassword.response.status, 401)
  const accepted = await request('/api/v1/auth/accept-invitation', {
    method: 'POST',
    body: { code: invitation.body.data.code, password },
  })
  assert.equal(accepted.response.status, 201)
  const account = await User.findOne({ email: 'shared-user@example.edu' })
  assert.equal(account.memberships.length, 2)

  const selection = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'shared-user@example.edu', password },
  })
  assert.equal(selection.response.status, 200)
  assert.equal(selection.body.data.organizationSelectionRequired, true)
  assert.equal(selection.body.data.organizations.length, 2)
  assert.equal(existingOrganization.status, 'ACTIVE')
})

test('teachers invite students into assigned groups and students can only read their own attendance', async () => {
  const { organization } = await createAccount()
  const assignedGroup = await Group.create({ organizationId: organization._id, name: 'Assigned Class', kind: 'CLASS' })
  const otherGroup = await Group.create({ organizationId: organization._id, name: 'Other Class', kind: 'CLASS' })
  const adminSession = await login('admin@example.edu', organization._id.toString())
  const teacherInvitation = await request('/api/v1/invitations', {
    method: 'POST',
    token: adminSession.accessToken,
    organizationId: organization._id.toString(),
    body: {
      name: 'Class Teacher',
      email: 'class-teacher@example.edu',
      role: 'TEACHER',
      groupIds: [assignedGroup._id.toString()],
    },
  })
  assert.equal(teacherInvitation.response.status, 201)
  const teacherRegistration = await request('/api/v1/auth/accept-invitation', {
    method: 'POST',
    body: { code: teacherInvitation.body.data.code, password },
  })
  assert.equal(teacherRegistration.response.status, 201)

  const outOfScope = await request('/api/v1/invitations', {
    method: 'POST',
    token: teacherRegistration.body.data.accessToken,
    organizationId: organization._id.toString(),
    body: {
      name: 'Out of Scope Student',
      email: 'other-student@example.edu',
      role: 'STUDENT',
      groupIds: [otherGroup._id.toString()],
    },
  })
  assert.equal(outOfScope.response.status, 403)

  const studentInvitation = await request('/api/v1/invitations', {
    method: 'POST',
    token: teacherRegistration.body.data.accessToken,
    organizationId: organization._id.toString(),
    body: {
      name: 'Student One',
      email: 'student-one@example.edu',
      role: 'STUDENT',
      groupIds: [assignedGroup._id.toString()],
    },
  })
  assert.equal(studentInvitation.response.status, 201)
  const studentRegistration = await request('/api/v1/auth/accept-invitation', {
    method: 'POST',
    body: { code: studentInvitation.body.data.code, password },
  })
  assert.equal(studentRegistration.response.status, 201)
  assert.equal(studentRegistration.body.data.user.role, 'STUDENT')

  const ownPerson = await Person.findOne({ organizationId: organization._id, email: 'student-one@example.edu' })
  assert.ok(ownPerson)
  const otherPerson = await Person.create({
    organizationId: organization._id,
    personCode: 'STU-OTHER',
    type: 'STUDENT',
    name: 'Other Student',
    email: 'other-student@example.edu',
    groupId: otherGroup._id,
  })
  await AttendanceRecord.create([
    {
      organizationId: organization._id,
      personId: ownPerson._id,
      date: '2026-10-30',
      status: 'PRESENT',
      source: 'DEVICE',
    },
    {
      organizationId: organization._id,
      personId: otherPerson._id,
      date: '2026-10-30',
      status: 'ABSENT',
      source: 'DEVICE',
    },
  ])
  const attendance = await request('/api/v1/my-attendance', {
    token: studentRegistration.body.data.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(attendance.response.status, 200)
  assert.equal(attendance.body.meta.total, 1)
  assert.equal(attendance.body.data[0].personId, ownPerson._id.toString())

  const organizationAttendance = await request('/api/v1/attendance', {
    token: studentRegistration.body.data.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(organizationAttendance.response.status, 403)
})

test('devices are provisioned securely and signed scans create idempotent attendance', async () => {
  const { organization } = await createAccount()
  const group = await Group.create({ organizationId: organization._id, name: 'Device Class', kind: 'CLASS' })
  const person = await Person.create({
    organizationId: organization._id,
    personCode: 'STU-DEVICE-01',
    type: 'STUDENT',
    name: 'Device Student',
    email: 'device-student@example.edu',
    groupId: group._id,
  })
  const session = await login('admin@example.edu', organization._id.toString())
  const created = await request('/api/v1/devices', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: {
      deviceCode: 'amb82-classroom-01',
      name: 'Classroom Camera',
      groupIds: [group._id.toString()],
    },
  })
  assert.equal(created.response.status, 201)
  const { device, secret } = created.body.data
  assert.equal(device.deviceCode, 'AMB82-CLASSROOM-01')
  assert.equal(secret.length, 43)
  assert.equal(JSON.stringify(device).includes(secret), false)
  const storedDevice = await Device.findById(device.id).select('+secretCiphertext +secretIv +secretTag')
  assert.ok(storedDevice.secretCiphertext)
  assert.notEqual(storedDevice.secretCiphertext, secret)
  await User.create({
    name: 'Device Teacher',
    email: 'device-teacher@example.edu',
    passwordHash: await hashPassword(password),
    memberships: [{ organizationId: organization._id, role: 'TEACHER', groupIds: [group._id.toString()], status: 'ACTIVE' }],
  })
  const teacherSession = await login('device-teacher@example.edu', organization._id.toString())
  const teacherDeviceList = await request('/api/v1/devices', {
    token: teacherSession.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(teacherDeviceList.response.status, 403)

  const deviceList = await request('/api/v1/devices', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(deviceList.response.status, 200)
  assert.equal(deviceList.body.data.length, 1)
  assert.equal(JSON.stringify(deviceList.body).includes(secret), false)

  const heartbeatPath = '/api/v1/device/heartbeat'
  const invalidSignature = await deviceRequest(heartbeatPath, {
    deviceId: device.id,
    secret,
    body: { firmwareVersion: '0.1.0' },
    signatureOverride: '0'.repeat(64),
  })
  assert.equal(invalidSignature.response.status, 401)

  const heartbeat = await deviceRequest(heartbeatPath, {
    deviceId: device.id,
    secret,
    body: { firmwareVersion: '0.1.0', uptimeSeconds: 100, freeHeapBytes: 120000 },
  })
  assert.equal(heartbeat.response.status, 200)
  const config = await deviceRequest('/api/v1/device/config', {
    deviceId: device.id,
    secret,
    method: 'GET',
  })
  assert.equal(config.response.status, 200)
  assert.deepEqual(config.body.data.groupIds, [group._id.toString()])
  assert.equal(config.body.data.settings.minConfidence, organization.settings.minConfidence)
  const healthReport = await request('/api/v1/reports/device-health', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(healthReport.response.status, 200)
  assert.equal(healthReport.body.data[0].health, 'ONLINE')
  const replayedHeartbeat = await deviceRequest(heartbeatPath, {
    deviceId: device.id,
    secret,
    body: { firmwareVersion: '0.1.0', uptimeSeconds: 100, freeHeapBytes: 120000 },
    nonce: heartbeat.nonce,
    timestamp: heartbeat.timestamp,
  })
  assert.equal(replayedHeartbeat.response.status, 409)

  const rotated = await request(`/api/v1/devices/${device.id}/rotate-secret`, {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(rotated.response.status, 200)
  assert.notEqual(rotated.body.data.secret, secret)
  const oldSecretRequest = await deviceRequest('/api/v1/device/heartbeat', {
    deviceId: device.id,
    secret,
    body: { firmwareVersion: '0.1.0' },
  })
  assert.equal(oldSecretRequest.response.status, 401)
  const activeSecret = rotated.body.data.secret

  const scansPath = '/api/v1/device/scans'
  const scannedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const firstScan = {
    eventId: 'boot-01-frame-0001',
    personCode: person.personCode,
    confidence: 0.96,
    scannedAt,
    direction: 'IN',
  }
  const accepted = await deviceRequest(scansPath, {
    deviceId: device.id,
    secret: activeSecret,
    body: { scans: [firstScan] },
  })
  assert.equal(accepted.response.status, 202)
  assert.equal(accepted.body.data.results[0].result, 'ACCEPTED')
  assert.equal(accepted.body.data.results[0].personId, person._id.toString())

  const eventRetry = await deviceRequest(scansPath, {
    deviceId: device.id,
    secret: activeSecret,
    body: { scans: [firstScan] },
  })
  assert.equal(eventRetry.response.status, 202)
  assert.equal(eventRetry.body.data.results[0].duplicate, true)
  assert.equal(await ScanEvent.countDocuments({ organizationId: organization._id }), 1)

  const duplicateScan = await deviceRequest(scansPath, {
    deviceId: device.id,
    secret: activeSecret,
    body: {
      scans: [{
        ...firstScan,
        eventId: 'boot-01-frame-0002',
        scannedAt: new Date(new Date(scannedAt).getTime() + 10_000).toISOString(),
      }],
    },
  })
  assert.equal(duplicateScan.response.status, 202)
  assert.equal(duplicateScan.body.data.results[0].result, 'DUPLICATE')
  const attendanceDate = dateInTimezone(new Date(scannedAt), organization.settings.timezone)
  const attendance = await AttendanceRecord.findOne({
    organizationId: organization._id,
    personId: person._id,
    date: attendanceDate,
  })
  assert.ok(attendance)
  assert.equal(attendance.source, 'DEVICE')
  assert.equal(attendance.status, 'PRESENT')
  assert.deepEqual(attendance.derivedFromEventIds, [`${device.id}:boot-01-frame-0001`])
  assert.equal(await AttendanceRecord.countDocuments({ organizationId: organization._id }), 1)

  const audit = await AuditEvent.findOne({ organizationId: organization._id, action: 'device.attendance_recorded' })
  assert.ok(audit)
})

test('device scan ingestion rejects stale requests, unknown people, and unassigned groups', async () => {
  const { organization } = await createAccount()
  const assignedGroup = await Group.create({ organizationId: organization._id, name: 'Assigned Device Group', kind: 'CLASS' })
  const otherGroup = await Group.create({ organizationId: organization._id, name: 'Other Device Group', kind: 'CLASS' })
  const otherPerson = await Person.create({
    organizationId: organization._id,
    personCode: 'STU-OUT-OF-SCOPE',
    type: 'STUDENT',
    name: 'Out of Scope',
    email: 'out-of-scope@example.edu',
    groupId: otherGroup._id,
  })
  const session = await login('admin@example.edu', organization._id.toString())
  const created = await request('/api/v1/devices', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: {
      deviceCode: 'amb82-room-02',
      name: 'Scoped Camera',
      groupIds: [assignedGroup._id.toString()],
    },
  })
  const { device, secret } = created.body.data
  const stale = await deviceRequest('/api/v1/device/heartbeat', {
    deviceId: device.id,
    secret,
    timestamp: Date.now() - 6 * 60 * 1000,
  })
  assert.equal(stale.response.status, 401)

  const accepted = await deviceRequest('/api/v1/device/scans', {
    deviceId: device.id,
    secret,
    body: {
      scans: [{
        eventId: 'scope-check-01',
        personCode: otherPerson.personCode,
        confidence: 0.99,
        scannedAt: new Date().toISOString(),
        direction: 'IN',
      }],
    },
  })
  assert.equal(accepted.response.status, 202)
  assert.equal(accepted.body.data.results[0].result, 'UNKNOWN_PERSON')
  assert.equal(accepted.body.data.results[0].personId, undefined)
  assert.equal(await AttendanceRecord.countDocuments({ organizationId: organization._id }), 0)
})

test('device scan accepts the maximum event ID supported by its protocol', async () => {
  const { organization } = await createAccount()
  const group = await Group.create({ organizationId: organization._id, name: 'Maximum Event ID Group', kind: 'CLASS' })
  const person = await Person.create({
    organizationId: organization._id,
    personCode: 'STU-MAX-EVENT',
    type: 'STUDENT',
    name: 'Maximum Event Person',
    groupId: group._id,
  })
  const session = await login('admin@example.edu', organization._id.toString())
  const created = await request('/api/v1/devices', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: {
      deviceCode: 'amb82-max-event',
      name: 'Maximum Event Camera',
      groupIds: [group._id.toString()],
    },
  })
  const { device, secret } = created.body.data
  const eventId = 'a'.repeat(96)
  const result = await deviceRequest('/api/v1/device/scans', {
    deviceId: device.id,
    secret,
    body: {
      scans: [{
        eventId,
        personCode: person.personCode,
        confidence: 0.99,
        scannedAt: new Date().toISOString(),
        direction: 'IN',
      }],
    },
  })

  assert.equal(result.response.status, 202)
  const storedEventId = `${device.id}:${eventId}`
  assert.equal((await ScanEvent.findOne({ organizationId: organization._id, eventId: storedEventId })).eventId, storedEventId)
  const record = await AttendanceRecord.findOne({ organizationId: organization._id, personId: person._id })
  assert.deepEqual(record.derivedFromEventIds, [storedEventId])
})

test('biometric enrollment is consent-gated and completes only after device command acknowledgements', async () => {
  const { organization } = await createAccount()
  const group = await Group.create({ organizationId: organization._id, name: 'Enrollment Group', kind: 'CLASS' })
  const person = await Person.create({
    organizationId: organization._id,
    personCode: 'EMP-ENROLL-01',
    type: 'EMPLOYEE',
    name: 'Enrollment Employee',
    email: 'enrollment-employee@example.edu',
    groupId: group._id,
  })
  const session = await login('admin@example.edu', organization._id.toString())
  const created = await request('/api/v1/devices', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: {
      deviceCode: 'amb82-enrollment-01',
      name: 'Enrollment Camera',
      groupIds: [group._id.toString()],
    },
  })
  const { device, secret } = created.body.data

  const withoutConsent = await request('/api/v1/enrollments', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { deviceId: device.id, personId: person._id.toString() },
  })
  assert.equal(withoutConsent.response.status, 409)
  assert.equal(withoutConsent.body.error.code, 'BIOMETRIC_CONSENT_REQUIRED')

  person.consentGiven = true
  person.consentGivenAt = new Date()
  await person.save()
  const started = await request('/api/v1/enrollments', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { deviceId: device.id, personId: person._id.toString() },
  })
  assert.equal(started.response.status, 202)
  assert.equal(started.body.data.status, 'PENDING')
  const enrollment = started.body.data
  const pendingCommand = await deviceRequest(`/api/v1/devices/${device.id}/commands`, {
    deviceId: device.id,
    secret,
    method: 'GET',
    body: undefined,
  })
  assert.equal(pendingCommand.response.status, 200)
  assert.equal(pendingCommand.body.data.length, 1)
  assert.equal(pendingCommand.body.data[0].commandId, enrollment.commandId)
  assert.equal(pendingCommand.body.data[0].type, 'ENROLL_PERSON')
  assert.equal(pendingCommand.body.data[0].payload.personCode, person.personCode)
  assert.equal(JSON.stringify(pendingCommand.body).includes('biometric'), false)

  const ackPath = `/api/v1/device/commands/${enrollment.commandId}/ack`
  const enrollmentAck = await deviceRequest(ackPath, {
    deviceId: device.id,
    secret,
    body: { status: 'ACKNOWLEDGED', message: 'Face model stored locally.' },
  })
  assert.equal(enrollmentAck.response.status, 200)
  const repeatedEnrollmentAck = await deviceRequest(ackPath, {
    deviceId: device.id,
    secret,
    body: { status: 'ACKNOWLEDGED', message: 'Face model stored locally.' },
  })
  assert.equal(repeatedEnrollmentAck.response.status, 200)
  const enrollmentStatus = await request(`/api/v1/enrollments/${enrollment.id}`, {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(enrollmentStatus.body.data.status, 'ENROLLED')

  const removed = await request(`/api/v1/enrollments/${enrollment.id}`, {
    method: 'DELETE',
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(removed.response.status, 202)
  assert.equal(removed.body.data.status, 'DELETE_PENDING')
  const deleteCommandId = removed.body.data.commandId
  const deleteCommand = await deviceRequest(`/api/v1/devices/${device.id}/commands`, {
    deviceId: device.id,
    secret,
    method: 'GET',
    body: undefined,
  })
  assert.equal(deleteCommand.response.status, 200)
  assert.equal(deleteCommand.body.data.length, 1)
  assert.equal(deleteCommand.body.data[0].commandId, deleteCommandId)
  assert.equal(deleteCommand.body.data[0].type, 'DELETE_PERSON')

  const deletionAck = await deviceRequest(`/api/v1/device/commands/${deleteCommandId}/ack`, {
    deviceId: device.id,
    secret,
    body: { status: 'ACKNOWLEDGED', message: 'Local face model removed.' },
  })
  assert.equal(deletionAck.response.status, 200)
  const finalEnrollment = await request(`/api/v1/enrollments/${enrollment.id}`, {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(finalEnrollment.body.data.status, 'REMOVED')
})

test('super admin can create and deactivate isolated organizations with an initial admin', async () => {
  const { organization } = await createAccount({ role: 'SUPER_ADMIN' })
  const session = await login('admin@example.edu')
  const organizations = await request('/api/v1/organizations', {
    token: session.accessToken,
  })
  assert.equal(organizations.response.status, 200)
  assert.ok(organizations.body.data.some((item) => item.id === organization._id.toString()))

  const created = await request('/api/v1/organizations', {
    method: 'POST',
    token: session.accessToken,
    body: {
      name: 'New School',
      slug: 'new-school',
      mode: 'SCHOOL',
      adminName: 'School Admin',
      adminEmail: 'school-admin@example.edu',
    },
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.data.organization.status, 'ACTIVE')
  assert.equal(created.body.data.organization.mode, 'SCHOOL')
  assert.equal(created.body.data.adminInvite.email, 'school-admin@example.edu')
  assert.equal(created.body.data.adminInvite.code.length, 32)

  const schoolId = created.body.data.organization.id
  const additionalAdminInvite = await request(`/api/v1/organizations/${schoolId}/admin-invitations`, {
    method: 'POST',
    token: session.accessToken,
    body: { name: 'Additional Admin', email: 'additional-admin@example.edu' },
  })
  assert.equal(additionalAdminInvite.response.status, 201)
  assert.equal(additionalAdminInvite.body.data.email, 'additional-admin@example.edu')
  const reissuedAdminInvite = await request(`/api/v1/organizations/${schoolId}/admin-invitations`, {
    method: 'POST',
    token: session.accessToken,
    body: { name: 'Additional Admin', email: 'additional-admin@example.edu' },
  })
  assert.equal(reissuedAdminInvite.response.status, 201)
  assert.notEqual(reissuedAdminInvite.body.data.code, additionalAdminInvite.body.data.code)
  assert.equal(await Invitation.countDocuments({
    organizationId: schoolId,
    email: 'additional-admin@example.edu',
    role: 'ADMIN',
  }), 1)
  const invalidatedCode = await request('/api/v1/auth/accept-invitation', {
    method: 'POST',
    body: { code: additionalAdminInvite.body.data.code, password },
  })
  assert.equal(invalidatedCode.response.status, 400)
  const reissuedAdminRegistration = await request('/api/v1/auth/accept-invitation', {
    method: 'POST',
    body: { code: reissuedAdminInvite.body.data.code, password },
  })
  assert.equal(reissuedAdminRegistration.response.status, 201)
  assert.equal(reissuedAdminRegistration.body.data.user.role, 'ADMIN')

  const schoolAdminRegistration = await request('/api/v1/auth/accept-invitation', {
    method: 'POST',
    body: { code: created.body.data.adminInvite.code, password },
  })
  assert.equal(schoolAdminRegistration.response.status, 201)
  const schoolAdmin = schoolAdminRegistration.body.data
  assert.equal(schoolAdmin.user.role, 'ADMIN')
  const createdTeacher = await request('/api/v1/invitations', {
    method: 'POST',
    token: schoolAdmin.accessToken,
    organizationId: schoolId,
    body: {
      name: 'School Teacher',
      email: 'school-teacher@example.edu',
      role: 'TEACHER',
      groupIds: [],
    },
  })
  assert.equal(createdTeacher.response.status, 400)

  const adminEscalation = await request('/api/v1/invitations', {
    method: 'POST',
    token: schoolAdmin.accessToken,
    organizationId: schoolId,
    body: {
      name: 'Another Admin',
      email: 'another-admin@example.edu',
      role: 'ADMIN',
      groupIds: [],
    },
  })
  assert.equal(adminEscalation.response.status, 403)

  const deactivatePlatformOrganization = await request(`/api/v1/organizations/${organization._id}`, {
    method: 'PATCH',
    token: session.accessToken,
    body: { status: 'INACTIVE' },
  })
  assert.equal(deactivatePlatformOrganization.response.status, 200)
  assert.equal(deactivatePlatformOrganization.body.data.status, 'INACTIVE')

  const deactivated = await request(`/api/v1/organizations/${schoolId}`, {
    method: 'PATCH',
    token: session.accessToken,
    body: { status: 'INACTIVE' },
  })
  assert.equal(deactivated.response.status, 200)
  assert.equal(deactivated.body.data.status, 'INACTIVE')

  const revokedSession = await request('/api/v1/auth/me', {
    token: schoolAdmin.accessToken,
    organizationId: schoolId,
  })
  assert.equal(revokedSession.response.status, 401)

  const inactiveLogin = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'school-admin@example.edu', password, organizationId: schoolId },
  })
  assert.equal(inactiveLogin.response.status, 401)

  const reactivated = await request(`/api/v1/organizations/${schoolId}`, {
    method: 'PATCH',
    token: session.accessToken,
    body: { status: 'ACTIVE' },
  })
  assert.equal(reactivated.response.status, 200)
  const restoredLogin = await login('school-admin@example.edu', schoolId)
  assert.equal(restoredLogin.user.role, 'ADMIN')
})

test('organization management is unavailable to organization admins', async () => {
  const { organization } = await createAccount({ role: 'SUPER_ADMIN' })
  const owner = await login('admin@example.edu', organization._id.toString())
  const created = await request('/api/v1/organizations', {
    method: 'POST',
    token: owner.accessToken,
    body: {
      name: 'Tenant Org',
      slug: 'tenant-org',
      mode: 'COMPANY',
      adminName: 'Tenant Admin',
      adminEmail: 'tenant-admin@example.edu',
    },
  })
  assert.equal(created.response.status, 201)
  const tenantId = created.body.data.organization.id
  const tenantRegistration = await request('/api/v1/auth/accept-invitation', {
    method: 'POST',
    body: { code: created.body.data.adminInvite.code, password },
  })
  assert.equal(tenantRegistration.response.status, 201)
  const tenantAdmin = tenantRegistration.body.data

  const list = await request('/api/v1/organizations', {
    token: tenantAdmin.accessToken,
    organizationId: tenantId,
  })
  assert.equal(list.response.status, 403)
})

test('organization settings and group CRUD validate tenant-owned references', async () => {
  const { organization } = await createAccount()
  const { organization: otherOrganization } = await createAccount({ email: 'other-admin@example.edu' })
  const session = await login('admin@example.edu', organization._id.toString())

  const settings = await request('/api/v1/settings', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(settings.response.status, 200)
  assert.equal(settings.body.data.name, 'Test Campus')
  assert.equal(settings.body.data.timezone, 'Asia/Kolkata')

  const invalidSettings = await request('/api/v1/settings', {
    method: 'PATCH',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { timezone: 'Not/A-Timezone' },
  })
  assert.equal(invalidSettings.response.status, 400)

  const updated = await request('/api/v1/settings', {
    method: 'PATCH',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { name: 'Updated Campus', mode: 'SCHOOL', minConfidence: 0.8 },
  })
  assert.equal(updated.response.status, 200)
  assert.equal(updated.body.data.name, 'Updated Campus')
  assert.equal(updated.body.data.minConfidence, 0.8)

  const crossTenantParent = await Group.create({
    organizationId: otherOrganization._id,
    name: 'Foreign Group',
    kind: 'CLASS',
  })
  const invalidGroup = await request('/api/v1/groups', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { name: 'Child', kind: 'CLASS', parentId: crossTenantParent._id.toString() },
  })
  assert.equal(invalidGroup.response.status, 400)

  const createdGroup = await request('/api/v1/groups', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { name: 'Computer Science', kind: 'CLASS' },
  })
  assert.equal(createdGroup.response.status, 201)
  const list = await request('/api/v1/groups', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(list.body.meta.total, 1)

  const archived = await request(`/api/v1/groups/${createdGroup.body.data.id}`, {
    method: 'PATCH',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { status: 'ARCHIVED' },
  })
  assert.equal(archived.response.status, 200)
  assert.equal(archived.body.data.status, 'ARCHIVED')
})

test('site records are isolated to an organization and validate timezone', async () => {
  const { organization } = await createAccount()
  const { organization: otherOrganization } = await createAccount({ email: 'other-admin@example.edu' })
  const session = await login('admin@example.edu', organization._id.toString())
  const created = await request('/api/v1/sites', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { siteCode: 'main', name: 'Main Campus', timezone: 'Asia/Kolkata' },
  })

  assert.equal(created.response.status, 201)
  assert.equal(created.body.data.siteCode, 'MAIN')

  const invalid = await request('/api/v1/sites', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { siteCode: 'bad', name: 'Bad Site', timezone: 'Nope/Timezone' },
  })
  assert.equal(invalid.response.status, 400)

  const ownList = await request('/api/v1/sites', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(ownList.body.data.length, 1)

  const otherSession = await login('other-admin@example.edu', otherOrganization._id.toString())
  const otherTenantList = await request('/api/v1/sites', {
    token: otherSession.accessToken,
    organizationId: otherOrganization._id.toString(),
  })
  assert.equal(otherTenantList.body.data.length, 0)

  const crossTenant = await request(`/api/v1/sites/${created.body.data.id}`, {
    method: 'PATCH',
    token: otherSession.accessToken,
    organizationId: otherOrganization._id.toString(),
    body: { name: 'Should not update' },
  })
  assert.equal(crossTenant.response.status, 404)
})

test('schedule APIs validate organization references, time overlaps, and date ranges', async () => {
  const { organization } = await createAccount()
  const teacher = await User.create({
    name: 'Test Teacher',
    email: 'teacher@example.edu',
    passwordHash: await hashPassword(password),
    memberships: [{ organizationId: organization._id, role: 'TEACHER', groupIds: [], status: 'ACTIVE' }],
  })
  const foreign = await createAccount({ email: 'foreign@example.edu' })
  const group = await Group.create({ organizationId: organization._id, name: 'Class B', kind: 'CLASS' })
  const foreignGroup = await Group.create({ organizationId: foreign.organization._id, name: 'Foreign class', kind: 'CLASS' })
  const session = await login('admin@example.edu', organization._id.toString())

  const courseResult = await request('/api/v1/courses', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { name: 'Mathematics', code: 'math-101', groupId: group._id.toString(), teacherUserId: teacher._id.toString() },
  })
  assert.equal(courseResult.response.status, 201)
  assert.equal(courseResult.body.data.code, 'MATH-101')

  const invalidCourse = await request('/api/v1/courses', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { name: 'Foreign', code: 'foreign', groupId: foreignGroup._id.toString(), teacherUserId: teacher._id.toString() },
  })
  assert.equal(invalidCourse.response.status, 400)

  const slotInput = {
    courseId: courseResult.body.data.id,
    weekday: 1,
    start: '09:00',
    end: '10:00',
    room: 'A-1',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
  }
  const slot = await request('/api/v1/timetable', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: slotInput,
  })
  assert.equal(slot.response.status, 201)

  const conflictingSlot = await request('/api/v1/timetable', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { ...slotInput, start: '09:30', end: '10:30', effectiveFrom: '2026-06-01', effectiveTo: '2027-01-01' },
  })
  assert.equal(conflictingSlot.response.status, 409)

  const invalidShift = await request('/api/v1/shifts', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { name: 'Invalid', start: '18:00', end: '09:00', workingDays: [1, 2] },
  })
  assert.equal(invalidShift.response.status, 400)

  const shift = await request('/api/v1/shifts', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { name: 'Day shift', start: '09:00', end: '17:00', graceMinutes: 10, workingDays: [1, 2, 3, 4, 5] },
  })
  assert.equal(shift.response.status, 201)

  const site = await Site.create({ organizationId: organization._id, siteCode: 'MAIN', name: 'Main Campus' })
  const holiday = await request('/api/v1/holidays', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { date: '2026-12-25', name: 'Holiday', siteId: site._id.toString() },
  })
  assert.equal(holiday.response.status, 201)
  assert.equal(holiday.body.data.siteId, site._id.toString())
})

test('attendance correction, leave review, dashboard, and audit use tenant-scoped persisted data', async () => {
  const { organization } = await createAccount()
  const group = await Group.create({ organizationId: organization._id, name: 'Class C', kind: 'CLASS' })
  const person = await Person.create({
    organizationId: organization._id,
    personCode: 'P-100',
    type: 'STUDENT',
    name: 'Sample Person',
    groupId: group._id,
    consentGiven: true,
  })
  await Person.create({
    organizationId: organization._id,
    personCode: 'P-101',
    type: 'STUDENT',
    name: 'Not Scanned Person',
    groupId: group._id,
    consentGiven: true,
  })
  const record = await AttendanceRecord.create({
    organizationId: organization._id,
    personId: person._id,
    date: '2026-10-25',
    status: 'PRESENT',
    source: 'DEVICE',
    derivedFromEventIds: ['event-1'],
  })
  const session = await login('admin@example.edu', organization._id.toString())
  const correction = await request(`/api/v1/attendance/${record._id}/corrections`, {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { status: 'LATE', reason: 'Verified late arrival' },
  })
  assert.equal(correction.response.status, 200)
  assert.equal(correction.body.data.status, 'LATE')
  const persisted = await AttendanceRecord.findById(record._id)
  assert.equal(persisted.corrections.length, 1)
  assert.equal(persisted.source, 'MANUAL')

  const leave = await request('/api/v1/leave', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { personId: person._id.toString(), from: '2026-10-26', to: '2026-10-27', type: 'SICK', reason: 'Medical leave' },
  })
  assert.equal(leave.response.status, 201)
  const reviewed = await request(`/api/v1/leave/${leave.body.data.id}`, {
    method: 'PATCH',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { status: 'APPROVED' },
  })
  assert.equal(reviewed.response.status, 200)
  assert.equal(reviewed.body.data.status, 'APPROVED')

  const dashboard = await request('/api/v1/dashboard?date=2026-10-25', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(dashboard.body.data.people, 2)
  assert.equal(dashboard.body.data.present, 0)
  assert.equal(dashboard.body.data.late, 1)
  assert.equal(dashboard.body.data.notScanned, 1)
  const audit = await request('/api/v1/audit?limit=100', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(audit.body.data.length, 3)
})

test('teachers cannot review leave requests outside their assigned groups', async () => {
  const { organization, user: admin } = await createAccount()
  const assignedGroup = await Group.create({ organizationId: organization._id, name: 'Leave Assigned Group', kind: 'CLASS' })
  const otherGroup = await Group.create({ organizationId: organization._id, name: 'Leave Other Group', kind: 'CLASS' })
  const teacher = await User.create({
    name: 'Leave Reviewer',
    email: 'leave-reviewer@example.edu',
    passwordHash: await hashPassword(password),
    memberships: [{
      organizationId: organization._id,
      role: 'TEACHER',
      groupIds: [assignedGroup._id.toString()],
      status: 'ACTIVE',
    }],
  })
  const person = await Person.create({
    organizationId: organization._id,
    personCode: 'LEAVE-OUT-OF-SCOPE',
    type: 'STUDENT',
    name: 'Other Group Student',
    groupId: otherGroup._id,
  })
  const leave = await LeaveRequest.create({
    organizationId: organization._id,
    personId: person._id,
    from: '2026-10-25',
    to: '2026-10-26',
    type: 'SICK',
    reason: 'Medical leave',
    requesterUserId: admin._id,
  })
  const session = await login(teacher.email, organization._id.toString())
  const result = await request(`/api/v1/leave/${leave._id}`, {
    method: 'PATCH',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { status: 'APPROVED' },
  })

  assert.equal(result.response.status, 403)
  assert.equal(result.body.error.code, 'FORBIDDEN')
  const persisted = await LeaveRequest.findById(leave._id)
  assert.equal(persisted.status, 'PENDING')
  assert.equal(persisted.reviewerUserId, null)
})

test('privacy requests are audited without purging data and XLSX exports are real files', async () => {
  const { organization } = await createAccount()
  const group = await Group.create({ organizationId: organization._id, name: 'Class D', kind: 'CLASS' })
  const person = await Person.create({
    organizationId: organization._id,
    personCode: 'P-200',
    type: 'STUDENT',
    name: 'Privacy Person',
    groupId: group._id,
    consentGiven: true,
  })
  const record = await AttendanceRecord.create({
    organizationId: organization._id,
    personId: person._id,
    date: '2026-10-25',
    status: 'PRESENT',
    source: 'DEVICE',
  })
  const session = await login('admin@example.edu', organization._id.toString())
  const deletion = await request('/api/v1/privacy/deletion-requests', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { personId: person._id.toString(), reason: 'Privacy request from the person' },
  })
  assert.equal(deletion.response.status, 201)
  const duplicateRequest = await request('/api/v1/privacy/deletion-requests', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { personId: person._id.toString(), reason: 'Duplicate privacy request' },
  })
  assert.equal(duplicateRequest.response.status, 409)

  const reviewed = await request(`/api/v1/privacy/deletion-requests/${deletion.body.data.id}`, {
    method: 'PATCH',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { status: 'APPROVED', reviewNote: 'Await approved retention and device deletion policy.' },
  })
  assert.equal(reviewed.response.status, 200)
  assert.equal(await Person.countDocuments({ _id: person._id }), 1)
  assert.equal(await AttendanceRecord.countDocuments({ _id: record._id }), 1)

  const exportResponse = await fetch(`${baseUrl}/api/v1/reports/attendance/export?format=xlsx`, {
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'X-Organization-Id': organization._id.toString(),
    },
  })
  assert.equal(exportResponse.status, 200)
  assert.match(exportResponse.headers.get('content-type'), /spreadsheetml\.sheet/)
  const bytes = Buffer.from(await exportResponse.arrayBuffer())
  assert.equal(bytes.subarray(0, 2).toString(), 'PK')

  const scheduleDisabled = await request('/api/v1/reports/schedules', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: {
      name: 'Daily report',
      format: 'CSV',
      frequency: 'DAILY',
      localTime: '18:00',
      timezone: 'Asia/Kolkata',
      recipients: ['admin@example.edu'],
    },
  })
  assert.equal(scheduleDisabled.response.status, 503)
  assert.equal(scheduleDisabled.body.error.code, 'EMAIL_NOT_CONFIGURED')
})

test('live scan SSE replays stored tenant events and closes cleanly', async () => {
  const { organization } = await createAccount()
  const session = await login('admin@example.edu', organization._id.toString())
  await ScanEvent.create({
    organizationId: organization._id,
    eventId: 'sse-event-1',
    deviceId: new mongoose.Types.ObjectId(),
    rawLabel: 'P-300',
    confidence: 0.91,
    scannedAt: new Date('2026-10-25T10:00:00Z'),
    result: 'UNKNOWN_PERSON',
    direction: 'IN',
  })
  const controller = new AbortController()
  const response = await fetch(`${baseUrl}/api/v1/events/live`, {
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'X-Organization-Id': organization._id.toString(),
    },
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const reader = response.body.getReader()
  const { value } = await reader.read()
  const text = new TextDecoder().decode(value)
  assert.match(text, /id: sse-event-1/)
  assert.match(text, /"result":"UNKNOWN_PERSON"/)
  controller.abort()
  reader.releaseLock()
})

test('live scan SSE scopes events and reconnect cursors to assigned groups', async () => {
  const { organization, user: admin } = await createAccount()
  const assignedGroup = await Group.create({ organizationId: organization._id, name: 'SSE Assigned Group', kind: 'CLASS' })
  const otherGroup = await Group.create({ organizationId: organization._id, name: 'SSE Other Group', kind: 'CLASS' })
  const teacher = await User.create({
    name: 'Scoped Teacher',
    email: 'scoped-teacher@example.edu',
    passwordHash: await hashPassword(password),
    memberships: [{
      organizationId: organization._id,
      role: 'TEACHER',
      groupIds: [assignedGroup._id.toString()],
      status: 'ACTIVE',
    }],
  })
  const assignedPerson = await Person.create({
    organizationId: organization._id,
    personCode: 'SSE-ASSIGNED',
    type: 'STUDENT',
    name: 'Assigned Student',
    groupId: assignedGroup._id,
  })
  const otherPerson = await Person.create({
    organizationId: organization._id,
    personCode: 'SSE-OTHER',
    type: 'STUDENT',
    name: 'Other Student',
    groupId: otherGroup._id,
  })
  const createEvent = (eventId, person) => ScanEvent.create({
    organizationId: organization._id,
    eventId,
    deviceId: new mongoose.Types.ObjectId(),
    personId: person._id,
    rawLabel: person.name,
    confidence: 0.98,
    scannedAt: new Date(),
    result: 'ACCEPTED',
    direction: 'IN',
  })
  const firstAssignedEvent = await createEvent('sse-assigned-1', assignedPerson)
  const otherGroupEvent = await createEvent('sse-other-1', otherPerson)
  const secondAssignedEvent = await createEvent('sse-assigned-2', assignedPerson)
  const teacherSession = await login(teacher.email, organization._id.toString())
  const adminSession = await login(admin.email, organization._id.toString())

  const scoped = await readLiveEvents(teacherSession.accessToken, organization._id.toString(), otherGroupEvent.eventId)
  assert.equal(scoped.response.status, 200)
  assert.match(scoped.text, /sse-assigned-1/)
  assert.match(scoped.text, /sse-assigned-2/)
  assert.doesNotMatch(scoped.text, /sse-other-1/)
  assert.doesNotMatch(scoped.text, new RegExp(otherPerson._id.toString()))

  const resumed = await readLiveEvents(teacherSession.accessToken, organization._id.toString(), firstAssignedEvent.eventId)
  assert.match(resumed.text, /sse-assigned-2/)
  assert.doesNotMatch(resumed.text, /sse-assigned-1/)
  assert.doesNotMatch(resumed.text, /sse-other-1/)

  const unscoped = await readLiveEvents(adminSession.accessToken, organization._id.toString())
  assert.match(unscoped.text, /sse-assigned-1/)
  assert.match(unscoped.text, /sse-other-1/)
  assert.match(unscoped.text, /sse-assigned-2/)
})

test('initial live scan query failures emit an SSE error and close the response', async () => {
  const { organization } = await createAccount()
  const session = await login('admin@example.edu', organization._id.toString())
  const originalFind = ScanEvent.find
  ScanEvent.find = () => {
    throw new Error('test database failure')
  }
  try {
    const stream = await readLiveEvents(session.accessToken, organization._id.toString())
    assert.equal(stream.response.status, 200)
    assert.match(stream.text, /event: error/)
    assert.match(stream.text, /LIVE_FEED_UNAVAILABLE/)
    assert.doesNotMatch(stream.text, /: connected/)
  } finally {
    ScanEvent.find = originalFind
  }
})

test('scheduled report worker sends a generated export and persists delivery state', async () => {
  const { organization, user } = await createAccount()
  const schedule = await ReportSchedule.create({
    organizationId: organization._id,
    name: 'Daily attendance',
    format: 'CSV',
    frequency: 'DAILY',
    localTime: '18:00',
    timezone: 'UTC',
    recipients: [user.email],
    status: 'ACTIVE',
    nextRunAt: new Date(Date.now() - 60_000),
    createdBy: user._id,
  })
  let sent
  const didDeliver = await deliverOne({
    mailer: {
      async sendReport(input) {
        sent = input
      },
    },
    logger,
  })
  assert.equal(didDeliver, true)
  assert.equal(sent.name, schedule.name)
  assert.equal(sent.format, 'CSV')
  assert.ok(Buffer.isBuffer(sent.buffer))
  const delivery = await ReportDelivery.findOne({ scheduleId: schedule._id })
  assert.equal(delivery.status, 'SENT')
  assert.ok(delivery.completedAt)
  const updated = await ReportSchedule.findById(schedule._id)
  assert.equal(updated.lockedAt, null)
  assert.ok(updated.nextRunAt > new Date())
})

test('people CRUD enforces organization/group scope and records consent evidence', async () => {
  const { organization } = await createAccount()
  const { organization: otherOrganization } = await createAccount({ email: 'other-admin@example.edu' })
  const group = await Group.create({ organizationId: organization._id, name: 'Class A', kind: 'CLASS' })
  const foreignGroup = await Group.create({ organizationId: otherOrganization._id, name: 'Foreign Class', kind: 'CLASS' })
  const session = await login('admin@example.edu', organization._id.toString())

  const invalid = await request('/api/v1/people', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: {
      personCode: 'STU-1',
      type: 'STUDENT',
      name: 'Student One',
      email: 'student@example.edu',
      phone: '9876543210',
      status: 'ACTIVE',
      groupId: foreignGroup._id.toString(),
      consentGiven: true,
    },
  })
  assert.equal(invalid.response.status, 400)

  const created = await request('/api/v1/people', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: {
      personCode: 'stu-1',
      type: 'STUDENT',
      name: 'Student One',
      email: 'student@example.edu',
      phone: '9876543210',
      status: 'ACTIVE',
      groupId: group._id.toString(),
      consentGiven: true,
      rollNumber: 'R-1',
    },
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.data.personCode, 'STU-1')
  assert.equal(created.body.data.consentGiven, true)
  assert.ok(created.body.data.consentGivenAt)
  const storedPerson = await Person.findById(created.body.data.id)
  assert.equal(storedPerson.consentHistory.length, 1)
  assert.equal(storedPerson.consentHistory[0].given, true)

  const list = await request('/api/v1/people?q=student&type=STUDENT&groupId=' + group._id, {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(list.response.status, 200)
  assert.equal(list.body.meta.total, 1)

  const crossTenantRead = await request(`/api/v1/people/${created.body.data.id}`, {
    token: session.accessToken,
    organizationId: otherOrganization._id.toString(),
  })
  assert.equal(crossTenantRead.response.status, 403)

  const duplicate = await request('/api/v1/people', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: {
      personCode: 'STU-1',
      type: 'STUDENT',
      name: 'Duplicate Student',
      email: '',
      phone: '',
      status: 'ACTIVE',
      groupId: group._id.toString(),
      consentGiven: false,
    },
  })
  assert.equal(duplicate.response.status, 409)
})

test('CSV import validates preview rows and commits idempotently', async () => {
  const { organization } = await createAccount()
  const group = await Group.create({ organizationId: organization._id, name: 'Class A', kind: 'CLASS' })
  const session = await login('admin@example.edu', organization._id.toString())
  const csv = `personCode,name,type,email,phone,groupId,consentGiven\nSTU-10,"Student, Ten",STUDENT,ten@example.edu,1234567890,${group._id},true\nBAD,One,UNKNOWN,,123,missing,false`

  const preview = await request('/api/v1/people/import/preview', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { csv },
  })
  assert.equal(preview.response.status, 200)
  assert.equal(preview.body.data.totalRows, 2)
  assert.equal(preview.body.data.validCount, 1)
  assert.equal(preview.body.data.rows[0].data.name, 'Student, Ten')
  assert.ok(preview.body.data.rows[1].errors.length > 0)

  const invalidCommit = await request('/api/v1/people/import', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { idempotencyKey: 'invalid-import-key-1', csv },
  })
  assert.equal(invalidCommit.response.status, 400)

  const validCsv = csv.split('\n')[0] + `\nSTU-10,"Student, Ten",STUDENT,ten@example.edu,1234567890,${group._id},true`
  const commit = await request('/api/v1/people/import', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { idempotencyKey: 'valid-import-key-1', csv: validCsv },
  })
  assert.equal(commit.response.status, 201)
  assert.equal(commit.body.data.created, 1)
  assert.equal(await Person.countDocuments({ organizationId: organization._id }), 1)

  const replay = await request('/api/v1/people/import', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { idempotencyKey: 'valid-import-key-1', csv: validCsv },
  })
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.meta.replayed, true)
  assert.equal(await Person.countDocuments({ organizationId: organization._id }), 1)

  const conflict = await request('/api/v1/people/import', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { idempotencyKey: 'valid-import-key-1', csv: validCsv + '\n' },
  })
  assert.equal(conflict.response.status, 409)
})

test('CSV import accepts raw uploaded CSV files for preview and idempotent commit', async () => {
  const { organization } = await createAccount()
  const group = await Group.create({ organizationId: organization._id, name: 'Import Group', kind: 'DEPARTMENT' })
  const session = await login('admin@example.edu', organization._id.toString())
  const csv = `personCode,name,type,groupId,email\nEMP-RAW-1,Uploaded Person,EMPLOYEE,${group._id},uploaded@example.edu`

  const preview = await requestCsv('/api/v1/people/import/preview', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
    csv,
  })
  assert.equal(preview.response.status, 200)
  assert.equal(preview.body.data.validCount, 1)

  const commit = await requestCsv('/api/v1/people/import', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
    csv,
    idempotencyKey: 'raw-csv-upload-key-1',
  })
  assert.equal(commit.response.status, 201)
  assert.equal(commit.body.data.created, 1)
  assert.equal(await Person.countDocuments({ organizationId: organization._id, personCode: 'EMP-RAW-1' }), 1)

  const replay = await requestCsv('/api/v1/people/import', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
    csv,
    idempotencyKey: 'raw-csv-upload-key-1',
  })
  assert.equal(replay.response.status, 200)
  assert.equal(replay.body.meta.replayed, true)
})

test('CSV import can assign uploaded rows to a selected active group', async () => {
  const { organization } = await createAccount()
  const group = await Group.create({ organizationId: organization._id, name: 'G_1', kind: 'DEPARTMENT' })
  const session = await login('admin@example.edu', organization._id.toString())
  const csv = 'personCode,name,type,groupId\nEMP-GROUP-1,Group Assigned Person,EMPLOYEE,6ae706320fc174ba3faf2ec0'
  const importUrl = `/api/v1/people/import?assignGroupId=${group._id}`

  const preview = await requestCsv(`/api/v1/people/import/preview?assignGroupId=${group._id}`, {
    token: session.accessToken,
    organizationId: organization._id.toString(),
    csv,
  })
  assert.equal(preview.response.status, 200)
  assert.equal(preview.body.data.validCount, 1)
  assert.equal(preview.body.data.rows[0].data.groupId, group._id.toString())

  const commit = await requestCsv(importUrl, {
    token: session.accessToken,
    organizationId: organization._id.toString(),
    csv,
    idempotencyKey: 'group-assignment-key-1',
  })
  assert.equal(commit.response.status, 201)
  assert.equal(commit.body.data.created, 1)
  const person = await Person.findOne({ organizationId: organization._id, personCode: 'EMP-GROUP-1' })
  assert.equal(person.groupId.toString(), group._id.toString())
})

test('password reset reports disabled email without revealing account existence', async () => {
  await createAccount()
  const known = await request('/api/v1/auth/forgot-password', {
    method: 'POST',
    body: { email: 'admin@example.edu' },
  })
  const unknown = await request('/api/v1/auth/forgot-password', {
    method: 'POST',
    body: { email: 'missing@example.edu' },
  })

  assert.equal(known.response.status, 503)
  assert.equal(known.body.error.code, 'EMAIL_NOT_CONFIGURED')
  assert.match(known.body.error.message, /Email is not set up/)
  assert.deepEqual(unknown.body.error, known.body.error)
  const user = await User.findOne({ email: 'admin@example.edu' }).select('+passwordResetHash')
  assert.equal(user.passwordResetHash, undefined)
  assert.equal(resetToken, null)
})

test('password reset is one-time, changes the password, and revokes sessions', async (t) => {
  config.mailEnabled = true
  t.after(() => {
    config.mailEnabled = false
  })
  const { organization } = await createAccount()
  const session = await login('admin@example.edu', organization._id.toString())

  const forgot = await request('/api/v1/auth/forgot-password', {
    method: 'POST',
    body: { email: 'admin@example.edu' },
  })
  assert.equal(forgot.response.status, 202)
  assert.ok(resetToken)
  const unknown = await request('/api/v1/auth/forgot-password', {
    method: 'POST',
    body: { email: 'missing@example.edu' },
  })
  assert.equal(unknown.response.status, 202)
  assert.deepEqual(unknown.body.data, forgot.body.data)

  const changed = await request('/api/v1/auth/reset-password', {
    method: 'POST',
    body: { token: resetToken, newPassword: 'New-Password-456!' },
  })
  assert.equal(changed.response.status, 200)

  const oldSession = await request('/api/v1/auth/me', { token: session.accessToken })
  assert.equal(oldSession.response.status, 401)

  const reusedToken = await request('/api/v1/auth/reset-password', {
    method: 'POST',
    body: { token: resetToken, newPassword: 'New-Password-789!' },
  })
  assert.equal(reusedToken.response.status, 400)

  const oldPassword = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'admin@example.edu', password, organizationId: organization._id.toString() },
  })
  assert.equal(oldPassword.response.status, 401)
  const newPassword = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'admin@example.edu', password: 'New-Password-456!', organizationId: organization._id.toString() },
  })
  assert.equal(newPassword.response.status, 200)
})

test('development password reset exposes only a loopback one-time reset link', async () => {
  const originalNodeEnv = config.nodeEnv
  const originalEnabled = config.devPasswordResetEnabled
  config.nodeEnv = 'development'
  config.devPasswordResetEnabled = true
  try {
    await createAccount({ email: 'dev-reset@example.edu' })
    const reset = await request('/api/v1/auth/forgot-password', {
      method: 'POST',
      body: { email: 'dev-reset@example.edu' },
    })
    assert.equal(reset.response.status, 202)
    const resetUrl = new URL(reset.body.data.developmentResetUrl)
    assert.equal(resetUrl.origin, config.appUrl)
    const token = resetUrl.searchParams.get('token')
    assert.equal(typeof token, 'string')
    assert.equal(token.length, 43)

    const updated = await request('/api/v1/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword: 'Development-Reset-456!' },
    })
    assert.equal(updated.response.status, 200)

    const reused = await request('/api/v1/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword: 'Development-Reset-789!' },
    })
    assert.equal(reused.response.status, 400)
  } finally {
    config.nodeEnv = originalNodeEnv
    config.devPasswordResetEnabled = originalEnabled
  }
})

test('password change requires the current password and revokes sessions', async () => {
  const { organization } = await createAccount()
  const session = await login('admin@example.edu', organization._id.toString())
  const failed = await request('/api/v1/auth/change-password', {
    method: 'POST',
    token: session.accessToken,
    body: { currentPassword: 'wrong-password', newPassword: 'New-Password-456!' },
  })
  assert.equal(failed.response.status, 401)

  const changed = await request('/api/v1/auth/change-password', {
    method: 'POST',
    token: session.accessToken,
    body: { currentPassword: password, newPassword: 'New-Password-456!' },
  })
  assert.equal(changed.response.status, 200)
  const revoked = await request('/api/v1/auth/me', { token: session.accessToken })
  assert.equal(revoked.response.status, 401)
})

test('invitation reissue replaces one active code and authorized users can revoke it', async () => {
  const { organization } = await createAccount()
  const group = await Group.create({ organizationId: organization._id, name: 'Class A', kind: 'CLASS' })
  const session = await login('admin@example.edu', organization._id.toString())
  const inviteInput = {
    name: 'A Teacher',
    email: 'teacher@example.edu',
    role: 'TEACHER',
    groupIds: [group._id.toString()],
  }
  const first = await request('/api/v1/invitations', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: inviteInput,
  })
  const replacement = await request('/api/v1/invitations', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: inviteInput,
  })
  assert.equal(first.response.status, 201)
  assert.equal(replacement.response.status, 201)
  assert.equal(replacement.body.data.id, first.body.data.id)
  assert.notEqual(replacement.body.data.code, first.body.data.code)
  assert.equal(await Invitation.countDocuments({ organizationId: organization._id, email: inviteInput.email }), 1)

  const pending = await request('/api/v1/invitations', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(pending.response.status, 200)
  assert.equal(pending.body.data.length, 1)
  assert.equal(pending.body.data[0].email, inviteInput.email)
  assert.equal('code' in pending.body.data[0], false)

  const revoked = await request(`/api/v1/invitations/${replacement.body.data.id}`, {
    method: 'DELETE',
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(revoked.response.status, 200)
  const invalidated = await request('/api/v1/auth/accept-invitation', {
    method: 'POST',
    body: { code: replacement.body.data.code, password },
  })
  assert.equal(invalidated.response.status, 400)
  assert.equal(await AuditEvent.countDocuments({ action: 'invitation.revoked' }), 1)
})

test('platform admins can list and revoke an organization admin invitation', async () => {
  const { organization } = await createAccount({ role: 'SUPER_ADMIN' })
  const session = await login('admin@example.edu')
  const created = await request('/api/v1/organizations', {
    method: 'POST',
    token: session.accessToken,
    body: {
      name: 'New School',
      slug: 'new-school',
      mode: 'SCHOOL',
      adminName: 'School Admin',
      adminEmail: 'school-admin@example.edu',
    },
  })
  assert.equal(created.response.status, 201)
  const schoolId = created.body.data.organization.id
  const listed = await request(`/api/v1/organizations/${schoolId}/admin-invitations`, {
    token: session.accessToken,
  })
  assert.equal(listed.response.status, 200)
  assert.equal(listed.body.data.length, 1)
  assert.equal(listed.body.data[0].email, 'school-admin@example.edu')
  assert.equal('code' in listed.body.data[0], false)

  const revoked = await request(`/api/v1/organizations/${schoolId}/admin-invitations/${listed.body.data[0].id}`, {
    method: 'DELETE',
    token: session.accessToken,
  })
  assert.equal(revoked.response.status, 200)
  const invalidated = await request('/api/v1/auth/accept-invitation', {
    method: 'POST',
    body: { code: created.body.data.adminInvite.code, password },
  })
  assert.equal(invalidated.response.status, 400)
})

test('manual attendance creation is tenant scoped, duplicate-safe, and audited', async () => {
  const { organization } = await createAccount()
  const group = await Group.create({ organizationId: organization._id, name: 'Class A', kind: 'CLASS' })
  const person = await Person.create({
    organizationId: organization._id,
    personCode: 'STU-001',
    type: 'STUDENT',
    name: 'Student One',
    groupId: group._id,
  })
  const session = await login('admin@example.edu', organization._id.toString())
  const input = {
    personId: person._id.toString(),
    date: '2026-10-31',
    status: 'PRESENT',
    reason: 'Verified against the signed register.',
  }
  const created = await request('/api/v1/attendance', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: input,
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.data.source, 'MANUAL')
  assert.equal(created.body.data.status, 'PRESENT')
  const duplicate = await request('/api/v1/attendance', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: input,
  })
  assert.equal(duplicate.response.status, 409)
  assert.equal(await AuditEvent.countDocuments({ action: 'attendance.created' }), 1)

  const noReason = await request('/api/v1/attendance', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { ...input, date: '2026-11-01', reason: '' },
  })
  assert.equal(noReason.response.status, 400)

  const teacher = await User.create({
    name: 'Unassigned Teacher',
    email: 'unassigned-teacher@example.edu',
    passwordHash: await hashPassword(password),
    memberships: [{ organizationId: organization._id, role: 'TEACHER', groupIds: [], status: 'ACTIVE' }],
  })
  const teacherSession = await login(teacher.email, organization._id.toString())
  const outOfScope = await request('/api/v1/attendance', {
    method: 'POST',
    token: teacherSession.accessToken,
    organizationId: organization._id.toString(),
    body: { ...input, date: '2026-11-02' },
  })
  assert.equal(outOfScope.response.status, 403)
})

test('device health follows the configured 10 and 30 minute heartbeat boundaries', async () => {
  const { organization } = await createAccount()
  const session = await login('admin@example.edu', organization._id.toString())
  const now = Date.now()
  const ages = [
    ['ONLINE-9', 9, 'ONLINE'],
    ['STALE-10', 10, 'STALE'],
    ['STALE-29', 29, 'STALE'],
    ['OFFLINE-31', 31, 'OFFLINE'],
  ]
  await Promise.all(ages.map(([deviceCode, minutes]) => Device.create({
    organizationId: organization._id,
    deviceCode,
    name: deviceCode,
    groupIds: [],
    secretCiphertext: 'ciphertext',
    secretIv: 'iv',
    secretTag: 'tag',
    lastSeenAt: new Date(now - Number(minutes) * 60 * 1000),
  })))
  const report = await request('/api/v1/reports/device-health', {
    token: session.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(report.response.status, 200)
  const healthByCode = Object.fromEntries(report.body.data.map((device) => [device.deviceCode, device.health]))
  for (const [deviceCode, , expected] of ages) assert.equal(healthByCode[deviceCode], expected)
})

test('teachers can only list and revoke student invitations for assigned groups', async () => {
  const { organization, user: inviter } = await createAccount({ role: 'TEACHER' })
  const assignedGroup = await Group.create({ organizationId: organization._id, name: 'Assigned', kind: 'CLASS' })
  const otherGroup = await Group.create({ organizationId: organization._id, name: 'Other', kind: 'CLASS' })
  inviter.memberships[0].groupIds = [assignedGroup._id.toString(), otherGroup._id.toString()]
  await inviter.save()
  const teacher = await User.create({
    name: 'Teacher',
    email: 'assigned-teacher@example.edu',
    passwordHash: await hashPassword(password),
    memberships: [{
      organizationId: organization._id,
      role: 'TEACHER',
      groupIds: [assignedGroup._id.toString()],
      status: 'ACTIVE',
    }],
  })
  const inviterSession = await login(inviter.email, organization._id.toString())
  const teacherSession = await login(teacher.email, organization._id.toString())
  const createStudentInvite = (email, group) => request('/api/v1/invitations', {
    method: 'POST',
    token: inviterSession.accessToken,
    organizationId: organization._id.toString(),
    body: { name: 'Student', email, role: 'STUDENT', groupIds: [group._id.toString()] },
  })
  const [assignedInvite, otherInvite] = await Promise.all([
    createStudentInvite('assigned-student@example.edu', assignedGroup),
    createStudentInvite('other-student@example.edu', otherGroup),
  ])
  assert.equal(assignedInvite.response.status, 201)
  assert.equal(otherInvite.response.status, 201)

  const visible = await request('/api/v1/invitations', {
    token: teacherSession.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(visible.response.status, 200)
  assert.deepEqual(visible.body.data.map((item) => item.email), ['assigned-student@example.edu'])

  const outOfScope = await request(`/api/v1/invitations/${otherInvite.body.data.id}`, {
    method: 'DELETE',
    token: teacherSession.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(outOfScope.response.status, 403)
  const revoked = await request(`/api/v1/invitations/${assignedInvite.body.data.id}`, {
    method: 'DELETE',
    token: teacherSession.accessToken,
    organizationId: organization._id.toString(),
  })
  assert.equal(revoked.response.status, 200)
})

test('camera enrollment stores only encrypted descriptors and camera recognition records attendance once', async () => {
  const { organization } = await createAccount({ role: 'ADMIN', email: 'camera-admin@example.edu' })
  const group = await Group.create({
    organizationId: organization._id,
    name: 'Camera class',
    kind: 'CLASS',
  })
  const person = await Person.create({
    organizationId: organization._id,
    personCode: 'CAM-101',
    type: 'STUDENT',
    name: 'Camera Student',
    groupId: group._id,
    consentGiven: false,
  })
  const session = await login('camera-admin@example.edu', organization._id.toString())
  const descriptor = Array.from({ length: 128 }, (_, index) => index / 1000)
  const enrolled = await request('/api/v1/camera/templates', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: {
      personId: person._id.toString(),
      descriptors: [descriptor, descriptor],
      cameraConsentConfirmed: true,
    },
  })
  assert.equal(enrolled.response.status, 201)
  const [storedTemplate] = await faceTemplateStore.listForPeople(organization._id, [person._id])
  assert.ok(storedTemplate.ciphertext)
  assert.equal(storedTemplate.ciphertext.includes(JSON.stringify([descriptor, descriptor])), false)
  assert.equal(storedTemplate.modelVersion, 'face-api-128-v1')
  const consentedPerson = await Person.findById(person._id)
  assert.equal(consentedPerson.cameraConsentGiven, true)
  assert.equal(consentedPerson.cameraConsentHistory.length, 1)

  const recognized = await request('/api/v1/camera/recognize', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { groupId: group._id.toString(), descriptor },
  })
  assert.equal(recognized.response.status, 200)
  assert.equal(recognized.body.data.matched, true)
  assert.equal(recognized.body.data.person.id, person._id.toString())
  assert.equal(recognized.body.data.attendance.status, 'PRESENT')
  assert.equal(recognized.body.data.attendance.alreadyRecorded, false)
  assert.equal(await AttendanceRecord.countDocuments({ personId: person._id, source: 'CAMERA' }), 1)
  assert.equal(await ScanEvent.countDocuments({
    organizationId: organization._id,
    source: 'CAMERA',
    personId: person._id,
  }), 1)
  const liveCameraEvents = await readLiveEvents(session.accessToken, organization._id.toString())
  assert.match(liveCameraEvents.text, /"source":"CAMERA"/)
  assert.match(liveCameraEvents.text, /"displayName":"Camera Student"/)

  const repeated = await request('/api/v1/camera/recognize', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { groupId: group._id.toString(), descriptor },
  })
  assert.equal(repeated.body.data.attendance.alreadyRecorded, true)
  assert.equal(await AttendanceRecord.countDocuments({ personId: person._id }), 1)
  assert.equal(await ScanEvent.countDocuments({
    organizationId: organization._id,
    source: 'CAMERA',
    personId: person._id,
  }), 1)

  const revoked = await request(`/api/v1/people/${person._id}`, {
    method: 'PATCH',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { cameraConsentGiven: false },
  })
  assert.equal(revoked.response.status, 200)
  assert.equal(await faceTemplateStore.listForPeople(organization._id, [person._id]).then((rows) => rows.length), 0)
  const withdrawnPerson = await Person.findById(person._id)
  assert.equal(withdrawnPerson.cameraConsentGiven, false)
  assert.equal(withdrawnPerson.cameraConsentHistory.length, 2)
  const noLongerRecognized = await request('/api/v1/camera/recognize', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { groupId: group._id.toString(), descriptor },
  })
  assert.deepEqual(noLongerRecognized.body.data, { matched: false, reason: 'NO_MATCH' })
})

test('camera enrollment rejects missing consent and malformed descriptors', async () => {
  const { organization } = await createAccount({ role: 'ADMIN', email: 'camera-guard@example.edu' })
  const group = await Group.create({
    organizationId: organization._id,
    name: 'Consent class',
    kind: 'CLASS',
  })
  const person = await Person.create({
    organizationId: organization._id,
    personCode: 'CAM-102',
    type: 'STUDENT',
    name: 'No Consent Student',
    groupId: group._id,
    consentGiven: false,
  })
  const session = await login('camera-guard@example.edu', organization._id.toString())
  const descriptor = Array.from({ length: 128 }, () => 0.1)
  const bypassConfirmation = await request(`/api/v1/people/${person._id}`, {
    method: 'PATCH',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { cameraConsentGiven: true },
  })
  assert.equal(bypassConfirmation.response.status, 400)

  const denied = await request('/api/v1/camera/templates', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { personId: person._id.toString(), descriptors: [descriptor] },
  })
  assert.equal(denied.response.status, 403)
  assert.equal(denied.body.error.code, 'CAMERA_CONSENT_REQUIRED')

  const malformed = await request('/api/v1/camera/templates', {
    method: 'POST',
    token: session.accessToken,
    organizationId: organization._id.toString(),
    body: { personId: person._id.toString(), descriptors: [[0.1, 0.2]] },
  })
  assert.equal(malformed.response.status, 400)
  assert.equal(faceTemplateRows.size, 0)
})
