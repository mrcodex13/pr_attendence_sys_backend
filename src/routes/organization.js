const express = require('express')
const mongoose = require('mongoose')
const Organization = require('../models/Organization')
const Group = require('../models/Group')
const Person = require('../models/Person')
const Site = require('../models/Site')
const User = require('../models/User')
const RefreshSession = require('../models/RefreshSession')
const Invitation = require('../models/Invitation')
const AuditEvent = require('../models/AuditEvent')
const { HttpError } = require('../lib/httpError')
const { createInvitationCode, hashInvitationCode, INVITATION_TTL_MS } = require('../lib/invitations')
const { createAuthenticate } = require('../middleware/authenticate')
const { requirePermission } = require('../middleware/authorize')
const { createSupabaseFaceTemplateStore } = require('../services/supabaseFaceTemplates')

const SETTINGS_DEFAULTS = {
  mode: 'BOTH',
  timezone: 'Asia/Kolkata',
  graceMinutes: 10,
  debounceSeconds: 60,
  minConfidence: 0.72,
  retentionDays: 365,
}
const MODES = ['SCHOOL', 'COMPANY', 'BOTH']
const GROUP_KINDS = ['CLASS', 'DEPARTMENT', 'TEAM']
const GROUP_STATUSES = ['ACTIVE', 'ARCHIVED']
const PERSON_TYPES = ['STUDENT', 'EMPLOYEE']
const PERSON_STATUSES = ['ACTIVE', 'INACTIVE']

function serializeOrganization(organization) {
  return {
    id: organization._id.toString(),
    name: organization.name,
    slug: organization.slug,
    mode: organization.settings.mode,
    status: organization.status,
    createdAt: organization.createdAt.toISOString(),
  }
}

function requirePlatformSuperAdmin(req, _res, next) {
  if (req.auth?.membership.role !== 'SUPER_ADMIN') {
    return next(new HttpError(403, 'FORBIDDEN', 'Only the platform super admin can manage organizations.'))
  }
  next()
}

function serializeGroup(group) {
  return {
    id: group._id.toString(),
    name: group.name,
    kind: group.kind,
    ...(group.parentId ? { parentId: group.parentId.toString() } : {}),
    ...(group.supervisorUserId ? { supervisorUserId: group.supervisorUserId.toString() } : {}),
    status: group.status,
  }
}

function serializePerson(person) {
  return {
    id: person._id.toString(),
    personCode: person.personCode,
    type: person.type,
    name: person.name,
    email: person.email,
    phone: person.phone,
    ...(person.photoUrl ? { photoUrl: person.photoUrl } : {}),
    status: person.status,
    groupId: person.groupId.toString(),
    ...(person.rollNumber ? { rollNumber: person.rollNumber } : {}),
    ...(person.semester ? { semester: person.semester } : {}),
    ...(person.employeeId ? { employeeId: person.employeeId } : {}),
    ...(person.designation ? { designation: person.designation } : {}),
    consentGiven: person.consentGiven,
    consentGivenAt: person.consentGivenAt?.toISOString() ?? null,
    cameraConsentGiven: person.cameraConsentGiven,
    cameraConsentGivenAt: person.cameraConsentGivenAt?.toISOString() ?? null,
  }
}

function parsePage(query) {
  const page = Number(query.page || 1)
  const limit = Number(query.limit || 25)
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Page must be positive and limit must be between 1 and 100.')
  }
  return { page, limit }
}

