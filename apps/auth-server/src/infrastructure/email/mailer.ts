import type { AppConfig } from '../../config/env.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Dependency-free mail adapter. A real deployment points EMAIL_DELIVERY_URL at
 * an HTTP mail relay (Resend, Postmark, a small internal worker). Local
 * development prints the message, so password reset is testable without SMTP.
 */
export async function sendEmail(config: AppConfig, message: EmailMessage): Promise<void> {
  if (!config.emailDeliveryUrl) {
    console.log(
      `[email:dev] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`,
    );
    return;
  }

  const response = await fetch(config.emailDeliveryUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: config.emailFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
    }),
  });
  if (!response.ok) {
    throw new Error(`email delivery failed with HTTP ${response.status}`);
  }
}
