const AuditEvent = require('../models/AuditEvent')
const ReportDelivery = require('../models/ReportDelivery')
const ReportSchedule = require('../models/ReportSchedule')
const { createAttendanceExport, getAttendanceRows } = require('./reportExports')
const { nextReportRun } = require('../routes/workflows')

function dateShift(date, offset) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + offset)
  return value.toISOString().slice(0, 10)
}

async function deliverOne({ mailer, logger, now = new Date() }) {
  const locked = await ReportSchedule.findOneAndUpdate(
    {
      status: 'ACTIVE',
      nextRunAt: { $lte: now },
      $or: [{ lockedAt: null }, { lockedAt: { $lt: new Date(now.getTime() - 5 * 60 * 1000) } }],
    },
    { $set: { lockedAt: now } },
    { returnDocument: 'after', sort: { nextRunAt: 1 } },
  )
  if (!locked) return false

  const attempted = await ReportDelivery.create({
    organizationId: locked.organizationId,
    scheduleId: locked._id,
    status: 'SENDING',
    recipients: locked.recipients,
    attemptedAt: now,
  })
  const periodEnd = dateShift(now.toISOString().slice(0, 10), -1)
  const periodDays = locked.frequency === 'DAILY' ? 1 : locked.frequency === 'WEEKLY' ? 7 : 30
  const periodStart = dateShift(periodEnd, -(periodDays - 1))
  let status = 'SENT'
  let deliveryError = ''
  try {
    const rows = await getAttendanceRows({
      organizationId: locked.organizationId,
      from: periodStart,
      to: periodEnd,
      groupId: locked.groupId,
    })
    const buffer = await createAttendanceExport(rows, locked.format)
    await mailer.sendReport({
      recipients: locked.recipients,
      name: locked.name,
      format: locked.format,
      buffer,
    })
  } catch (error) {
    status = 'FAILED'
    deliveryError = error instanceof Error ? error.message.slice(0, 300) : 'Report delivery failed.'
    logger.error(JSON.stringify({
      level: 'error',
      event: 'scheduled_report_failed',
      scheduleId: locked._id.toString(),
      deliveryId: attempted._id.toString(),
      message: deliveryError,
    }))
  }

  attempted.status = status
  attempted.error = deliveryError
  attempted.completedAt = new Date()
  await attempted.save()
  locked.lastRunAt = now
  locked.nextRunAt = nextReportRun(locked, now)
  locked.lockedAt = null
  await locked.save()
  await AuditEvent.create({
    organizationId: locked.organizationId,
    actorUserId: locked.createdBy,
    action: status === 'SENT' ? 'report_schedule.delivered' : 'report_schedule.delivery_failed',
    entityType: 'ReportDelivery',
    entityId: attempted._id.toString(),
    detail: `${locked.format} report delivery ${status.toLowerCase()}.`,
  })
  return true
}

function startReportScheduler({ mailer, logger = console, intervalMs = 60_000 }) {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      while (await deliverOne({ mailer, logger })) {
        // Drain currently due schedules before waiting for the next tick.
      }
    } catch (error) {
      logger.error(JSON.stringify({
        level: 'error',
        event: 'report_scheduler_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      }))
    } finally {
      running = false
    }
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

module.exports = { startReportScheduler, deliverOne }
