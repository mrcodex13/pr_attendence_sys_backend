const { HttpError } = require('../lib/httpError')
const CameraFaceTemplate = require('../models/CameraFaceTemplate')

const TABLE_NAME = 'camera_face_templates'

const mongoFaceTemplateStore = {
  async listPersonIds(organizationId, personIds) {
    if (personIds.length === 0) return []
    const templates = await CameraFaceTemplate.find({
      organizationId,
      personId: { $in: personIds },
    }).select('personId')
    return templates.map((t) => t.personId.toString())
  },

  async upsert(template) {
    const updated = await CameraFaceTemplate.findOneAndUpdate(
      { organizationId: template.organizationId, personId: template.personId },
      {
        organizationId: template.organizationId,
        personId: template.personId,
        ciphertext: template.ciphertext,
        iv: template.iv,
        tag: template.tag,
        modelVersion: template.modelVersion,
        enrolledByUserId: template.enrolledByUserId,
        enrolledAt: template.enrolledAt,
      },
      { upsert: true, returnDocument: 'after' },
    )
    return {
      personId: updated.personId.toString(),
      enrolledAt: updated.enrolledAt.toISOString(),
    }
  },

  async deleteForPerson(organizationId, personId) {
    await CameraFaceTemplate.deleteOne({ organizationId, personId })
  },

  async listForPeople(organizationId, personIds) {
    if (personIds.length === 0) return []
    const templates = await CameraFaceTemplate.find({
      organizationId,
      personId: { $in: personIds },
    }).select('+ciphertext +iv +tag')
    return templates.map((t) => ({
      organizationId: t.organizationId.toString(),
      personId: t.personId.toString(),
      ciphertext: t.ciphertext,
      iv: t.iv,
      tag: t.tag,
      modelVersion: t.modelVersion,
      enrolledByUserId: t.enrolledByUserId.toString(),
      enrolledAt: t.enrolledAt.toISOString(),
    }))
  },
}

function createSupabaseFaceTemplateStore({
  config,
  fetchImpl = globalThis.fetch,
}) {
  let supabaseDisabled = !config?.supabaseUrl || !config?.supabaseSecretKey

  async function request(filters, { method = 'GET', body, prefer } = {}) {
    if (supabaseDisabled) return null

    const url = new URL(`/rest/v1/${TABLE_NAME}`, config.supabaseUrl)
    for (const [key, value] of Object.entries(filters)) {
      url.searchParams.set(key, value)
    }

    const headers = {
      apikey: config.supabaseSecretKey,
      Authorization: `Bearer ${config.supabaseSecretKey}`,
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (prefer) headers.Prefer = prefer

    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      supabaseDisabled = true
      return null
    }

    if (response.status === 404 || response.status === 503) {
      // Supabase table not created or service unavailable, switch to MongoDB fallback
      supabaseDisabled = true
      return null
    }

    if (!response.ok) {
      supabaseDisabled = true
      return null
    }

    if (response.status === 204) return null
    try {
      return await response.json()
    } catch {
      supabaseDisabled = true
      return null
    }
  }

  return {
    async listPersonIds(organizationId, personIds) {
      if (personIds.length === 0) return []
      if (!supabaseDisabled) {
        const rows = await request({
          select: 'person_id',
          organization_id: `eq.${organizationId.toString()}`,
          person_id: `in.(${personIds.map((id) => id.toString()).join(',')})`,
        })
        if (rows) return rows.map((row) => row.person_id)
      }
      return mongoFaceTemplateStore.listPersonIds(organizationId, personIds)
    },

    async upsert(template) {
      if (!supabaseDisabled) {
        const row = {
          organization_id: template.organizationId.toString(),
          person_id: template.personId.toString(),
          ciphertext: template.ciphertext,
          iv: template.iv,
          tag: template.tag,
          model_version: template.modelVersion,
          enrolled_by_user_id: template.enrolledByUserId.toString(),
          enrolled_at: template.enrolledAt.toISOString(),
        }
        const results = await request({
          on_conflict: 'organization_id,person_id',
          select: 'person_id,enrolled_at',
        }, {
          method: 'POST',
          body: row,
          prefer: 'resolution=merge-duplicates,return=representation',
        })
        if (results && results[0]) {
          // Also mirror to MongoDB for safety
          await mongoFaceTemplateStore.upsert(template).catch(() => {})
          return {
            personId: results[0].person_id,
            enrolledAt: results[0].enrolled_at,
          }
        }
      }
      return mongoFaceTemplateStore.upsert(template)
    },

    async deleteForPerson(organizationId, personId) {
      if (!supabaseDisabled) {
        await request({
          organization_id: `eq.${organizationId.toString()}`,
          person_id: `eq.${personId.toString()}`,
        }, {
          method: 'DELETE',
          prefer: 'return=minimal',
        }).catch(() => {})
      }
      return mongoFaceTemplateStore.deleteForPerson(organizationId, personId)
    },

    async listForPeople(organizationId, personIds) {
      if (personIds.length === 0) return []
      if (!supabaseDisabled) {
        const rows = await request({
          select: 'organization_id,person_id,ciphertext,iv,tag,model_version,enrolled_by_user_id,enrolled_at',
          organization_id: `eq.${organizationId.toString()}`,
          person_id: `in.(${personIds.map((id) => id.toString()).join(',')})`,
        })
        if (rows) {
          return rows.map((row) => ({
            organizationId: row.organization_id,
            personId: row.person_id,
            ciphertext: row.ciphertext,
            iv: row.iv,
            tag: row.tag,
            modelVersion: row.model_version,
            enrolledByUserId: row.enrolled_by_user_id,
            enrolledAt: row.enrolled_at,
          }))
        }
      }
      return mongoFaceTemplateStore.listForPeople(organizationId, personIds)
    },
  }
}

module.exports = { createSupabaseFaceTemplateStore, mongoFaceTemplateStore }
