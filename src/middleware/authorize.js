const { hasPermission } = require('../lib/permissions')
const { HttpError } = require('../lib/httpError')

function requirePermission(permission) {
  return function authorize(req, _res, next) {
    if (!req.auth || !hasPermission(req.auth.membership.role, permission)) {
      return next(new HttpError(403, 'FORBIDDEN', 'You do not have permission to perform this action.'))
    }
    next()
  }
}

function requireAnyPermission(...permissions) {
  return function authorize(req, _res, next) {
    if (!req.auth || !permissions.some((permission) => hasPermission(req.auth.membership.role, permission))) {
      return next(new HttpError(403, 'FORBIDDEN', 'You do not have permission to perform this action.'))
    }
    next()
  }
}

module.exports = { requirePermission, requireAnyPermission }
