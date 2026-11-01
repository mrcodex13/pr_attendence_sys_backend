const ExcelJS = require('exceljs')
const AttendanceRecord = require('../models/AttendanceRecord')
const Person = require('../models/Person')

const COLUMNS = ['date', 'personId', 'status', 'source', 'firstIn', 'lastOut', 'minutesWorked']

async function getAttendanceRows({ organizationId, from, to, groupId, limit = 50000 }) {
  const filter = { organizationId }
  if (from || to) filter.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) }
  if (groupId) {
    const personIds = await Person.find({ organizationId, groupId }).distinct('_id')
    filter.personId = { $in: personIds }
  }
  return AttendanceRecord.find(filter).sort({ date: -1 }).limit(limit).lean()
}

function attendanceValues(records) {
  return records.map((record) => [
    record.date,
    record.personId.toString(),
    record.status,
    record.source,
    record.firstIn?.toISOString() || '',
    record.lastOut?.toISOString() || '',
    record.minutesWorked,
  ])
}

function escapeCsvCell(value) {
  const text = String(value ?? '')
  const safe = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}

async function createAttendanceExport(records, format) {
  const rows = attendanceValues(records)
  if (format === 'CSV') {
    return Buffer.from(`\uFEFF${[COLUMNS, ...rows].map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')}`, 'utf8')
  }
  if (format !== 'XLSX') throw new Error('Unsupported attendance export format.')
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('Attendance')
  worksheet.addRow(COLUMNS)
  for (const row of rows) worksheet.addRow(row)
  worksheet.getRow(1).font = { bold: true }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

module.exports = { getAttendanceRows, createAttendanceExport, COLUMNS }
