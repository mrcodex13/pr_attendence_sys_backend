const nodemailer = require('nodemailer')

function createMailer(config) {
  if (!config.mailEnabled) {
    const emailNotConfigured = () => {
      const error = new Error('Email is not set up. Ask your administrator for help.')
      error.code = 'EMAIL_NOT_CONFIGURED'
      error.status = 503
      return error
    }

    return {
      async sendPasswordReset() {
        throw emailNotConfigured()
      },
      async sendReport() {
        throw emailNotConfigured()
      },
    }
  }

  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: { user: config.smtpUser, pass: config.smtpPassword },
  })

  return {
    sendPasswordReset(email, token) {
      const resetUrl = new URL('/reset-password', config.appUrl)
      resetUrl.searchParams.set('token', token)
      return transport.sendMail({
        from: config.mailFrom,
        to: email,
        subject: 'Reset your attendance account password',
        text: `Use this one-time link to reset your password. It expires in one hour:\n\n${resetUrl.toString()}`,
      })
    },
    sendReport({ recipients, name, format, buffer }) {
      const extension = format.toLowerCase()
      return transport.sendMail({
        from: config.mailFrom,
        to: recipients.join(', '),
        subject: `Scheduled attendance report: ${name}`,
        text: `Your scheduled attendance report is attached as ${extension.toUpperCase()}.`,
        attachments: [{
          filename: `attendance-report.${extension}`,
          content: buffer,
          contentType: format === 'XLSX'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'text/csv; charset=utf-8',
        }],
      })
    },
  }
}

module.exports = { createMailer }