function validEmail(email) {
  return !email || (typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
}

function createOrganizationRouter({ config, faceTemplateStore = createSupabaseFaceTemplateStore({ config }) }) {
  const router = express.Router()
  const authenticate = createAuthenticate({ config })
  const parseCsvBody = express.text({ type: 'text/csv', limit: '2mb' })

  router.get('/organizations', authenticate, requirePlatformSuperAdmin, async (req, res) => {
    const organizations = await Organization.find({}).sort({ createdAt: -1, _id: 1 })
    res.json({
      data: organizations.map(serializeOrganization),
      meta: { requestId: req.requestId },
    })
  })

  router.post('/organizations', authenticate, requirePlatformSuperAdmin, async (req, res) => {
    const { name, slug, mode, adminName, adminEmail } = req.body || {}
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120 ||
      typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim().toLowerCase()) ||
      slug.trim().length > 80 || !MODES.includes(mode) ||
      typeof adminName !== 'string' || adminName.trim().length < 2 || adminName.trim().length > 120 ||
      typeof adminEmail !== 'string' || adminEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Provide a valid organization name, URL slug, type, and initial admin name and email.')
    }

    const normalizedEmail = adminEmail.trim().toLowerCase()

    const organization = await Organization.create({
      name: name.trim(),
      slug: slug.trim().toLowerCase(),
      settings: { mode },
    })
    const code = createInvitationCode()
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS)
    try {
      await Invitation.create({
        organizationId: organization._id,
        email: normalizedEmail,
        name: adminName.trim(),
        role: 'ADMIN',
        groupIds: [],
        createdBy: req.auth.user._id,
        codeHash: hashInvitationCode(code),
        expiresAt,
      })
    } catch (error) {
      await Organization.deleteOne({ _id: organization._id })
      throw error
    }

    res.status(201).json({
      data: {
        organization: serializeOrganization(organization),
        adminInvite: { email: normalizedEmail, code, expiresAt: expiresAt.toISOString() },
      },
      meta: { requestId: req.requestId },
    })
  })

  router.post('/organizations/:id/admin-invitations', authenticate, requirePlatformSuperAdmin, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested organization was not found.')
    }
    const { name, email } = req.body || {}
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120 ||
      typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Provide a valid admin name and email.')
    }
    const organization = await Organization.findOne({ _id: req.params.id, status: 'ACTIVE' })
    if (!organization) throw new HttpError(404, 'NOT_FOUND', 'The active organization was not found.')

    const normalizedEmail = email.trim().toLowerCase()
    const existingUser = await User.findOne({ email: normalizedEmail })
    if (existingUser?.memberships.some((membership) =>
      membership.organizationId.toString() === organization._id.toString())) {
      throw new HttpError(409, 'USER_ALREADY_IN_ORGANIZATION', 'This email already has an account in the organization.')
    }
    const now = new Date()
    const pendingInvite = await Invitation.findOne({
      organizationId: organization._id,
      email: normalizedEmail,
      usedAt: null,
      revokedAt: null,
      expiresAt: { $gt: now },
    })
    if (pendingInvite && pendingInvite.role !== 'ADMIN') {
      throw new HttpError(409, 'INVITATION_ALREADY_EXISTS', 'A valid invitation already exists for this email.')
    }
    if (pendingInvite?.claimId) {
      throw new HttpError(409, 'INVITATION_BEING_CLAIMED', 'This invitation is currently being accepted. Try again shortly.')
    }

    const code = createInvitationCode()
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS)
    if (pendingInvite) {
      pendingInvite.name = name.trim()
      pendingInvite.createdBy = req.auth.user._id
      pendingInvite.codeHash = hashInvitationCode(code)
      pendingInvite.expiresAt = expiresAt
      pendingInvite.revokedAt = null
      await pendingInvite.save()
    } else {
      await Invitation.create({
        organizationId: organization._id,
        email: normalizedEmail,
        name: name.trim(),
        role: 'ADMIN',
        groupIds: [],
        createdBy: req.auth.user._id,
        codeHash: hashInvitationCode(code),
        expiresAt,
      })
    }
    res.status(201).json({
      data: { email: normalizedEmail, code, expiresAt: expiresAt.toISOString() },
      meta: { requestId: req.requestId },
    })
  })

  router.post('/invitations', authenticate, async (req, res) => {
    const membership = req.auth.membership
    const { name, email, role, groupIds = [] } = req.body || {}
    const allowedRoles = membership.role === 'ADMIN'
      ? ['TEACHER', 'MANAGER', 'EMPLOYEE']
      : membership.role === 'TEACHER'
        ? ['STUDENT']
        : []
    if (!allowedRoles.includes(role)) {
      throw new HttpError(403, 'ROLE_ASSIGNMENT_DENIED', 'Your role cannot invite this account type.')
    }
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120 ||
      typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !Array.isArray(groupIds) || groupIds.length > 50 ||
      groupIds.some((groupId) => typeof groupId !== 'string' || !mongoose.isValidObjectId(groupId)) ||
      new Set(groupIds).size !== groupIds.length) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Provide a valid name, email, role, and unique group list.')
    }

    const normalizedEmail = email.trim().toLowerCase()
    const organizationId = req.auth.organization._id
    const existingUser = await User.findOne({ email: normalizedEmail })
    if (existingUser?.memberships.some((item) =>
      item.organizationId.toString() === organizationId.toString())) {
      throw new HttpError(409, 'USER_ALREADY_IN_ORGANIZATION', 'This email already has an account in the organization.')
    }
    const pendingInvite = await Invitation.findOne({
      organizationId,
      email: normalizedEmail,
      usedAt: null,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
    if (pendingInvite?.claimId && pendingInvite.claimedAt > new Date(Date.now() - 5 * 60 * 1000)) {
      throw new HttpError(409, 'INVITATION_BEING_CLAIMED', 'This invitation is currently being accepted. Try again shortly.')
    }

    const allowedGroupIds = membership.role === 'TEACHER' ? membership.groupIds : null
    if (role === 'STUDENT' && groupIds.length !== 1) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A student invitation must target exactly one group.')
    }
    if (['EMPLOYEE', 'TEACHER', 'MANAGER'].includes(role) && groupIds.length === 0) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Select at least one group for this account.')
    }
    if (allowedGroupIds && groupIds.some((groupId) => !allowedGroupIds.includes(groupId))) {
      throw new HttpError(403, 'GROUP_ACCESS_DENIED', 'You can only invite students to your assigned groups.')
    }
    const validGroups = await Group.countDocuments({
      _id: { $in: groupIds },
      organizationId,
      status: 'ACTIVE',
    })
    if (validGroups !== groupIds.length) {
      throw new HttpError(400, 'INVALID_GROUP', 'All invitation groups must be active in this organization.')
    }

    if (pendingInvite && (
      pendingInvite.role !== role ||
      pendingInvite.personGroupId?.toString() !== (['STUDENT', 'EMPLOYEE'].includes(role) ? groupIds[0] : undefined) ||
      pendingInvite.groupIds.slice().sort().join(',') !== groupIds.slice().sort().join(',')
    )) {
      throw new HttpError(409, 'INVITATION_ALREADY_EXISTS', 'Revoke the existing invitation before changing its role or group assignment.')
    }

    const code = createInvitationCode()
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS)
    const invitation = pendingInvite ?? new Invitation({ organizationId, email: normalizedEmail })
    invitation.name = name.trim()
    invitation.role = role
    invitation.groupIds = groupIds
    invitation.personGroupId = ['STUDENT', 'EMPLOYEE'].includes(role) ? groupIds[0] : null
    invitation.createdBy = req.auth.user._id
    invitation.codeHash = hashInvitationCode(code)
    invitation.expiresAt = expiresAt
    invitation.revokedAt = null
    await invitation.save()
    res.status(201).json({
      data: {
        id: invitation._id.toString(),
        email: invitation.email,
        name: invitation.name,
        role: invitation.role,
        code,
        expiresAt: expiresAt.toISOString(),
      },
      meta: { requestId: req.requestId },
    })
  })

  router.get('/invitations', authenticate, async (req, res) => {
    const role = req.auth.membership.role
    if (!['ADMIN', 'TEACHER'].includes(role)) {
      throw new HttpError(403, 'FORBIDDEN', 'Your role cannot view pending invitations.')
    }
    const filter = {
      organizationId: req.auth.organization._id,
      role: { $ne: 'ADMIN' },
      usedAt: null,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }
    if (role === 'TEACHER') {
      filter.role = 'STUDENT'
      filter.personGroupId = { $in: req.auth.membership.groupIds }
    }
    const invitations = await Invitation.find(filter).sort({ createdAt: -1 }).limit(100)
    res.json({
      data: invitations.map((invitation) => ({
        id: invitation._id.toString(),
        email: invitation.email,
        name: invitation.name,
        role: invitation.role,
        groupIds: invitation.groupIds,
        expiresAt: invitation.expiresAt.toISOString(),
        createdAt: invitation.createdAt.toISOString(),
      })),
      meta: { requestId: req.requestId },
    })
  })

  router.delete('/invitations/:id', authenticate, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'The invitation was not found.')
    const membership = req.auth.membership
    if (!['ADMIN', 'TEACHER'].includes(membership.role)) {
      throw new HttpError(403, 'FORBIDDEN', 'You cannot revoke this invitation.')
    }
    const invitation = await Invitation.findOne({
      _id: req.params.id,
      organizationId: req.auth.organization._id,
      usedAt: null,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
      role: { $ne: 'ADMIN' },
    })
    if (!invitation) throw new HttpError(404, 'NOT_FOUND', 'The active invitation was not found.')
    if (membership.role === 'ADMIN') {
      // Organization administrators can manage staff and student invitations, but not admin invitations.
    } else if (membership.role === 'TEACHER' && invitation.role === 'STUDENT' &&
      membership.groupIds.includes(invitation.personGroupId?.toString())) {
      // Teachers can manage student invitations only for their assigned groups.
    } else {
      throw new HttpError(403, 'FORBIDDEN', 'You cannot revoke this invitation.')
    }
    if (invitation.claimId && invitation.claimedAt > new Date(Date.now() - 5 * 60 * 1000)) {
      throw new HttpError(409, 'INVITATION_BEING_CLAIMED', 'This invitation is currently being accepted. Try again shortly.')
    }
    invitation.revokedAt = new Date()
    await invitation.save()
    await AuditEvent.create({
      organizationId: req.auth.organization._id,
      actorUserId: req.auth.user._id,
      action: 'invitation.revoked',
      entityType: 'Invitation',
      entityId: invitation._id.toString(),
      detail: `Revoked ${invitation.role} invitation for ${invitation.email}.`,
      requestId: req.requestId,
    })
    res.json({ data: { id: invitation._id.toString(), revokedAt: invitation.revokedAt.toISOString() }, meta: { requestId: req.requestId } })
  })

  router.get('/organizations/:id/admin-invitations', authenticate, requirePlatformSuperAdmin, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'The organization was not found.')
    const organization = await Organization.findById(req.params.id)
    if (!organization) throw new HttpError(404, 'NOT_FOUND', 'The organization was not found.')
    const invitations = await Invitation.find({
      organizationId: organization._id,
      role: 'ADMIN',
      usedAt: null,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 }).limit(100)
    res.json({
      data: invitations.map((invitation) => ({
        id: invitation._id.toString(),
        email: invitation.email,
        name: invitation.name,
        expiresAt: invitation.expiresAt.toISOString(),
        createdAt: invitation.createdAt.toISOString(),
      })),
      meta: { requestId: req.requestId },
    })
  })

  router.delete('/organizations/:id/admin-invitations/:invitationId', authenticate, requirePlatformSuperAdmin, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.invitationId)) {
      throw new HttpError(404, 'NOT_FOUND', 'The invitation was not found.')
    }
    const invitation = await Invitation.findOne({
      _id: req.params.invitationId,
      organizationId: req.params.id,
      role: 'ADMIN',
      usedAt: null,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
    if (!invitation) throw new HttpError(404, 'NOT_FOUND', 'The active admin invitation was not found.')
    if (invitation.claimId && invitation.claimedAt > new Date(Date.now() - 5 * 60 * 1000)) {
      throw new HttpError(409, 'INVITATION_BEING_CLAIMED', 'This invitation is currently being accepted. Try again shortly.')
    }
    invitation.revokedAt = new Date()
    await invitation.save()
    await AuditEvent.create({
      organizationId: invitation.organizationId,
      actorUserId: req.auth.user._id,
      action: 'invitation.revoked',
      entityType: 'Invitation',
      entityId: invitation._id.toString(),
      detail: `Revoked ADMIN invitation for ${invitation.email}.`,
      requestId: req.requestId,
    })
    res.json({ data: { id: invitation._id.toString(), revokedAt: invitation.revokedAt.toISOString() }, meta: { requestId: req.requestId } })
  })

  router.patch('/organizations/:id', authenticate, requirePlatformSuperAdmin, async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested organization was not found.')
    }
    const { status } = req.body || {}
    if (!['ACTIVE', 'INACTIVE'].includes(status)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Organization status must be ACTIVE or INACTIVE.')
    }
    const organization = await Organization.findById(req.params.id)
    if (!organization) throw new HttpError(404, 'NOT_FOUND', 'The requested organization was not found.')
    organization.status = status
    await organization.save()
    if (status === 'INACTIVE') {
      await RefreshSession.updateMany(
        { organizationId: organization._id, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      )
    }
    res.json({
      data: serializeOrganization(organization),
      meta: { requestId: req.requestId },
    })
  })

  router.get('/sites', authenticate, requirePermission('groups.manage'), async (req, res) => {
    const sites = await Site.find({ organizationId: req.auth.organization._id }).sort({ name: 1, _id: 1 })
    res.json({
      data: sites.map((site) => ({
        id: site._id.toString(),
        siteCode: site.siteCode,
        name: site.name,
        address: site.address,
        timezone: site.timezone,
        status: site.status,
      })),
      meta: { requestId: req.requestId },
    })
  })

  router.post('/sites', authenticate, requirePermission('groups.manage'), async (req, res) => {
    const { siteCode, name, address = '', timezone = '' } = req.body || {}
    if (typeof siteCode !== 'string' || siteCode.trim().length < 2 || siteCode.trim().length > 40 ||
      typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120 ||
      typeof address !== 'string' || address.length > 300 ||
      typeof timezone !== 'string' || timezone.length > 80) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Site code, name, address, or timezone is invalid.')
    }
    if (timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone })
      } catch {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Site timezone must be a valid IANA timezone.')
      }
    }
    const site = await Site.create({
      organizationId: req.auth.organization._id,
      siteCode: siteCode.trim().toUpperCase(),
      name: name.trim(),
      address: address.trim(),
      timezone,
    })
    res.status(201).json({
      data: {
        id: site._id.toString(),
        siteCode: site.siteCode,
        name: site.name,
        address: site.address,
        timezone: site.timezone,
        status: site.status,
      },
      meta: { requestId: req.requestId },
    })
  })

  router.patch('/sites/:id', authenticate, requirePermission('groups.manage'), async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'The requested site was not found.')
    const site = await Site.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!site) throw new HttpError(404, 'NOT_FOUND', 'The requested site was not found.')
    const input = req.body || {}
    const allowed = new Set(['siteCode', 'name', 'address', 'timezone', 'status'])
    if (!Object.keys(input).length || Object.keys(input).some((key) => !allowed.has(key))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Provide supported site fields to update.')
    }
    if (input.siteCode !== undefined) {
      if (typeof input.siteCode !== 'string' || input.siteCode.trim().length < 2 || input.siteCode.trim().length > 40) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Site code must be between 2 and 40 characters.')
      }
      site.siteCode = input.siteCode.trim().toUpperCase()
    }
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.trim().length > 120) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Site name must be between 2 and 120 characters.')
      }
      site.name = input.name.trim()
    }
    if (input.address !== undefined) {
      if (typeof input.address !== 'string' || input.address.length > 300) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Site address cannot exceed 300 characters.')
      }
      site.address = input.address.trim()
    }
    if (input.timezone !== undefined) {
      if (typeof input.timezone !== 'string' || input.timezone.length > 80) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Site timezone must be a valid IANA timezone.')
      }
      if (input.timezone) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: input.timezone })
        } catch {
          throw new HttpError(400, 'VALIDATION_ERROR', 'Site timezone must be a valid IANA timezone.')
        }
      }
      site.timezone = input.timezone
    }
    if (input.status !== undefined) {
      if (!['ACTIVE', 'INACTIVE'].includes(input.status)) throw new HttpError(400, 'VALIDATION_ERROR', 'Site status must be ACTIVE or INACTIVE.')
      site.status = input.status
    }
    await site.save()
    res.json({
      data: {
        id: site._id.toString(),
        siteCode: site.siteCode,
        name: site.name,
        address: site.address,
        timezone: site.timezone,
        status: site.status,
      },
      meta: { requestId: req.requestId },
    })
  })

  router.get('/settings', authenticate, requirePermission('settings.manage'), async (req, res) => {
    const settings = { ...SETTINGS_DEFAULTS, ...(req.auth.organization.settings || {}) }
    res.json({ data: { name: req.auth.organization.name, ...settings }, meta: { requestId: req.requestId } })
  })

  router.patch('/settings', authenticate, requirePermission('settings.manage'), async (req, res) => {
    const input = req.body || {}
    const allowed = new Set(['name', 'mode', 'timezone', 'graceMinutes', 'debounceSeconds', 'minConfidence', 'retentionDays'])
    if (!Object.keys(input).length || Object.keys(input).some((key) => !allowed.has(key))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Provide one or more supported organization settings.')
    }
    const current = { ...SETTINGS_DEFAULTS, ...(req.auth.organization.settings || {}) }
    const next = { ...current }

    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.trim().length > 120) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Organization name must be between 2 and 120 characters.')
      }
      req.auth.organization.name = input.name.trim()
    }
    if (input.mode !== undefined) {
      if (!MODES.includes(input.mode)) throw new HttpError(400, 'VALIDATION_ERROR', 'Organization mode is invalid.')
      next.mode = input.mode
    }
    if (input.timezone !== undefined) {
      if (typeof input.timezone !== 'string' || input.timezone.length > 80) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'A valid IANA timezone is required.')
      }
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: input.timezone })
      } catch {
        throw new HttpError(400, 'VALIDATION_ERROR', 'A valid IANA timezone is required.')
      }
      next.timezone = input.timezone
    }
    for (const [field, min, max] of [
      ['graceMinutes', 0, 240],
      ['debounceSeconds', 0, 3600],
      ['retentionDays', 1, 36500],
    ]) {
      if (input[field] !== undefined) {
        if (!Number.isInteger(input[field]) || input[field] < min || input[field] > max) {
          throw new HttpError(400, 'VALIDATION_ERROR', `${field} must be an integer between ${min} and ${max}.`)
        }
        next[field] = input[field]
      }
    }
    if (input.minConfidence !== undefined) {
      if (typeof input.minConfidence !== 'number' || !Number.isFinite(input.minConfidence) ||
        input.minConfidence < 0 || input.minConfidence > 1) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'minConfidence must be between 0 and 1.')
      }
      next.minConfidence = input.minConfidence
    }

    req.auth.organization.settings = next
    await req.auth.organization.save()
    res.json({
      data: { name: req.auth.organization.name, ...next },
      meta: { requestId: req.requestId },
    })
  })

  router.get('/groups', authenticate, requirePermission('people.view'), async (req, res) => {
    const { page, limit } = parsePage(req.query)
    const filter = { organizationId: req.auth.organization._id }
    if (req.query.status !== 'all') filter.status = req.query.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE'
    if (req.query.kind) {
      if (!GROUP_KINDS.includes(req.query.kind)) throw new HttpError(400, 'VALIDATION_ERROR', 'Group kind is invalid.')
      filter.kind = req.query.kind
    }
    if (['TEACHER', 'MANAGER'].includes(req.auth.membership.role)) {
      filter._id = { $in: req.auth.membership.groupIds.filter(mongoose.isValidObjectId) }
    }
    const [groups, total] = await Promise.all([
      Group.find(filter).sort({ name: 1, _id: 1 }).skip((page - 1) * limit).limit(limit),
      Group.countDocuments(filter),
    ])
    res.json({
      data: groups.map(serializeGroup),
      meta: { page, limit, total, requestId: req.requestId },
    })
  })

  router.post('/groups', authenticate, requirePermission('groups.manage'), async (req, res) => {
    const { name, kind, parentId, supervisorUserId } = req.body || {}
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120 ||
      !GROUP_KINDS.includes(kind)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A group name and valid kind (CLASS, DEPARTMENT, TEAM) are required.')
    }
    const refs = await validateGroupReferences({ organizationId: req.auth.organization._id, parentId, supervisorUserId })
    const group = await Group.create({
      organizationId: req.auth.organization._id,
      name: name.trim(),
      kind,
      parentId: refs.parentId,
      supervisorUserId: refs.supervisorUserId,
    })
    res.status(201).json({ data: serializeGroup(group), meta: { requestId: req.requestId } })
  })

  router.get('/groups/:id', authenticate, requirePermission('people.view'), async (req, res) => {
    const group = await findGroup(req.params.id, req.auth.organization._id)
    res.json({ data: serializeGroup(group), meta: { requestId: req.requestId } })
  })

  router.patch('/groups/:id', authenticate, requirePermission('groups.manage'), async (req, res) => {
    const group = await findGroup(req.params.id, req.auth.organization._id)
    const input = req.body || {}
    const allowed = new Set(['name', 'kind', 'parentId', 'supervisorUserId', 'status'])
    if (!Object.keys(input).length || Object.keys(input).some((key) => !allowed.has(key))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Provide supported group fields to update.')
    }
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.trim().length > 120) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Group name must be between 2 and 120 characters.')
      }
      group.name = input.name.trim()
    }
    if (input.kind !== undefined) {
      if (!GROUP_KINDS.includes(input.kind)) throw new HttpError(400, 'VALIDATION_ERROR', 'Group kind is invalid.')
      group.kind = input.kind
    }
    if (input.status !== undefined) {
      if (!GROUP_STATUSES.includes(input.status)) throw new HttpError(400, 'VALIDATION_ERROR', 'Group status is invalid.')
      group.status = input.status
    }
    if (input.parentId !== undefined || input.supervisorUserId !== undefined) {
      const refs = await validateGroupReferences({
        organizationId: req.auth.organization._id,
        parentId: input.parentId === undefined ? group.parentId?.toString() : input.parentId,
        supervisorUserId: input.supervisorUserId === undefined ? group.supervisorUserId?.toString() : input.supervisorUserId,
        currentGroupId: group._id,
      })
      group.parentId = refs.parentId
      group.supervisorUserId = refs.supervisorUserId
    }

    if (group.status === 'ARCHIVED') {
      const [children, members] = await Promise.all([
        Group.exists({ organizationId: req.auth.organization._id, parentId: group._id, status: 'ACTIVE' }),
        Person.exists({ organizationId: req.auth.organization._id, groupId: group._id, status: 'ACTIVE' }),
      ])
      if (children || members) throw new HttpError(409, 'GROUP_NOT_EMPTY', 'Move active child groups and people before archiving this group.')
    }
    await group.save()
    res.json({ data: serializeGroup(group), meta: { requestId: req.requestId } })
  })

  router.get('/people', authenticate, requirePermission('people.view'), async (req, res) => {
    const { page, limit } = parsePage(req.query)
    const filter = { organizationId: req.auth.organization._id }
    if (req.query.type) {
      if (!PERSON_TYPES.includes(req.query.type)) throw new HttpError(400, 'VALIDATION_ERROR', 'Person type is invalid.')
      filter.type = req.query.type
    }
    if (req.query.status) {
      if (!PERSON_STATUSES.includes(req.query.status)) throw new HttpError(400, 'VALIDATION_ERROR', 'Person status is invalid.')
      filter.status = req.query.status
    }
    if (req.query.groupId) {
      if (!mongoose.isValidObjectId(req.query.groupId)) throw new HttpError(400, 'VALIDATION_ERROR', 'Group ID is invalid.')
      filter.groupId = req.query.groupId
    }
    if (req.auth.membership.role === 'TEACHER' || req.auth.membership.role === 'MANAGER') {
      const assigned = req.auth.membership.groupIds
      filter.groupId = req.query.groupId && assigned.includes(req.query.groupId)
        ? req.query.groupId
        : { $in: assigned.filter(mongoose.isValidObjectId) }
      if (req.query.groupId && !assigned.includes(req.query.groupId)) {
        return res.json({ data: [], meta: { page, limit, total: 0, requestId: req.requestId } })
      }
    }
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const query = req.query.q.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(query, 'i')
      filter.$or = [{ name: regex }, { personCode: regex }, { email: regex }]
    }
    const [people, total] = await Promise.all([
      Person.find(filter).sort({ name: 1, _id: 1 }).skip((page - 1) * limit).limit(limit),
      Person.countDocuments(filter),
    ])
    res.json({
      data: people.map(serializePerson),
      meta: { page, limit, total, requestId: req.requestId },
    })
  })

  router.post('/people', authenticate, requirePermission('people.manage'), async (req, res) => {
    const person = await createPerson(req.body, req.auth.organization._id, req.auth.user._id)
    res.status(201).json({ data: serializePerson(person), meta: { requestId: req.requestId } })
  })

  router.get('/people/:id', authenticate, requirePermission('people.view'), async (req, res) => {
    const person = await findPerson(req.params.id, req.auth.organization._id)
    assertPersonScope(person, req.auth.membership)
    res.json({ data: serializePerson(person), meta: { requestId: req.requestId } })
  })

  router.patch('/people/:id', authenticate, requirePermission('people.manage'), async (req, res) => {
    const person = await findPerson(req.params.id, req.auth.organization._id)
    assertPersonScope(person, req.auth.membership)
    const input = req.body || {}
    const allowed = new Set([
      'personCode', 'type', 'name', 'email', 'phone', 'status', 'groupId',
      'rollNumber', 'semester', 'employeeId', 'designation', 'consentGiven', 'cameraConsentGiven',
    ])
    if (!Object.keys(input).length || Object.keys(input).some((key) => !allowed.has(key))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Provide supported person fields to update.')
    }

    const next = {
      personCode: input.personCode ?? person.personCode,
      type: input.type ?? person.type,
      name: input.name ?? person.name,
      email: input.email ?? person.email,
      phone: input.phone ?? person.phone,
      status: input.status ?? person.status,
      groupId: input.groupId ?? person.groupId.toString(),
      rollNumber: input.rollNumber ?? person.rollNumber,
      semester: input.semester ?? person.semester,
      employeeId: input.employeeId ?? person.employeeId,
      designation: input.designation ?? person.designation,
      consentGiven: input.consentGiven ?? person.consentGiven,
      cameraConsentGiven: input.cameraConsentGiven === false
        ? false
        : person.cameraConsentGiven,
    }
    if (input.cameraConsentGiven !== undefined && input.cameraConsentGiven !== false) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Webcam consent must be recorded during webcam enrollment.')
    }
    validatePersonInput(next)
    await assertPersonGroup(req.auth.organization._id, next.groupId)
    assertGroupScope(next.groupId, req.auth.membership)
    const consentChanged = input.consentGiven !== undefined && input.consentGiven !== person.consentGiven
    const cameraConsentChanged = next.cameraConsentGiven !== person.cameraConsentGiven
    if (input.consentGiven === true && consentChanged) {
      person.consentGivenAt = new Date()
      person.consentSource = 'ADMIN_RECORDED'
    } else if (input.consentGiven === false && consentChanged) {
      person.consentGivenAt = null
      person.consentSource = null
    }
    if (cameraConsentChanged) {
      person.cameraConsentGivenAt = next.cameraConsentGiven ? new Date() : null
      person.cameraConsentSource = next.cameraConsentGiven ? 'ADMIN_RECORDED' : null
    }

    Object.assign(person, next)
    if (consentChanged) {
      person.consentHistory.push({
        given: input.consentGiven,
        actorUserId: req.auth.user._id,
        source: 'ADMIN_RECORDED',
      })
    }
    if (cameraConsentChanged) {
      person.cameraConsentHistory.push({
        given: next.cameraConsentGiven,
        actorUserId: req.auth.user._id,
        source: 'ADMIN_RECORDED',
      })
    }
    await person.save()
    if (!next.cameraConsentGiven || next.status === 'INACTIVE') {
      await faceTemplateStore.deleteForPerson(req.auth.organization._id, person._id)
    }
    res.json({ data: serializePerson(person), meta: { requestId: req.requestId } })
  })

  router.post('/people/import/preview', parseCsvBody, authenticate, requirePermission('people.manage'), async (req, res) => {
    const csv = typeof req.body === 'string' ? req.body : req.body?.csv
    const assignGroupId = typeof req.body === 'string' ? req.query.assignGroupId : req.body?.assignGroupId
    if (assignGroupId !== undefined && typeof assignGroupId !== 'string') {
      throw new HttpError(400, 'VALIDATION_ERROR', 'assignGroupId must be a string.')
    }
    const rows = parseImportRows(csv)
    const validated = await validateImportRows(rows, req.auth.organization._id, req.auth.membership, assignGroupId)
    res.json({ data: validated, meta: { requestId: req.requestId } })
  })

  router.post('/people/import', parseCsvBody, authenticate, requirePermission('people.manage'), async (req, res) => {
    const csv = typeof req.body === 'string' ? req.body : req.body?.csv
    const assignGroupId = typeof req.body === 'string' ? req.query.assignGroupId : req.body?.assignGroupId
    if (assignGroupId !== undefined && typeof assignGroupId !== 'string') {
      throw new HttpError(400, 'VALIDATION_ERROR', 'assignGroupId must be a string.')
    }
    const idempotencyKey = req.get('idempotency-key') || req.body?.idempotencyKey
    if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{12,100}$/.test(idempotencyKey)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A 12–100 character idempotencyKey is required.')
    }
    const contentForHash = `${String(csv || '')}${assignGroupId ? `\0group:${assignGroupId}` : ''}`
    const contentHash = require('node:crypto').createHash('sha256').update(contentForHash).digest('hex')
    const ImportBatch = require('../models/ImportBatch')
    const existing = await ImportBatch.findOne({
      organizationId: req.auth.organization._id,
      idempotencyKey,
    })
    if (existing) {
      if (existing.contentHash !== contentHash) {
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for different CSV content.')
      }
      return res.json({ data: existing.result, meta: { requestId: req.requestId, replayed: true } })
    }

    const rows = parseImportRows(csv)
    const validation = await validateImportRows(rows, req.auth.organization._id, req.auth.membership, assignGroupId)
    if (validation.invalidCount > 0) {
      throw new HttpError(400, 'IMPORT_VALIDATION_FAILED', 'Fix the invalid rows before confirming the import.')
    }

    const result = { created: 0, skipped: 0, rowResults: [] }
    for (const row of validation.rows) {
      try {
        const person = await createPerson(row.data, req.auth.organization._id, req.auth.user._id)
        result.created += 1
        result.rowResults.push({ row: row.row, status: 'CREATED', personId: person._id.toString() })
      } catch (error) {
        if (error.code === 11000) {
          result.skipped += 1
          result.rowResults.push({ row: row.row, status: 'SKIPPED', error: 'Person code already exists.' })
          continue
        }
        throw error
      }
    }

    try {
      await ImportBatch.create({
        organizationId: req.auth.organization._id,
        idempotencyKey,
        contentHash,
        result,
      })
    } catch (error) {
      if (error.code !== 11000) throw error
      const replay = await ImportBatch.findOne({ organizationId: req.auth.organization._id, idempotencyKey })
      if (!replay || replay.contentHash !== contentHash) {
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for different CSV content.')
      }
      return res.json({ data: replay.result, meta: { requestId: req.requestId, replayed: true } })
    }
    res.status(201).json({ data: result, meta: { requestId: req.requestId } })
  })

  return router
}

