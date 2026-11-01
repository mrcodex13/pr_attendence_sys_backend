const bcrypt = require('bcryptjs')

const PASSWORD_COST = 12
const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{12,128}$/

function validatePassword(password) {
  return typeof password === 'string' && PASSWORD_PATTERN.test(password)
}

function hashPassword(password) {
  return bcrypt.hash(password, PASSWORD_COST)
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash)
}

module.exports = { hashPassword, validatePassword, verifyPassword }
