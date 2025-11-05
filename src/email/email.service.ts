// src/email/email.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import SendGrid from '@sendgrid/mail';

@Injectable()
export class EmailService {
  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('SENDGRID_API_KEY');
    if (!apiKey) {
      throw new Error('SENDGRID_API_KEY is not defined in configuration');
    }
    SendGrid.setApiKey(apiKey);
  }

  async sendConfirmationEmail(
    to: string,
    subject: string,
    body: string,
    attachments?: any[],
    htmlBody?: string,
  ) {
    const msg: any = {
      to,
      from:
        this.configService.get<string>('SENDGRID_FROM_EMAIL') ||
        'no-reply@fest-go.com',
      subject,
      text: body,
      attachments,
    };
    if (htmlBody) {
      msg.html = htmlBody;
    }
    try {
      await SendGrid.send(msg);
      return { success: true, message: 'Email sent successfully' };
    } catch (error) {
      throw new Error(`Failed to send email: ${error.message}`);
    }
  }

  async sendPaymentLink(
    to: string,
    subject: string,
    link: string,
    body: string,
  ) {
    const msg = {
      to,
      from:
        this.configService.get<string>('SENDGRID_FROM_EMAIL') ||
        'no-reply@fest-go.com',
      subject,
      text: body,
      html: `<p>${body}</p><a href="${link}">Pagar Ahora</a>`,
    };
    try {
      await SendGrid.send(msg);
      return { success: true, message: 'Email sent successfully' };
    } catch (error) {
      throw new Error(`Failed to send email: ${error.message}`);
    }
  }
}