async function validateGroupReferences({ organizationId, parentId, supervisorUserId, currentGroupId }) {
  let parent = null
  if (parentId) {
    if (!mongoose.isValidObjectId(parentId) || parentId.toString() === currentGroupId?.toString()) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Parent group ID is invalid.')
    }
    parent = await Group.findOne({ _id: parentId, organizationId, status: 'ACTIVE' })
    if (!parent) throw new HttpError(400, 'VALIDATION_ERROR', 'Parent group must be active in this organization.')
    let ancestor = parent
    while (ancestor && currentGroupId) {
      if (ancestor._id.toString() === currentGroupId.toString()) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'A group cannot be moved beneath one of its descendants.')
      }
      ancestor = ancestor.parentId
        ? await Group.findOne({ _id: ancestor.parentId, organizationId, status: 'ACTIVE' }).select('_id parentId')
        : null
    }
  }

  let supervisor = null
  if (supervisorUserId) {
    if (!mongoose.isValidObjectId(supervisorUserId)) throw new HttpError(400, 'VALIDATION_ERROR', 'Supervisor user ID is invalid.')
    supervisor = await User.findOne({
      _id: supervisorUserId,
      status: 'ACTIVE',
      memberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
    })
    if (!supervisor) throw new HttpError(400, 'VALIDATION_ERROR', 'Supervisor must be an active user in this organization.')
  }

  return { parentId: parent?._id ?? null, supervisorUserId: supervisor?._id ?? null }
}

