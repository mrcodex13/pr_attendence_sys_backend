const { parse } = require('csv-parse/sync')

function parseCsv(input) {
  try {
    return parse(input, {
      bom: true,
      columns: false,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      max_record_size: 16384,
    })
  } catch {
    return null
  }
}

module.exports = { parseCsv }
