const ALL = new Set([
  'dashboard.view',
  'live.view',
  'people.view',
  'people.manage',
  'groups.manage',
  'courses.manage',
  'schedules.manage',
  'holidays.manage',
  'attendance.view',
  'attendance.correct',
  'exceptions.resolve',
  'leave.review',
  'devices.manage',
  'reports.export',
  'reports.schedule',
  'users.manage',
  'my-attendance.view',
  'settings.manage',
  'audit.view',
  'privacy.manage',
])

const TEACHER = new Set([
  'dashboard.view',
  'live.view',
  'people.view',
  'attendance.view',
  'attendance.correct',
  'exceptions.resolve',
  'leave.review',
  'reports.export',
  'students.invite',
])

const SELF_SERVICE = new Set(['my-attendance.view'])

const ROLE_PERMISSIONS = {
  SUPER_ADMIN: new Set(['platform.manage']),
  ADMIN: ALL,
  TEACHER,
  MANAGER: new Set([...TEACHER].filter((permission) => permission !== 'students.invite')),
  EMPLOYEE: SELF_SERVICE,
  STUDENT: SELF_SERVICE,
}

function hasPermission(role, permission) {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false
}

module.exports = { hasPermission, ROLE_PERMISSIONS }