async function findGroup(id, organizationId) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'NOT_FOUND', 'The requested group was not found.')
  const group = await Group.findOne({ _id: id, organizationId })
  if (!group) throw new HttpError(404, 'NOT_FOUND', 'The requested group was not found.')
  return group
}

async function findPerson(id, organizationId) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'NOT_FOUND', 'The requested person was not found.')
  const person = await Person.findOne({ _id: id, organizationId })
  if (!person) throw new HttpError(404, 'NOT_FOUND', 'The requested person was not found.')
  return person
}

function assertPersonScope(person, membership) {
  assertGroupScope(person.groupId.toString(), membership)
}

function assertGroupScope(groupId, membership) {
  if (['TEACHER', 'MANAGER'].includes(membership.role) && !membership.groupIds.includes(groupId.toString())) {
    throw new HttpError(403, 'GROUP_ACCESS_DENIED', 'You do not have access to this group.')
  }
}

async function assertPersonGroup(organizationId, groupId) {
  if (!mongoose.isValidObjectId(groupId) ||
    !await Group.exists({ _id: groupId, organizationId, status: 'ACTIVE' })) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Person group must be active in this organization.')
  }
}

function validatePersonInput(input) {
  if (typeof input.personCode !== 'string' || input.personCode.trim().length < 2 || input.personCode.trim().length > 40 ||
    !PERSON_TYPES.includes(input.type) ||
    typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.trim().length > 120 ||
    !validEmail(input.email) ||
    typeof input.email !== 'string' || !validEmail(input.email) ||
    typeof input.phone !== 'string' || input.phone.length > 32 ||
    !PERSON_STATUSES.includes(input.status) ||
    typeof input.groupId !== 'string' ||
    typeof input.consentGiven !== 'boolean' ||
    (input.cameraConsentGiven !== undefined && typeof input.cameraConsentGiven !== 'boolean')) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Person fields are invalid; code, name, type, phone, status, group, and consent are required.')
  }
  for (const field of ['rollNumber', 'semester', 'employeeId', 'designation']) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > 120)) {
      throw new HttpError(400, 'VALIDATION_ERROR', `${field} must be a string of at most 120 characters.`)
    }
  }
}

