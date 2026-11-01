require('dotenv').config()
const fs = require('node:fs')
const path = require('node:path')
const mongoose = require('mongoose')
const Group = require('../src/models/Group')
const Organization = require('../src/models/Organization')
const Person = require('../src/models/Person')
const RefreshSession = require('../src/models/RefreshSession')
const User = require('../src/models/User')
const { hashPassword, validatePassword, verifyPassword } = require('../src/lib/passwords')

function rowCells(line) {
  return line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/g, ''))
}

function readDemoRoster(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  const organizationName = lines.find((line) => /^\s*-\s*Organization:/.test(line))
    ?.replace(/^\s*-\s*Organization:\s*/, '').trim()
  const organizationId = lines.find((line) => /^\s*-\s*Organization ID:/.test(line))
    ?.match(/[a-f\d]{24}/i)?.[0]
  const groupName = lines.find((line) => /^\s*-\s*Employee group:/.test(line))
    ?.replace(/^\s*-\s*Employee group:\s*/, '').trim()
  const groupId = lines.find((line) => /^\s*-\s*Group ID:/.test(line))
    ?.match(/[a-f\d]{24}/i)?.[0]

  const tables = new Map()
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue
    const cells = rowCells(line.trim())
    if (cells.some((cell) => /^-+$/.test(cell))) continue
    if (cells.every((cell) => /^[\w -]+$/.test(cell))) {
      const header = cells.map((cell) => cell.toLowerCase())
      if (header.join('|') === 'role|email|password' ||
        header.join('|') === 'employee id|person code|email|password') {
        tables.set(header.join('|'), [])
        continue
      }
    }

    const email = cells.find((cell) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cell))
    if (!email) continue
    const roleTable = tables.get('role|email|password')
    const employeeTable = tables.get('employee id|person code|email|password')
    if (roleTable && cells.length === 3 && !roleTable.length) {
      roleTable.push({ role: cells[0], email, password: cells[2] })
    } else if (employeeTable && cells.length === 4) {
      employeeTable.push({
        employeeId: cells[0],
        personCode: cells[1],
        email,
        password: cells[3],
      })
    }
  }

  const admins = tables.get('role|email|password') || []
  const employees = tables.get('employee id|person code|email|password') || []
  if (!organizationName || !organizationId || !groupName || !groupId ||
    !/^[a-f\d]{24}$/i.test(organizationId) || !/^[a-f\d]{24}$/i.test(groupId) ||
    admins.length !== 1 || !/organization admin/i.test(admins[0].role) || employees.length === 0) {
    throw new Error('The demo credential file is missing required organization, group, or account rows.')
  }

  const accounts = [
    { name: nameFromEmail(admins[0].email), email: admins[0].email, password: admins[0].password, role: 'ADMIN' },
    ...employees.map((employee) => ({
      name: nameFromEmail(employee.email),
      email: employee.email,
      password: employee.password,
      role: 'EMPLOYEE',
      employeeId: employee.employeeId,
      personCode: employee.personCode,
    })),
  ]
  const emails = new Set()
  const personCodes = new Set()
  for (const account of accounts) {
    const email = account.email.toLowerCase()
    if (emails.has(email)) throw new Error('The demo credential file contains duplicate email addresses.')
    emails.add(email)
    if (!validatePassword(account.password)) {
      throw new Error(`The demo password for roster entry on row ${accounts.indexOf(account) + 1} does not meet password policy.`)
    }
    if (account.role === 'EMPLOYEE') {
      const personCode = account.personCode.toUpperCase()
      if (personCodes.has(personCode)) throw new Error('The demo credential file contains duplicate person codes.')
      personCodes.add(personCode)
    }
  }

  return {
    organization: { name: organizationName, id: organizationId },
    group: { name: groupName, id: groupId },
    accounts,
  }
}

function nameFromEmail(email) {
  return email.split('@')[0]
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .slice(0, 120)
}

function slugFromName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70)
}

async function organizationSlug(name) {
  const baseSlug = slugFromName(name) || 'demo-organization'
  let slug = baseSlug
  let suffix = 1
  while (await Organization.exists({ slug })) {
    slug = `${baseSlug.slice(0, 70 - String(suffix).length - 1)}-${suffix}`
    suffix += 1
  }
  return slug
}

async function ensureOrganization(organization) {
  let record = await Organization.findById(organization.id)
  if (record) {
    if (record.name !== organization.name) {
      throw new Error('The documented organization ID already belongs to a different organization.')
    }
    if (record.status !== 'ACTIVE') {
      throw new Error('The documented organization is inactive; refusing to reactivate it automatically.')
    }
    return record
  }
  if (await Organization.exists({ name: organization.name })) {
    throw new Error('An organization with the documented name already exists under a different ID.')
  }
  record = await Organization.create({
    _id: organization.id,
    name: organization.name,
    slug: await organizationSlug(organization.name),
    status: 'ACTIVE',
    settings: { mode: 'COMPANY' },
  })
  return record
}

async function ensureGroup(group, organizationId) {
  let record = await Group.findById(group.id)
  if (record) {
    if (record.organizationId.toString() !== organizationId.toString() || record.name !== group.name) {
      throw new Error('The documented group ID already belongs to a different group.')
    }
    if (record.status !== 'ACTIVE') {
      throw new Error('The documented group is inactive; refusing to reactivate it automatically.')
    }
    return record
  }
  if (await Group.exists({ organizationId, name: group.name })) {
    throw new Error('The documented group name already exists under a different ID.')
  }
  return Group.create({
    _id: group.id,
    organizationId,
    name: group.name,
    kind: 'DEPARTMENT',
    status: 'ACTIVE',
  })
}

