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
    console.log(`\n📧 [EMAIL SERVICE] Preparando email para enviar`);
    console.log(`   Destinatario: ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Adjuntos recibidos: ${attachments?.length || 0}`);
    
    if (attachments && attachments.length > 0) {
      console.log(`\n   📎 Detalles de adjuntos recibidos:`);
      attachments.forEach((att, idx) => {
        console.log(`      ${idx + 1}. ${att.filename || 'Sin nombre'}`);
        console.log(`         - Tipo: ${att.type || 'N/A'}`);
        console.log(`         - Disposition: ${att.disposition || 'N/A'}`);
        console.log(`         - Tamaño base64: ${att.content?.length || 0} caracteres`);
        console.log(`         - ContentId: ${att.contentId || att.content_id || 'N/A'}`);
        if (att.content && att.content.length > 0) {
          console.log(`         - Primeros 30 chars: ${att.content.substring(0, 30)}...`);
        } else {
          console.log(`         - ⚠️ CONTENIDO VACÍO!`);
        }
      });
    } else {
      console.log(`   ⚠️ No se recibieron adjuntos!`);
    }
    
    const msg: any = {
      to,
      from:
        this.configService.get<string>('SENDGRID_FROM_EMAIL') ||
        'no-reply@fest-go.com',
      subject,
      text: body,
    };
    
    if (htmlBody) {
      msg.html = htmlBody;
      console.log(`   HTML Body: ${htmlBody.length} caracteres`);
    }
    
    if (attachments && attachments.length > 0) {
      console.log(`\n   🔧 Formateando adjuntos para SendGrid...`);
      // SendGrid espera el formato correcto de attachments
      msg.attachments = attachments.map((att, idx) => {
        const attachment: any = {
          content: att.content,
          filename: att.filename || `attachment-${idx + 1}.png`,
          type: att.type || 'image/png',
          disposition: att.disposition || 'attachment',
        };
        // SendGrid usa content_id (con guion bajo) para referencias inline
        if (att.contentId || att.content_id) {
          attachment.content_id = att.contentId || att.content_id;
        }
        console.log(`      ✅ Adjunto ${idx + 1} formateado: ${attachment.filename}`);
        return attachment;
      });
      console.log(`   ✅ ${msg.attachments.length} adjunto(s) configurado(s) para SendGrid`);
      console.log(`   📋 Formato final:`, JSON.stringify(msg.attachments.map(a => ({
        filename: a.filename,
        type: a.type,
        disposition: a.disposition,
        hasContent: !!a.content,
        contentLength: a.content?.length || 0,
        hasContentId: !!a.content_id,
      })), null, 2));
    } else {
      console.log(`   ⚠️ No se agregaron adjuntos al mensaje!`);
    }
    
    console.log(`\n   🚀 Enviando email a SendGrid...`);
    try {
      const result = await SendGrid.send(msg);
      console.log(`   ✅ Email enviado exitosamente a SendGrid`);
      console.log(`      Response status: ${result[0]?.statusCode || 'N/A'}`);
      console.log(`      Headers:`, JSON.stringify(result[0]?.headers || {}, null, 2));
      return { success: true, message: 'Email sent successfully' };
    } catch (error: any) {
      console.error(`\n   ❌ ERROR al enviar email a SendGrid:`);
      console.error(`      Mensaje: ${error.message}`);
      console.error(`      Stack: ${error.stack}`);
      if (error.response) {
        console.error(`      Response body:`, JSON.stringify(error.response.body, null, 2));
      }
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