async function createPerson(input, organizationId, actorUserId) {
  validatePersonInput(input)
  await assertPersonGroup(organizationId, input.groupId)
  const values = {
    organizationId,
    personCode: input.personCode.trim().toUpperCase(),
    type: input.type,
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    phone: input.phone.trim(),
    status: input.status,
    groupId: input.groupId,
    rollNumber: input.rollNumber?.trim() || '',
    semester: input.semester?.trim() || '',
    employeeId: input.employeeId?.trim() || '',
    designation: input.designation?.trim() || '',
    consentGiven: input.consentGiven,
    consentGivenAt: input.consentGiven ? new Date() : null,
    consentSource: input.consentGiven ? 'ADMIN_RECORDED' : null,
    cameraConsentGiven: false,
    cameraConsentGivenAt: null,
    cameraConsentSource: null,
    consentHistory: input.consentGiven ? [{
      given: true,
      actorUserId,
      source: 'ADMIN_RECORDED',
      recordedAt: new Date(),
    }] : [],
  }
  const person = await Person.create(values)
  return person
}

function parseImportRows(csv) {
  if (typeof csv !== 'string' || csv.length === 0 || Buffer.byteLength(csv, 'utf8') > 2_000_000) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'CSV content is required and must be no larger than 2 MB.')
  }
  const { parseCsv } = require('../lib/csv')
  const parsed = parseCsv(csv)
  if (!parsed || parsed.length < 2) throw new HttpError(400, 'INVALID_CSV', 'CSV must include a header and at least one data row.')
  if (parsed.length > 5001) throw new HttpError(400, 'IMPORT_TOO_LARGE', 'An import may contain at most 5,000 people.')

  const headers = parsed[0].map((header) => String(header).trim().toLowerCase())
  if (new Set(headers).size !== headers.length || !headers.includes('personcode') || !headers.includes('name')) {
    throw new HttpError(400, 'INVALID_CSV', 'CSV headers must include unique personCode and name columns.')
  }
  return parsed.slice(1).map((values, index) => {
    const row = {}
    headers.forEach((header, column) => { row[header] = values[column] ?? '' })
    return { row: index + 2, values: row }
  })
}