async function ensureSuperAdminMembership(organizationId, groupId) {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.SEED_ADMIN_PASSWORD
  if (!email || !password) {
    throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required to grant the seeded super admin access.')
  }
  const user = await User.findOne({ email }).select('+passwordHash')
  if (!user || user.status !== 'ACTIVE' || !(await verifyPassword(password, user.passwordHash)) ||
    !user.memberships.some((membership) => membership.role === 'SUPER_ADMIN' && membership.status === 'ACTIVE')) {
    throw new Error('The configured seeded super admin could not be verified; no demo users were seeded.')
  }
  let membership = user.memberships.find((item) => item.organizationId.toString() === organizationId.toString())
  if (membership && membership.role !== 'SUPER_ADMIN') {
    throw new Error('The seeded super admin already has a different role in the demo organization.')
  }
  if (!membership) {
    user.memberships.push({
      organizationId,
      role: 'SUPER_ADMIN',
      groupIds: [groupId.toString()],
      status: 'ACTIVE',
    })
    await user.save()
  }
}

async function upsertAccount(account, organizationId, groupId) {
  let person
  if (account.role === 'EMPLOYEE') {
    person = await Person.findOne({ organizationId, email: account.email })
    const personByCode = await Person.findOne({
      organizationId,
      personCode: account.personCode,
    })
    if (personByCode && person && personByCode._id.toString() !== person._id.toString()) {
      throw new Error('A demo person code and email refer to different people.')
    }
    if (personByCode && !person) {
      throw new Error('A demo person code is already assigned to a different email.')
    }
    if (person && (person.type !== 'EMPLOYEE' || person.groupId.toString() !== groupId.toString())) {
      throw new Error('A demo employee email is already assigned to a different person or group.')
    }
    if (person && person.personCode.toUpperCase() !== account.personCode.toUpperCase()) {
      throw new Error('A demo employee email already has a different person code.')
    }
    if (!person) {
      person = await Person.create({
        organizationId,
        personCode: account.personCode,
        type: 'EMPLOYEE',
        name: account.name,
        email: account.email,
        employeeId: account.employeeId,
        status: 'ACTIVE',
        groupId,
        consentGiven: false,
      })
    } else {
      let changed = false
      if (person.name !== account.name) {
        person.name = account.name
        changed = true
      }
      if (person.employeeId !== account.employeeId) {
        person.employeeId = account.employeeId
        changed = true
      }
      if (changed) await person.save()
    }
  }

  let user = await User.findOne({ email: account.email }).select('+passwordHash')
  if (user && user.status !== 'ACTIVE') {
    throw new Error(`A roster account is disabled; refusing to reactivate it.`)
  }
  const membership = user?.memberships.find((item) => item.organizationId.toString() === organizationId.toString())
  if (membership && membership.role !== account.role) {
    throw new Error('A roster account already has a different role in the demo organization.')
  }

  if (!user) {
    user = await User.create({
      name: account.name,
      email: account.email,
      passwordHash: await hashPassword(account.password),
      status: 'ACTIVE',
      memberships: [{
        organizationId,
        role: account.role,
        groupIds: [groupId.toString()],
        ...(person ? { personId: person._id } : {}),
        status: 'ACTIVE',
      }],
    })
    return 'created'
  }

  let changed = false
  const passwordMatches = await verifyPassword(account.password, user.passwordHash)
  if (!passwordMatches) {
    user.passwordHash = await hashPassword(account.password)
    user.passwordResetHash = undefined
    user.passwordResetExpiresAt = undefined
    await RefreshSession.updateMany(
      { userId: user._id, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    )
    changed = true
  }
  if (user.name !== account.name) {
    user.name = account.name
    changed = true
  }
  if (membership) {
    const groupIds = [groupId.toString()]
    if (membership.status !== 'ACTIVE' ||
      JSON.stringify([...membership.groupIds].sort()) !== JSON.stringify([...groupIds].sort()) ||
      (person && membership.personId?.toString() !== person._id.toString())) {
      membership.groupIds = groupIds
      membership.status = 'ACTIVE'
      if (person) membership.personId = person._id
      changed = true
    }
  } else {
    user.memberships.push({
      organizationId,
      role: account.role,
      groupIds: [groupId.toString()],
      ...(person ? { personId: person._id } : {}),
      status: 'ACTIVE',
    })
    changed = true
  }
  if (!changed) return 'unchanged'
  await user.save()
  return 'updated'
}

async function main() {
  const rosterPath = path.resolve(__dirname, '..', '..', 'id_pas.md')
  if (!fs.existsSync(rosterPath)) {
    throw new Error('id_pas.md was not found at the workspace root.')
  }
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.')

  const roster = readDemoRoster(rosterPath)
  await mongoose.connect(process.env.MONGODB_URI)
  try {
    const organization = await ensureOrganization(roster.organization)
    const group = await ensureGroup(roster.group, organization._id)
    await ensureSuperAdminMembership(organization._id, group._id)

    const result = { created: 0, updated: 0, unchanged: 0 }
    for (const account of roster.accounts) {
      result[await upsertAccount(account, organization._id, group._id)] += 1
    }
    console.info(`Demo account seed completed: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged.`)
  } finally {
    await mongoose.disconnect()
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Demo account seed failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    process.exitCode = 1
  })
}

module.exports = { main, readDemoRoster }
