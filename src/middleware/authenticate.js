const jwt = require('jsonwebtoken')
const mongoose = require('mongoose')
const Organization = require('../models/Organization')
const RefreshSession = require('../models/RefreshSession')
const User = require('../models/User')
const { HttpError } = require('../lib/httpError')

function createAuthenticate({ config }) {
  return async function authenticate(req, _res, next) {
    try {
      const authorization = req.get('authorization') || ''
      const match = authorization.match(/^Bearer ([^\s]+)$/i)
      if (!match) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid access token is required.')

      let claims
      try {
        claims = jwt.verify(match[1], config.accessTokenSecret, { algorithms: ['HS256'] })
      } catch {
        throw new HttpError(401, 'UNAUTHENTICATED', 'A valid access token is required.')
      }

      const isPlatformSession = claims.platform === true
      if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string' ||
        (isPlatformSession ? claims.org !== undefined : typeof claims.org !== 'string')) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'A valid access token is required.')
      }
      if (!mongoose.isValidObjectId(claims.sub) || !mongoose.isValidObjectId(claims.sid) ||
        (!isPlatformSession && !mongoose.isValidObjectId(claims.org))) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'A valid access token is required.')
      }

      const [user, session] = await Promise.all([
        User.findById(claims.sub),
        RefreshSession.findOne({
          _id: claims.sid,
          userId: claims.sub,
          organizationId: isPlatformSession ? null : claims.org,
          revokedAt: null,
          expiresAt: { $gt: new Date() },
        }),
      ])
      if (!user || user.status !== 'ACTIVE' || !session) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'A valid access token is required.')
      }

      const membership = isPlatformSession
        ? user.memberships.find((item) => item.role === 'SUPER_ADMIN' && item.status === 'ACTIVE')
        : user.memberships.find((item) =>
            item.organizationId.toString() === claims.org && item.status === 'ACTIVE')
      if (!membership) throw new HttpError(403, 'ORGANIZATION_ACCESS_DENIED', 'You do not have access to this organization.')

      const requestedOrganization = req.get('x-organization-id')
      if (requestedOrganization && (isPlatformSession || requestedOrganization !== claims.org)) {
        throw new HttpError(403, 'ORGANIZATION_ACCESS_DENIED', 'The selected organization does not match this session.')
      }

      const organization = isPlatformSession
        ? null
        : await Organization.findOne({ _id: claims.org, status: 'ACTIVE' })
      if (!isPlatformSession && !organization) {
        throw new HttpError(403, 'ORGANIZATION_ACCESS_DENIED', 'This organization is unavailable.')
      }

      req.auth = { user, membership, organization }
      next()
    } catch (error) {
      next(error)
    }
  }
}

module.exports = { createAuthenticate }