async function validateImportRows(rows, organizationId, membership, assignGroupId) {
  const groupIds = new Set()
  for (const row of rows) {
    const groupId = assignGroupId || row.values.groupid
    if (groupId) groupIds.add(groupId)
  }
  const foundGroups = await Group.find({
    organizationId,
    status: 'ACTIVE',
    _id: { $in: [...groupIds].filter(mongoose.isValidObjectId) },
  }).select('_id')
  const validGroupIds = new Set(foundGroups.map((group) => group._id.toString()))
  const seenCodes = new Set()
  const seenEmails = new Set()
  const existingCodes = new Set()
  const existingEmails = new Set()
  const codes = rows.map(({ values }) => String(values.personcode || '').trim().toUpperCase()).filter(Boolean)
  const emails = rows.map(({ values }) => String(values.email || '').trim().toLowerCase()).filter(Boolean)
  const existing = await Person.find({
    organizationId,
    $or: [
      { personCode: { $in: codes } },
      { email: { $in: emails } },
    ],
  }).select('personCode email')
  for (const person of existing) {
    existingCodes.add(person.personCode)
    if (person.email) existingEmails.add(person.email)
  }

  const checked = rows.map(({ row, values }) => {
    const errors = []
    const personCode = String(values.personcode || '').trim().toUpperCase()
    const name = String(values.name || '').trim()
    const type = String(values.type || 'STUDENT').trim().toUpperCase()
    const email = String(values.email || '').trim().toLowerCase()
    const phone = String(values.phone || '').trim()
    const groupId = String(assignGroupId || values.groupid || '').trim()
    if (personCode.length < 2 || personCode.length > 40) errors.push('personCode is required (2–40 characters).')
    if (name.length < 2 || name.length > 120) errors.push('name is required (2–120 characters).')
    if (!PERSON_TYPES.includes(type)) errors.push('type must be STUDENT or EMPLOYEE.')
    if (!validEmail(email)) errors.push('email must be valid when provided.')
    if (phone.length > 32) errors.push('phone cannot exceed 32 characters.')
    if (!groupId || !validGroupIds.has(groupId)) errors.push('groupId must identify an active group in this organization.')
    if (groupId) {
      try {
        assertGroupScope(groupId, membership)
      } catch {
        errors.push('You do not have access to the specified group.')
      }
    }
    if (personCode && (seenCodes.has(personCode) || existingCodes.has(personCode))) errors.push('personCode already exists in this organization or import.')
    if (email && (seenEmails.has(email) || existingEmails.has(email))) errors.push('email already exists in this organization or import.')
    if (personCode) seenCodes.add(personCode)
    if (email) seenEmails.add(email)

    return {
      row,
      valid: errors.length === 0,
      errors,
      data: {
        personCode,
        type,
        name,
        email,
        phone,
        status: 'ACTIVE',
        groupId,
        rollNumber: String(values.rollnumber || '').trim(),
        semester: String(values.semester || '').trim(),
        employeeId: String(values.employeeid || '').trim(),
        designation: String(values.designation || '').trim(),
        consentGiven: String(values.consentgiven || '').trim().toLowerCase() === 'true',
      },
    }
  })
  return {
    totalRows: checked.length,
    validCount: checked.filter((item) => item.valid).length,
    invalidCount: checked.filter((item) => !item.valid).length,
    rows: checked,
  }
}

module.exports = { createOrganizationRouter, serializeGroup, serializePerson, parseImportRows, validateImportRows }
