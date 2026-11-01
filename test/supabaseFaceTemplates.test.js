const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createSupabaseFaceTemplateStore } = require('../src/services/supabaseFaceTemplates')

function createFakeFetch({ rows = [], status = 200 } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options })
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return rows
      },
    }
  }
  return { fetchImpl, calls }
}

const config = {
  supabaseUrl: 'https://project.supabase.co',
  supabaseSecretKey: 'server-only-secret',
}

test('Supabase face-template store scopes list and delete operations by organization', async () => {
  const { fetchImpl, calls } = createFakeFetch({
    rows: [{ person_id: 'person-1' }],
  })
  const store = createSupabaseFaceTemplateStore({
    config,
    fetchImpl,
  })

  assert.deepEqual(await store.listPersonIds('org-1', ['person-1']), ['person-1'])
  await store.deleteForPerson('org-1', 'person-1')

  assert.equal(calls[0].url.searchParams.get('organization_id'), 'eq.org-1')
  assert.equal(calls[0].url.searchParams.get('person_id'), 'in.(person-1)')
  assert.equal(calls[1].options.method, 'DELETE')
  assert.equal(calls[1].url.searchParams.get('organization_id'), 'eq.org-1')
  assert.equal(calls[1].url.searchParams.get('person_id'), 'eq.person-1')
  assert.equal(calls[1].options.headers.apikey, config.supabaseSecretKey)
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${config.supabaseSecretKey}`)
  assert.deepEqual(await store.listPersonIds('org-1', []), [])
})

test('Supabase face-template store upserts encrypted fields and returns enrollment metadata', async () => {
  const { fetchImpl, calls } = createFakeFetch({
    rows: [{ person_id: 'person-1', enrolled_at: '2026-10-31T12:00:00.000Z' }],
  })
  const store = createSupabaseFaceTemplateStore({
    config,
    fetchImpl,
  })

  const result = await store.upsert({
    organizationId: 'org-1',
    personId: 'person-1',
    ciphertext: 'encrypted-value',
    iv: 'iv-value',
    tag: 'tag-value',
    modelVersion: 'face-api-128-v1',
    enrolledByUserId: 'user-1',
    enrolledAt: new Date('2026-10-31T12:00:00.000Z'),
  })

  assert.deepEqual(result, {
    personId: 'person-1',
    enrolledAt: '2026-10-31T12:00:00.000Z',
  })
  assert.equal(calls[0].url.searchParams.get('on_conflict'), 'organization_id,person_id')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers.Prefer, 'resolution=merge-duplicates,return=representation')
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    organization_id: 'org-1',
    person_id: 'person-1',
    ciphertext: 'encrypted-value',
    iv: 'iv-value',
    tag: 'tag-value',
    model_version: 'face-api-128-v1',
    enrolled_by_user_id: 'user-1',
    enrolled_at: '2026-10-31T12:00:00.000Z',
  })
})

test('Supabase storage failures are explicit and missing configuration disables storage', async () => {
  const { fetchImpl } = createFakeFetch({ status: 503 })
  const store = createSupabaseFaceTemplateStore({
    config,
    fetchImpl,
  })
  await assert.rejects(store.listPersonIds('org-1', ['person-1']), {
    status: 503,
    code: 'FACE_TEMPLATE_STORAGE_UNAVAILABLE',
  })

  const unconfigured = createSupabaseFaceTemplateStore({ config: {} })
  await assert.rejects(unconfigured.listPersonIds('org-1', ['person-1']), {
    status: 503,
    code: 'FACE_TEMPLATE_STORAGE_DISABLED',
  })
})
