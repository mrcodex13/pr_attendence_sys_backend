const express = require('express')
const mongoose = require('mongoose')
const User = require('../models/User')
const Group = require('../models/Group')
const RefreshSession = require('../models/RefreshSession')
const { HttpError } = require('../lib/httpError')
const { createAuthenticate } = require('../middleware/authenticate')
const { requirePermission } = require('../middleware/authorize')

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'TEACHER', 'MANAGER', 'EMPLOYEE', 'STUDENT']

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function serializeUser(user, organizationId) {
  const membership = user.memberships.find((item) =>
    item.organizationId.toString() === organizationId.toString())
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: membership.role,
    groupIds: membership.groupIds,
    status: membership.status,
    createdAt: user.createdAt,
  }
}

function createUsersRouter({ config, authenticate = createAuthenticate({ config }) }) {
  const router = express.Router()
  router.use(authenticate)
  router.use(requirePermission('users.manage'))

  router.get('/', async (req, res) => {
    const page = Number(req.query.page || 1)
    const limit = Number(req.query.limit || 25)
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Page must be positive and limit must be between 1 and 100.')
    }
    if (req.query.role !== undefined && !ROLES.includes(req.query.role)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'User role filter is invalid.')
    }
    if (req.query.status !== undefined && !['ACTIVE', 'INACTIVE'].includes(req.query.status)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'User status filter is invalid.')
    }

    const membershipFilter = { organizationId: req.auth.organization._id }
    if (req.query.role) membershipFilter.role = req.query.role
    if (req.query.status) membershipFilter.status = req.query.status
    const filter = { memberships: { $elemMatch: membershipFilter } }
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const q = new RegExp(escapeRegex(req.query.q.trim().slice(0, 100)), 'i')
      filter.$or = [{ name: q }, { email: q }]
    }

    const [users, total] = await Promise.all([
      User.find(filter).sort({ name: 1, _id: 1 }).skip((page - 1) * limit).limit(limit),
      User.countDocuments(filter),
    ])
    res.json({
      data: users.map((user) => serializeUser(user, req.auth.organization._id)),
      meta: { page, limit, total, requestId: req.requestId },
    })
  })

  router.get('/:id', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'The requested user was not found.')
    const user = await User.findOne({
      _id: req.params.id,
      memberships: { $elemMatch: { organizationId: req.auth.organization._id } },
    })
    if (!user) throw new HttpError(404, 'NOT_FOUND', 'The requested user was not found.')
    res.json({ data: serializeUser(user, req.auth.organization._id), meta: { requestId: req.requestId } })
  })

  router.patch('/:id', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'The requested user was not found.')
    if (req.params.id === req.auth.user._id.toString()) {
      throw new HttpError(409, 'SELF_MODIFICATION_DENIED', 'Use profile settings to manage your own account.')
    }
    const user = await User.findOne({
      _id: req.params.id,
      memberships: { $elemMatch: { organizationId: req.auth.organization._id } },
    })
    if (!user) throw new HttpError(404, 'NOT_FOUND', 'The requested user was not found.')

    const membership = user.memberships.find((item) =>
      item.organizationId.toString() === req.auth.organization._id.toString())
    const input = req.body || {}
    const allowed = new Set(['name', 'role', 'groupIds', 'status'])
    if (Object.keys(input).some((key) => !allowed.has(key))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Only name, role, groupIds, and status may be updated.')
    }
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.trim().length > 120) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Name must be between 2 and 120 characters.')
      }
      user.name = input.name.trim()
    }
    if (input.role !== undefined) {
      if (!['ADMIN', 'TEACHER', 'MANAGER'].includes(input.role)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Roles for employee and student accounts can only be assigned through invitations.')
      }
      if (membership.role === 'SUPER_ADMIN') {
        throw new HttpError(403, 'ROLE_ASSIGNMENT_DENIED', 'Super-admin memberships cannot be changed here.')
      }
      if (input.role === 'SUPER_ADMIN' || (input.role === 'ADMIN' && req.auth.membership.role !== 'SUPER_ADMIN')) {
        throw new HttpError(403, 'ROLE_ASSIGNMENT_DENIED', 'Only a super admin can assign the admin role; super-admin role cannot be assigned through this endpoint.')
      }
      membership.role = input.role
    }
    if (input.groupIds !== undefined) {
      if (!Array.isArray(input.groupIds) ||
        input.groupIds.some((groupId) => typeof groupId !== 'string' || groupId.length > 100) ||
        new Set(input.groupIds).size !== input.groupIds.length) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Group IDs must be a unique list of strings.')
      }
      await validateOrganizationGroups(input.groupIds, req.auth.organization._id)
      membership.groupIds = input.groupIds
    }
    if (input.status !== undefined) {
      if (!['ACTIVE', 'INACTIVE'].includes(input.status)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Status must be ACTIVE or INACTIVE.')
      }
      membership.status = input.status
    }

    await user.save()
    if (input.status === 'INACTIVE') {
      await RefreshSession.updateMany(
        { userId: user._id, organizationId: req.auth.organization._id, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      )
    }
    res.json({ data: serializeUser(user, req.auth.organization._id), meta: { requestId: req.requestId } })
  })

  return router
}

async function validateOrganizationGroups(groupIds, organizationId) {
  const validIds = groupIds.filter(mongoose.isValidObjectId)
  if (validIds.length !== groupIds.length) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Group IDs must identify groups in the active organization.')
  }
  const count = await Group.countDocuments({
    _id: { $in: validIds },
    organizationId,
    status: 'ACTIVE',
  })
  if (count !== new Set(validIds.map((id) => id.toString())).size) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Group IDs must identify active groups in the active organization.')
  }
}

module.exports = { createUsersRouter, serializeUser }
