const { createHash, randomBytes } = require('node:crypto')

const INVITATION_TTL_MS = 24 * 60 * 60 * 1000

function createInvitationCode() {
  return randomBytes(24).toString('base64url')
}

function hashInvitationCode(code) {
  return createHash('sha256').update(code).digest('hex')
}

module.exports = { createInvitationCode, hashInvitationCode, INVITATION_TTL_MS }
