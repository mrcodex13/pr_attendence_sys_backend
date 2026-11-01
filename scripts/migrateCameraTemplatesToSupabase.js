const mongoose = require('mongoose')
const { config } = require('../src/config')
const CameraFaceTemplate = require('../src/models/CameraFaceTemplate')
const { decryptDescriptors } = require('../src/services/cameraFaceTemplates')
const { createSupabaseFaceTemplateStore } = require('../src/services/supabaseFaceTemplates')

async function main() {
  if (!config.mongoUri) {
    throw new Error('MONGODB_URI is required to migrate existing camera templates.')
  }
  if (!config.faceTemplateEncryptionKey) {
    throw new Error('FACE_TEMPLATE_ENCRYPTION_KEY is required to verify existing camera templates.')
  }

  await mongoose.connect(config.mongoUri)
  try {
    const legacyTemplates = await CameraFaceTemplate.find({})
      .select('+ciphertext +iv +tag')
      .lean()
    if (legacyTemplates.length === 0) {
      console.log('No MongoDB camera templates need migration.')
      return
    }

    const store = createSupabaseFaceTemplateStore({ config })
    for (const template of legacyTemplates) {
      decryptDescriptors(template, {
        organizationId: template.organizationId,
        personId: template.personId,
        config,
      })
      await store.upsert({
        organizationId: template.organizationId,
        personId: template.personId,
        ciphertext: template.ciphertext,
        iv: template.iv,
        tag: template.tag,
        modelVersion: template.modelVersion,
        enrolledByUserId: template.enrolledByUserId,
        enrolledAt: template.enrolledAt,
      })
    }

    const templatesByOrganization = new Map()
    for (const template of legacyTemplates) {
      const organizationId = template.organizationId.toString()
      const organizationTemplates = templatesByOrganization.get(organizationId) || []
      organizationTemplates.push(template)
      templatesByOrganization.set(organizationId, organizationTemplates)
    }

    for (const [organizationId, organizationTemplates] of templatesByOrganization) {
      for (let offset = 0; offset < organizationTemplates.length; offset += 100) {
        const batch = organizationTemplates.slice(offset, offset + 100)
        const migrated = await store.listForPeople(
          organizationId,
          batch.map((template) => template.personId),
        )
        const migratedByPerson = new Map(migrated.map((template) => [template.personId, template]))
        for (const source of batch) {
          const destination = migratedByPerson.get(source.personId.toString())
          if (!destination ||
            destination.organizationId !== organizationId ||
            destination.ciphertext !== source.ciphertext ||
            destination.iv !== source.iv ||
            destination.tag !== source.tag ||
            destination.modelVersion !== source.modelVersion) {
            throw new Error('Supabase verification failed; MongoDB templates were retained.')
          }
        }
      }
    }

    await CameraFaceTemplate.deleteMany({ _id: { $in: legacyTemplates.map((template) => template._id) } })
    console.log(`Migrated and verified ${legacyTemplates.length} encrypted camera template(s).`)
  } finally {
    await mongoose.disconnect()
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
