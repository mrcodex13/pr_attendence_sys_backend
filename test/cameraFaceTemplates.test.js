const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  decryptDescriptors,
  encryptDescriptors,
  findBestMatch,
  validateDescriptor,
  validateDescriptors,
} = require('../src/services/cameraFaceTemplates')

const config = { faceTemplateEncryptionKey: 'face-template-test-key-with-32-characters' }
const descriptor = Array.from({ length: 128 }, (_, index) => index / 1000)
const context = { organizationId: 'org-123', personId: 'person-456', config }

test('face descriptors are validated and encrypted at rest', () => {
  assert.equal(validateDescriptor(descriptor), true)
  assert.equal(validateDescriptors([descriptor, descriptor]), true)
  assert.equal(validateDescriptor([0.1, 0.2]), false)
  assert.equal(validateDescriptors([descriptor, [Number.NaN]]), false)

  const encrypted = encryptDescriptors([descriptor], context)
  assert.equal(encrypted.ciphertext.includes(JSON.stringify([descriptor])), false)
  assert.deepEqual(decryptDescriptors(encrypted, context), [descriptor])
  assert.throws(() => decryptDescriptors(encrypted, {
    ...context,
    personId: 'person-other',
  }))
  assert.throws(() => decryptDescriptors(encrypted, {
    ...context,
    organizationId: 'org-other',
  }))
})

test('face template encryption rejects missing or changed keys', () => {
  assert.throws(() => encryptDescriptors([descriptor], {
    ...context,
    config: {},
  }), /not configured/)
  const encrypted = encryptDescriptors([descriptor], context)
  assert.throws(() => decryptDescriptors(encrypted, {
    ...context,
    config: { faceTemplateEncryptionKey: 'different-face-template-key-32-characters' },
  }))
})

test('face matching rejects distant or ambiguous candidates', () => {
  const match = findBestMatch(descriptor, [{
    personId: 'person-1',
    descriptors: [descriptor],
  }])
  assert.deepEqual(match, {
    matched: true,
    personId: 'person-1',
    confidence: 1,
  })

  const nearby = descriptor.map((value) => value + 0.001)
  const ambiguous = findBestMatch(descriptor, [
    { personId: 'person-1', descriptors: [descriptor] },
    { personId: 'person-2', descriptors: [nearby] },
  ])
  assert.deepEqual(ambiguous, { matched: false, reason: 'AMBIGUOUS' })

  const distant = findBestMatch(descriptor, [{
    personId: 'person-3',
    descriptors: [descriptor.map((value) => value + 0.2)],
  }])
  assert.deepEqual(distant, { matched: false, reason: 'NO_MATCH' })
})
