const { randomBytes, createHash } = require('node:crypto')
const bcrypt = require('bcryptjs')
const express = require('express')
const rateLimit = require('express-rate-limit')
const jwt = require('jsonwebtoken')
const Group = require('../models/Group')
const Invitation = require('../models/Invitation')
const Organization = require('../models/Organization')
const Person = require('../models/Person')
const RefreshSession = require('../models/RefreshSession')
const User = require('../models/User')
const { HttpError } = require('../lib/httpError')
const { hashInvitationCode } = require('../lib/invitations')
const { hashPassword, validatePassword, verifyPassword } = require('../lib/passwords')
const { createAuthenticate } = require('../middleware/authenticate')

const HOUR = 60 * 60 * 1000
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-value', 12)

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

function publicUser(user, membership, organizationId = null) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: membership.role,
    groupIds: membership.groupIds,
    ...(organizationId ? { organizationId: organizationId.toString() } : {}),
  }
}

function createAuthRouter({
  config,
  logger = console,
  mailer,
  rateLimits = { login: 10, reset: 5 },
  authenticate = createAuthenticate({ config }),
}) {
  const router = express.Router()
  const sendPasswordReset = mailer || require('../services/mailer').createMailer(config, logger)
  const rateLimitHandler = (_req, _res, next) => next(new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.'))
  const loginLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.nodeEnv === 'development' ? 200 : rateLimits.login,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: rateLimitHandler,
  })
  const resetLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: rateLimits.reset,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: rateLimitHandler,
  })
  const inviteLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.nodeEnv === 'development' ? 200 : rateLimits.login,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: rateLimitHandler,
  })

  function issueAccessToken(user, membership, organizationId, sessionId) {
    return jwt.sign({
      ...(organizationId ? { org: organizationId.toString() } : { platform: true }),
      sid: sessionId.toString(),
    }, config.accessTokenSecret, {
      algorithm: 'HS256',
      subject: user._id.toString(),
      expiresIn: config.accessTokenTtl,
      issuer: 'pr-smart-attendance',
      audience: 'pr-smart-attendance-api',
    })
  }

  async function activeMemberships(user) {
    const memberships = user.memberships.filter((membership) => membership.status === 'ACTIVE')
    const organizations = await Organization.find({
      _id: { $in: memberships.map((membership) => membership.organizationId) },
      status: 'ACTIVE',
    })
    const byId = new Map(organizations.map((organization) => [organization._id.toString(), organization]))
    return memberships
      .filter((membership) => byId.has(membership.organizationId.toString()))
      .map((membership) => ({
        membership,
        organization: byId.get(membership.organizationId.toString()),
      }))
  }

  router.post('/login', loginLimit, async (req, res) => {
    const { email, password, organizationId } = req.body || {}
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== 'string' || password.length > 128) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A valid email and password are required.')
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash')
    const passwordMatches = await verifyPassword(password, user?.passwordHash || DUMMY_HASH)
    if (!user || user.status !== 'ACTIVE' || !passwordMatches) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.')
    }

    const platformMembership = user.memberships.find((membership) =>
      membership.role === 'SUPER_ADMIN' && membership.status === 'ACTIVE')
    if (platformMembership) {
      const refreshToken = randomBytes(48).toString('base64url')
      const expiresAt = new Date(Date.now() + config.refreshTokenDays * 24 * HOUR)
      const session = await RefreshSession.create({
        userId: user._id,
        organizationId: null,
        tokenHash: tokenHash(refreshToken),
        expiresAt,
      })
      return res.json({
        data: {
          user: publicUser(user, platformMembership),
          accessToken: issueAccessToken(user, platformMembership, null, session._id),
          refreshToken,
        },
        meta: { requestId: req.requestId },
      })
    }

    const memberships = await activeMemberships(user)
    if (!memberships.length) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.')
    }
    if (!organizationId && memberships.length > 1) {
      return res.json({
        data: {
          organizationSelectionRequired: true,
          organizations: memberships.map(({ organization }) => ({
            id: organization._id.toString(),
            name: organization.name,
          })),
        },
        meta: { requestId: req.requestId },
      })
    }
    const selected = organizationId
      ? memberships.find(({ organization }) => organization._id.toString() === organizationId)
      : memberships[0]
    if (!selected) throw new HttpError(403, 'ORGANIZATION_ACCESS_DENIED', 'You do not have access to this organization.')

    const refreshToken = randomBytes(48).toString('base64url')
    const expiresAt = new Date(Date.now() + config.refreshTokenDays * 24 * HOUR)
    const session = await RefreshSession.create({
      userId: user._id,
      organizationId: selected.organization._id,
      tokenHash: tokenHash(refreshToken),
      expiresAt,
    })

    res.json({
      data: {
        user: publicUser(user, selected.membership, selected.organization._id),
        accessToken: issueAccessToken(user, selected.membership, selected.organization._id, session._id),
        refreshToken,
        organizations: memberships.map(({ organization }) => ({ id: organization._id.toString(), name: organization.name })),
      },
      meta: { requestId: req.requestId },
    })
  })

  router.post('/accept-invitation', inviteLimit, async (req, res) => {
    const { code, password } = req.body || {}
    if (typeof code !== 'string' || code.length !== 32 ||
      typeof password !== 'string' || password.length > 128) {
      throw new HttpError(400, 'INVALID_INVITATION', 'A valid invitation code and password are required.')
    }

    const now = new Date()
    const claimId = randomBytes(18).toString('base64url')
    const staleClaim = new Date(now.getTime() - 5 * 60 * 1000)
    const invitation = await Invitation.findOneAndUpdate({
      codeHash: hashInvitationCode(code),
      usedAt: null,
      revokedAt: null,
      expiresAt: { $gt: now },
      $or: [{ claimId: null }, { claimedAt: { $lt: staleClaim } }],
    }, {
      $set: { claimId, claimedAt: now },
    }, { returnDocument: 'after' })
    if (!invitation) {
      throw new HttpError(400, 'INVALID_INVITATION', 'This invitation is invalid, expired, or has already been used.')
    }

    let createdUserId
    let addedMembershipUserId
    let createdPersonId
    let sessionId
    let invitationUsed = false
    try {
      const organization = await Organization.findOne({ _id: invitation.organizationId, status: 'ACTIVE' })
      if (!organization) throw new HttpError(400, 'INVALID_INVITATION', 'This organization is not accepting registrations.')

      const existingUser = await User.findOne({ email: invitation.email }).select('+passwordHash')
      if (existingUser?.memberships.some((membership) =>
        membership.organizationId.toString() === organization._id.toString())) {
        throw new HttpError(409, 'ACCOUNT_ALREADY_REGISTERED', 'This email already has an account in this organization.')
      }
      if (existingUser) {
        if (!(await verifyPassword(password, existingUser.passwordHash))) {
          throw new HttpError(401, 'INVALID_CREDENTIALS', 'Enter the existing account password to join this organization.')
        }
      } else if (!validatePassword(password)) {
        throw new HttpError(400, 'WEAK_PASSWORD', 'Create a password of 12–128 characters with uppercase, lowercase, number, and symbol characters.')
      }

      let person = null
      if (['STUDENT', 'EMPLOYEE'].includes(invitation.role)) {
        if (!invitation.personGroupId || !await Group.exists({
          _id: invitation.personGroupId,
          organizationId: organization._id,
          status: 'ACTIVE',
        })) {
          throw new HttpError(400, 'INVALID_INVITATION', 'The invitation group is no longer active.')
        }
        person = await Person.findOne({
          organizationId: organization._id,
          email: invitation.email,
        })
        if (person && (person.type !== invitation.role || person.groupId.toString() !== invitation.personGroupId.toString())) {
          throw new HttpError(409, 'PERSON_ALREADY_REGISTERED', 'This email is already registered as a different person in the organization.')
        }
        if (!person) {
          person = await Person.create({
            organizationId: organization._id,
            personCode: `${invitation.role === 'STUDENT' ? 'STU' : 'EMP'}-${randomBytes(8).toString('hex')}`,
            type: invitation.role,
            name: invitation.name,
            email: invitation.email,
            phone: '',
            status: 'ACTIVE',
            groupId: invitation.personGroupId,
            consentGiven: false,
          })
          createdPersonId = person._id
        }
      }

      const membership = {
        organizationId: organization._id,
        role: invitation.role,
        groupIds: invitation.groupIds,
        ...(person ? { personId: person._id } : {}),
        status: 'ACTIVE',
      }
      let user = existingUser
      if (user) {
        user.memberships.push(membership)
        await user.save()
        addedMembershipUserId = user._id
      } else {
        user = await User.create({
          name: invitation.name,
          email: invitation.email,
          passwordHash: await hashPassword(password),
          memberships: [membership],
        })
        createdUserId = user._id
      }

      const refreshToken = randomBytes(48).toString('base64url')
      const session = await RefreshSession.create({
        userId: user._id,
        organizationId: organization._id,
        tokenHash: tokenHash(refreshToken),
        expiresAt: new Date(Date.now() + config.refreshTokenDays * 24 * HOUR),
      })
      sessionId = session._id
      const consumed = await Invitation.updateOne(
        { _id: invitation._id, claimId, usedAt: null },
        { $set: { usedAt: new Date() }, $unset: { claimId: 1, claimedAt: 1 } },
      )
      if (consumed.modifiedCount !== 1) {
        throw new HttpError(409, 'INVITATION_ALREADY_USED', 'This invitation has already been used.')
      }
      invitationUsed = true

      res.status(201).json({
        data: {
          user: publicUser(user, membership, organization._id),
          accessToken: issueAccessToken(user, membership, organization._id, session._id),
          refreshToken,
        },
        meta: { requestId: req.requestId },
      })
    } catch (error) {
      if (!invitationUsed) {
        if (sessionId) await RefreshSession.deleteOne({ _id: sessionId })
        if (createdUserId) await User.deleteOne({ _id: createdUserId })
        if (addedMembershipUserId) {
          await User.updateOne(
            { _id: addedMembershipUserId },
            { $pull: { memberships: { organizationId: invitation.organizationId } } },
          )
        }
        if (createdPersonId) await Person.deleteOne({ _id: createdPersonId })
        await Invitation.updateOne(
          { _id: invitation._id, claimId },
          { $set: { claimId: null, claimedAt: null } },
        )
      } else if (sessionId) {
        await RefreshSession.updateOne({ _id: sessionId }, { $set: { revokedAt: new Date() } })
      }
      throw error
    }
  })

  router.post('/refresh', async (req, res) => {
    const { refreshToken } = req.body || {}
    if (typeof refreshToken !== 'string' || refreshToken.length < 32 || refreshToken.length > 256) {
      throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'A valid refresh token is required.')
    }

    const now = new Date()
    const session = await RefreshSession.findOne({
      tokenHash: tokenHash(refreshToken),
      revokedAt: null,
      expiresAt: { $gt: now },
    }).select('+tokenHash')
    if (!session) throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'A valid refresh token is required.')

    const isPlatformSession = session.organizationId == null
    const user = await User.findOne(isPlatformSession
      ? {
          _id: session.userId,
          status: 'ACTIVE',
          memberships: { $elemMatch: { role: 'SUPER_ADMIN', status: 'ACTIVE' } },
        }
      : {
          _id: session.userId,
          status: 'ACTIVE',
          memberships: {
            $elemMatch: { organizationId: session.organizationId, status: 'ACTIVE' },
          },
        })
    const organization = isPlatformSession
      ? null
      : await Organization.findOne({ _id: session.organizationId, status: 'ACTIVE' })
    const membership = isPlatformSession
      ? user?.memberships.find((item) => item.role === 'SUPER_ADMIN' && item.status === 'ACTIVE')
      : user?.memberships.find((item) =>
          item.organizationId.toString() === session.organizationId.toString() && item.status === 'ACTIVE')
    if (!user || (!isPlatformSession && !organization) || !membership) {
      await RefreshSession.updateOne({ _id: session._id, revokedAt: null }, { $set: { revokedAt: now } })
      throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'A valid refresh token is required.')
    }

    const nextRefreshToken = randomBytes(48).toString('base64url')
    const nextExpiry = new Date(Date.now() + config.refreshTokenDays * 24 * HOUR)
    const rotation = await RefreshSession.updateOne(
      { _id: session._id, tokenHash: tokenHash(refreshToken), revokedAt: null, expiresAt: { $gt: now } },
      { $set: { tokenHash: tokenHash(nextRefreshToken), expiresAt: nextExpiry } },
    )
    if (rotation.modifiedCount !== 1) {
      throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'A valid refresh token is required.')
    }

    res.json({
      data: {
        user: publicUser(user, membership, organization?._id),
        accessToken: issueAccessToken(user, membership, organization?._id ?? null, session._id),
        refreshToken: nextRefreshToken,
      },
      meta: { requestId: req.requestId },
    })
  })

  router.post('/logout', async (req, res) => {
    const { refreshToken } = req.body || {}
    if (typeof refreshToken === 'string' && refreshToken.length >= 32 && refreshToken.length <= 256) {
      await RefreshSession.updateOne(
        { tokenHash: tokenHash(refreshToken), revokedAt: null },
        { $set: { revokedAt: new Date() } },
      )
    }
    res.json({ data: { loggedOut: true }, meta: { requestId: req.requestId } })
  })

  router.get('/me', authenticate, (req, res) => {
    res.json({
      data: publicUser(req.auth.user, req.auth.membership, req.auth.organization?._id),
      meta: { requestId: req.requestId },
    })
  })

  router.post('/forgot-password', resetLimit, async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
    let developmentResetUrl
    if (email && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const user = await User.findOne({ email, status: 'ACTIVE' })
      if (user) {
        const resetToken = randomBytes(32).toString('base64url')
        user.passwordResetHash = tokenHash(resetToken)
        user.passwordResetExpiresAt = new Date(Date.now() + HOUR)
        await user.save()
        const remoteAddress = req.socket.remoteAddress
        const isLoopback = remoteAddress === '127.0.0.1' ||
          remoteAddress === '::1' ||
          remoteAddress === '::ffff:127.0.0.1'
        if (config.nodeEnv === 'development' && config.devPasswordResetEnabled && isLoopback) {
          const resetUrl = new URL('/reset-password', config.appUrl)
          resetUrl.searchParams.set('token', resetToken)
          developmentResetUrl = resetUrl.toString()
        } else {
          try {
            await sendPasswordReset.sendPasswordReset(user.email, resetToken)
          } catch (error) {
            logger.error(JSON.stringify({
              level: 'error',
              event: 'password_reset_email_failed',
              requestId: req.requestId,
              message: error instanceof Error ? error.message : 'Unknown error',
            }))
          }
        }
      }
    }
    res.status(202).json({
      data: {
        message: 'If the account exists, password reset instructions will be sent.',
        ...(developmentResetUrl ? { developmentResetUrl } : {}),
      },
      meta: { requestId: req.requestId },
    })
  })

  router.post('/reset-password', resetLimit, async (req, res) => {
    const { token, newPassword } = req.body || {}
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) {
      throw new HttpError(400, 'INVALID_RESET_TOKEN', 'The password reset link is invalid or expired.')
    }
    if (!validatePassword(newPassword)) {
      throw new HttpError(400, 'WEAK_PASSWORD', 'Password must be 12–128 characters and include uppercase, lowercase, number, and symbol characters.')
    }

    const user = await User.findOne({
      passwordResetHash: tokenHash(token),
      passwordResetExpiresAt: { $gt: new Date() },
      status: 'ACTIVE',
    }).select('+passwordResetHash +passwordResetExpiresAt')
    if (!user) throw new HttpError(400, 'INVALID_RESET_TOKEN', 'The password reset link is invalid or expired.')

    user.passwordHash = await hashPassword(newPassword)
    user.passwordResetHash = undefined
    user.passwordResetExpiresAt = undefined
    await user.save()
    await RefreshSession.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } })
    res.json({ data: { passwordUpdated: true }, meta: { requestId: req.requestId } })
  })

  router.post('/change-password', authenticate, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {}
    if (typeof currentPassword !== 'string' || !validatePassword(newPassword)) {
      throw new HttpError(400, 'WEAK_PASSWORD', 'New password must be 12–128 characters and include uppercase, lowercase, number, and symbol characters.')
    }
    const user = await User.findById(req.auth.user._id).select('+passwordHash')
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect.')
    }
    if (currentPassword === newPassword) {
      throw new HttpError(400, 'PASSWORD_UNCHANGED', 'Choose a password different from the current password.')
    }

    user.passwordHash = await hashPassword(newPassword)
    await user.save()
    await RefreshSession.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } })
    res.json({ data: { passwordUpdated: true, sessionsRevoked: true }, meta: { requestId: req.requestId } })
  })

  router.get('/organizations', authenticate, async (req, res) => {
    const memberships = await activeMemberships(req.auth.user)
    const organizations = memberships.map(({ membership, organization }) => ({
      id: organization._id.toString(),
      name: organization.name,
      role: membership.role,
    }))
    res.json({ data: organizations, meta: { requestId: req.requestId } })
  })

  return router
}

module.exports = { createAuthRouter, publicUser, tokenHash }
