require('dotenv').config()
const mongoose = require('mongoose')
const Organization = require('../src/models/Organization')
const User = require('../src/models/User')
const { hashPassword, validatePassword } = require('../src/lib/passwords')

async function seedAdmin() {
  const { MONGODB_URI, SEED_ORG_NAME, SEED_ORG_SLUG, SEED_ADMIN_NAME, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD } = process.env
  if (!MONGODB_URI || !SEED_ORG_NAME || !SEED_ORG_SLUG || !SEED_ADMIN_NAME ||
    !SEED_ADMIN_EMAIL || !validatePassword(SEED_ADMIN_PASSWORD)) {
    throw new Error('Set MONGODB_URI, SEED_ORG_NAME, SEED_ORG_SLUG, SEED_ADMIN_NAME, SEED_ADMIN_EMAIL, and a strong SEED_ADMIN_PASSWORD.')
  }

  await mongoose.connect(MONGODB_URI)
  const slug = SEED_ORG_SLUG.trim().toLowerCase()
  const email = SEED_ADMIN_EMAIL.trim().toLowerCase()
  let organization = await Organization.findOne({ slug })
  if (!organization) {
    organization = await Organization.create({ name: SEED_ORG_NAME.trim(), slug, status: 'ACTIVE' })
  }

  let user = await User.findOne({ email })
  if (user) {
    const hasMembership = user.memberships.some((membership) =>
      membership.organizationId.toString() === organization._id.toString())
    if (hasMembership) {
      console.info('Seed admin already exists; no changes made.')
      return
    }
    throw new Error('SEED_ADMIN_EMAIL already belongs to another account; refusing to modify it.')
  }

  user = await User.create({
    name: SEED_ADMIN_NAME.trim(),
    email,
    passwordHash: await hashPassword(SEED_ADMIN_PASSWORD),
    status: 'ACTIVE',
    memberships: [{
      organizationId: organization._id,
      role: 'SUPER_ADMIN',
      groupIds: [],
      status: 'ACTIVE',
    }],
  })
  console.info(`Created initial super admin ${user.email} for organization ${organization.slug}.`)
}

seedAdmin()
  .catch((error) => {
    console.error(`Admin seed failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await mongoose.disconnect()
  })
