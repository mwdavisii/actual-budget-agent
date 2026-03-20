import nodemailer from 'nodemailer';
import { logger } from '../logger';

export function createEmailClient(config: {
  host: string; port: number;
}) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: false,
    tls: { rejectUnauthorized: false },
  });
}

export async function sendEmail(
  transporter: nodemailer.Transporter,
  from: string,
  to: string,
  subject: string,
  body: string
): Promise<void> {
  await transporter.sendMail({ from, to, subject, text: body });
  logger.info('Email sent', { to, subject });
}
