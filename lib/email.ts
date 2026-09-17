// lib/email.ts
import { Resend } from 'resend';
import prisma from '@/app/lib/prisma';
import { emailFrom, getEmailFrom } from '@/lib/email-sender';

interface InvitationEmailData {
  email: string;
  accountName: string;
  invitationId: string;
  inviteUrl: string;
  access_level: number;
}

interface PasswordResetEmailData {
  email: string;
  resetUrl: string;
  userName?: string;
}

interface SubscriptionNotificationData {
  userName: string;
  userId: string;
  userEmail: string;
  planName: string;
  accountName: string;
}

interface NewAccountNotificationData {
  userName: string;
  userId: string;
  userEmail: string;
  accountName: string;
  accountId: string;
}

interface EmailResponse {
  success: boolean;
  error?: string;
}

interface ContractAcceptanceEmailData {
  email: string;
  customerName?: string | null;
  accountName?: string | null;
  orderId: number;
  orderLabel?: string;
  contractFileName: string;
  acceptUrl: string;
  expiresAt: Date;
  language?: string | null;
  customerCountry?: string | null;
}

interface RentalEventFollowupEmailData {
  email: string;
  customerName?: string | null;
  accountName?: string | null;
  orderId: number;
  accessUrl: string;
  pin: string;
  language?: string | null;
  customerCountry?: string | null;
}

type ContractAcceptanceReminderEmailData = ContractAcceptanceEmailData;
type BillEmailData = ContractAcceptanceEmailData & {
  companyPhone?: string | null;
  senderFirstName?: string | null;
  senderLastName?: string | null;
};

export function resolveCustomerEmailLanguage(
  language?: string | null,
  customerCountry?: string | null
): 'no' | 'en' {
  const explicitLanguage = (language ?? '').trim().toLowerCase();
  if (explicitLanguage === 'no' || explicitLanguage === 'nb' || explicitLanguage === 'nb-no') {
    return 'no';
  }
  if (explicitLanguage === 'en' || explicitLanguage === 'eng' || explicitLanguage === 'english') {
    return 'en';
  }

  const country = (customerCountry ?? '').trim().toLowerCase();
  if (
    !country ||
    ['en', 'eng', 'english', 'gb', 'uk', 'us', 'usa', 'united states', 'united kingdom', 'germany', 'de'].includes(country)
  ) {
    return 'en';
  }

  if (
    ['no', 'nb', 'nb-no', 'norge', 'norway', 'norwegian', 'norsk', 'sweden', 'sverige', 'denmark', 'danish', 'danmark'].includes(country) ||
    country.includes('nor')
  ) {
    return 'no';
  }

  return 'en';
}

const apiKey = process.env.RESEND_API_KEY;
console.log('email.ts Resend API key:', apiKey ? 'configured' : 'missing');

function getResendClient() {
  const resendApiKey = process.env.RESEND_API_KEY;

  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  return new Resend(resendApiKey);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export const sendContractAcceptanceEmail = async (
  data: ContractAcceptanceEmailData
): Promise<EmailResponse> => {
  const language = resolveCustomerEmailLanguage(data.language, data.customerCountry);
  const isNorwegian = language === 'no';
  const customerName = data.customerName?.trim() || (isNorwegian ? 'kunde' : 'customer');
  const accountName = data.accountName?.trim() || 'WorkReg';
  const orderLabel = data.orderLabel?.trim() || (isNorwegian ? 'arbeidsordre' : 'work order');
  const expiresText = data.expiresAt.toLocaleDateString(isNorwegian ? 'nb-NO' : 'en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const subject = isNorwegian
    ? `Kontrakt for ${orderLabel} #${data.orderId}`
    : `Contract for ${orderLabel} #${data.orderId}`;
  const title = isNorwegian ? 'Kontrakt til godkjenning' : 'Contract to review and accept';
  const greeting = isNorwegian ? `Hei ${escapeHtml(customerName)}` : `Hello ${escapeHtml(customerName)}`;
  const intro = isNorwegian
    ? `${escapeHtml(accountName)} ber deg lese og godkjenne kontrakten for ${escapeHtml(orderLabel)} #${data.orderId}.`
    : `${escapeHtml(accountName)} asks you to review and accept the contract for ${escapeHtml(orderLabel)} #${data.orderId}.`;
  const documentLabel = isNorwegian ? 'Dokument' : 'Document';
  const expiryLabel = isNorwegian ? 'Lenken utløper' : 'Link expires';
  const actionLabel = isNorwegian ? 'Åpne og godkjenn kontrakt' : 'Open and accept contract';
  const fallbackText = isNorwegian
    ? 'Dersom knappen ikke virker, kopier denne lenken til nettleseren din:'
    : 'If the button does not work, copy this link into your browser:';

  try {
    const { error } = await getResendClient().emails.send({
      from: getEmailFrom(accountName),
      to: data.email,
      subject,
      html: `
        <div style="font-family: sans-serif; max-width: 640px; margin: 0 auto; color: #111827;">
          <h2 style="margin-bottom: 8px;">${title}</h2>
          <p>${greeting},</p>
          <p>${intro}</p>
          <div style="background: #f3f4f6; border-radius: 6px; padding: 14px 16px; margin: 18px 0;">
            <p style="margin: 0;"><strong>${documentLabel}:</strong> ${escapeHtml(data.contractFileName)}</p>
            <p style="margin: 8px 0 0;"><strong>${expiryLabel}:</strong> ${escapeHtml(expiresText)}</p>
          </div>
          <a href="${data.acceptUrl}"
             style="display: inline-block; background-color: #0f766e; color: white;
                    padding: 12px 20px; text-decoration: none; border-radius: 6px;
                    margin: 10px 0 18px;">
            ${actionLabel}
          </a>
          <p style="color: #6b7280; font-size: 13px;">
            ${fallbackText}<br />
            ${escapeHtml(data.acceptUrl)}
          </p>
        </div>
      `,
    });

    if (error) {
      return { success: false, error: JSON.stringify(error) };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message ?? 'Unknown error' };
  }
};

export const sendContractAcceptanceReminderEmail = async (
  data: ContractAcceptanceReminderEmailData
): Promise<EmailResponse> => {
  const language = resolveCustomerEmailLanguage(data.language, data.customerCountry);
  const isNorwegian = language === 'no';
  const customerName = data.customerName?.trim() || (isNorwegian ? 'kunde' : 'customer');
  const accountName = data.accountName?.trim() || 'WorkReg';
  const expiresText = data.expiresAt.toLocaleDateString(isNorwegian ? 'nb-NO' : 'en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const subject = isNorwegian
    ? `Påminnelse: kontraktgodkjenning for arbeidsordre #${data.orderId}`
    : `Reminder: contract acceptance for work order #${data.orderId}`;
  const title = isNorwegian ? 'Påminnelse om kontraktgodkjenning' : 'Contract acceptance reminder';
  const greeting = isNorwegian ? `Hei ${escapeHtml(customerName)}` : `Hello ${escapeHtml(customerName)}`;
  const intro = isNorwegian
    ? 'Vi ser at du har sett vårt tilbud, men vi mangler fortsatt godkjenningen for å starte forberedelsene til arbeidet. Hvis du har spørsmål, kan du kontakte oss på <a href="tel:+4793004488">+47 93004488</a> for å avklare eventuelle misforståelser.'
    : 'We are happy to see you have seen our offer, but we are still missing your acceptance to start the preparations for the work. If you have any questions, please call <a href="tel:+4793004488">+47 93004488</a> to sort out any misunderstandings.';
  const documentLabel = isNorwegian ? 'Dokument' : 'Document';
  const expiryLabel = isNorwegian ? 'Lenken utløper' : 'Link expires';
  const actionLabel = isNorwegian ? 'Åpne og godkjenn kontrakt' : 'Open and accept contract';
  const fallbackText = isNorwegian
    ? 'Dersom knappen ikke virker, kopier denne lenken til nettleseren din:'
    : 'If the button does not work, copy this link into your browser:';

  try {
    const { error } = await getResendClient().emails.send({
      from: getEmailFrom(accountName),
      to: data.email,
      subject,
      html: `
        <div style="font-family: sans-serif; max-width: 640px; margin: 0 auto; color: #111827;">
          <h2 style="margin-bottom: 8px;">${title}</h2>
          <p>${greeting},</p>
          <p>${intro}</p>
          <div style="background: #f3f4f6; border-radius: 6px; padding: 14px 16px; margin: 18px 0;">
            <p style="margin: 0;"><strong>${documentLabel}:</strong> ${escapeHtml(data.contractFileName)}</p>
            <p style="margin: 8px 0 0;"><strong>${expiryLabel}:</strong> ${escapeHtml(expiresText)}</p>
          </div>
          <a href="${data.acceptUrl}"
             style="display: inline-block; background-color: #0f766e; color: white;
                    padding: 12px 20px; text-decoration: none; border-radius: 6px;
                    margin: 10px 0 18px;">
            ${actionLabel}
          </a>
          <p style="color: #6b7280; font-size: 13px;">
            ${fallbackText}<br />
            ${escapeHtml(data.acceptUrl)}
          </p>
        </div>
      `,
    });

    if (error) {
      return { success: false, error: JSON.stringify(error) };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message ?? 'Unknown error' };
  }
};

export const sendRentalEventFollowupEmail = async (
  data: RentalEventFollowupEmailData
): Promise<EmailResponse> => {
  const language = resolveCustomerEmailLanguage(data.language, data.customerCountry);
  const isNorwegian = language === 'no';
  const customerName = data.customerName?.trim() || (isNorwegian ? 'kunde' : 'customer');
  const accountName = data.accountName?.trim() || 'WorkReg';
  const subject = isNorwegian
    ? `Hendelsesliste for leieforhold #${data.orderId}`
    : `Rental event log for rental agreement #${data.orderId}`;
  const title = isNorwegian ? 'Hendelsesliste for leieforholdet' : 'Rental event log';
  const greeting = isNorwegian ? `Hei ${escapeHtml(customerName)}` : `Hello ${escapeHtml(customerName)}`;
  const intro = isNorwegian
    ? 'Her er hendelseslisten relatert til ditt leieforhold. Følg opp leieforholdet gjennom din leieperiode ved å registrere hendelser.'
    : 'Here is the event log related to your rental agreement. Please follow up on the rental throughout the rental period by registering events.';
  const orderLabel = isNorwegian ? 'Utleieordre' : 'Rental order';
  const pinLabel = isNorwegian ? 'PIN-kode' : 'PIN code';
  const actionLabel = isNorwegian ? 'Åpne hendelsesliste' : 'Open event log';
  const fallbackText = isNorwegian
    ? 'Dersom knappen ikke virker, kopier denne lenken til nettleseren din:'
    : 'If the button does not work, copy this link into your browser:';

  try {
    const { error } = await getResendClient().emails.send({
      from: getEmailFrom(accountName),
      to: data.email,
      subject,
      html: `
        <div style="font-family: sans-serif; max-width: 640px; margin: 0 auto; color: #111827;">
          <h2 style="margin-bottom: 8px;">${title}</h2>
          <p>${greeting},</p>
          <p>${intro}</p>
          <div style="background: #f3f4f6; border-radius: 6px; padding: 14px 16px; margin: 18px 0;">
            <p style="margin: 0;"><strong>${orderLabel}:</strong> #${data.orderId}</p>
            <p style="margin: 8px 0 0;"><strong>${pinLabel}:</strong> ${escapeHtml(data.pin)}</p>
          </div>
          <a href="${escapeHtml(data.accessUrl)}"
             style="display: inline-block; background-color: #0f766e; color: white;
                    padding: 12px 20px; text-decoration: none; border-radius: 6px;
                    margin: 10px 0 18px;">
            ${actionLabel}
          </a>
          <p style="color: #6b7280; font-size: 13px;">
            ${fallbackText}<br />
            ${escapeHtml(data.accessUrl)}
          </p>
        </div>
      `,
    });

    if (error) {
      return { success: false, error: JSON.stringify(error) };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message ?? 'Unknown error' };
  }
};

export const sendBillEmail = async (data: BillEmailData): Promise<EmailResponse> => {
  const language = resolveCustomerEmailLanguage(data.language, data.customerCountry);
  const isNorwegian = language === 'no';
  const accountName = data.accountName?.trim() || 'WorkReg';
  const companyPhone = data.companyPhone?.trim();
  const senderName = [data.senderFirstName?.trim(), data.senderLastName?.trim()]
    .filter(Boolean)
    .join(' ');
  const subject = isNorwegian ? `${accountName} har sendt deg et dokument` : `${accountName} has sent you a document`;
  const title = isNorwegian ? `Dokument fra ${escapeHtml(accountName)}` : `Document from ${escapeHtml(accountName)}`;
  const introText = isNorwegian
    ? `${escapeHtml(accountName)} har sendt deg et dokument som du bør lese.`
    : `${escapeHtml(accountName)} has sent you a document for you to read.`;
  const secondLine = isNorwegian ? 'Les innholdet ved å klikke på knappen nedenfor.' : 'Please see the content by clicking the button below.';
  const documentLabel = isNorwegian ? 'Dokument' : 'Document';
  const actionLabel = isNorwegian ? 'Les innhold' : 'Read content';
  const contactText = isNorwegian
    ? companyPhone
      ? `Kontakt kontoret på <a href="tel:${escapeHtml(companyPhone)}">${escapeHtml(companyPhone)}</a> hvis du har spørsmål.`
      : 'Kontakt kontoret hvis du har spørsmål.'
    : companyPhone
      ? `Contact the office on <a href="tel:${escapeHtml(companyPhone)}">${escapeHtml(companyPhone)}</a> if you have any questions.`
      : 'Contact the office if you have any questions.';
  const footerText = isNorwegian
    ? `Denne sikre lenken ble sendt til ${escapeHtml(data.email)} av ${escapeHtml(accountName)}.`
    : `This secure link was sent to ${escapeHtml(data.email)} by ${escapeHtml(accountName)}.`;
  const regardsText = isNorwegian ? 'Med vennlig hilsen' : 'Regards';
  try {
    const { error } = await getResendClient().emails.send({
      from: getEmailFrom(accountName),
      to: data.email,
      subject,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; color: #111827;">
          <div style="border-bottom: 3px solid #0f766e; padding-bottom: 14px; margin-bottom: 24px;">
            <h2 style="margin: 0; color: #0f766e;">${title}</h2>
          </div>
          <p>${introText}</p>
          <p>${secondLine}</p>
          <div style="background: #f3f4f6; border-radius: 6px; padding: 14px 16px; margin: 20px 0;">
            <p style="margin: 0;"><strong>${documentLabel}:</strong> ${escapeHtml(data.contractFileName)}</p>
          </div>
          <a href="${escapeHtml(data.acceptUrl)}"
             style="display: inline-block; background-color: #0f766e; color: #ffffff;
                    padding: 12px 22px; text-decoration: none; border-radius: 6px;
                    font-weight: 600; margin: 2px 0 22px;">
            ${actionLabel}
          </a>
          ${contactText ? `<p>${contactText}</p>` : ''}
          <p style="margin-top: 24px;">${regardsText}${senderName ? `,<br />${escapeHtml(senderName)}` : ''}</p>
          <p style="color: #6b7280; font-size: 12px; margin-top: 28px;">
            ${footerText}
          </p>
        </div>
      `,
    });
    return error
      ? { success: false, error: JSON.stringify(error) }
      : { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message ?? 'Unknown error' };
  }
};

export const sendInvitationEmail = async (
  data: InvitationEmailData
): Promise<EmailResponse> => {
  const { email, accountName, invitationId, access_level } = data;

  const invitationUrl = `${process.env.NEXT_PUBLIC_APP_URL}/invitation/${invitationId}/accept`;

  const roleText =
    access_level === 5
      ? 'Admin'
      : access_level === 20
      ? 'Editor'
      : access_level === 99
      ? 'Read Only'
      : 'Member';

  try {
    console.log('📧 Attempting to send email to:', email);
    console.log('Resend API key:', process.env.RESEND_API_KEY ? 'configured' : 'missing');
    
    const { data: emailData, error } = await getResendClient().emails.send({
      from: emailFrom,
      to: email,
      subject: `You've been invited to join ${accountName} on WorkReg`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>You've been invited!</h2>
          <p>You've been invited to join <strong>${accountName}</strong> on WorkReg as <strong>${roleText}</strong>.</p>
          <p>Click the link below to accept the invitation and create your account:</p>
          <a href="${invitationUrl}"
             style="display: inline-block; background-color: #0066CC; color: white;
                    padding: 12px 24px; text-decoration: none; border-radius: 6px;
                    margin: 20px 0;">
            Accept Invitation
          </a>
          <p style="color: #666; font-size: 14px;">
            This invitation will expire in 7 days.
          </p>
        </div>
      `,
    });

    if (error) {
      console.error('❌ Failed to send invitation email (Resend error):', error);
      return { success: false, error: JSON.stringify(error) };
    }

    console.log('✅ Invitation email sent successfully:', emailData);
    return { success: true };
  } catch (err: any) {
    console.error('❌ Failed to send invitation email (exception):', err);
    return { success: false, error: err?.message ?? 'Unknown error' };
  }
};

export const sendPasswordResetEmail = async (
  data: PasswordResetEmailData
): Promise<EmailResponse> => {
  const { email, resetUrl, userName } = data;

  try {
    console.log('📧 Attempting to send password reset email to:', email);

    const { data: emailData, error } = await getResendClient().emails.send({
      from: emailFrom,
      to: email,
      subject: 'Reset Your WorkReg Password',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Password Reset Request</h2>
          <p>Hello${userName ? ` ${userName}` : ''},</p>
          <p>We received a request to reset your password for your WorkReg account.</p>
          <p>Click the button below to reset your password:</p>
          <a href="${resetUrl}"
             style="display: inline-block; background-color: #0066CC; color: white;
                    padding: 12px 24px; text-decoration: none; border-radius: 6px;
                    margin: 20px 0;">
            Reset Password
          </a>
          <p style="color: #666; font-size: 14px;">
            This link will expire in 24 hours.
          </p>
          <p style="color: #666; font-size: 14px;">
            If you didn't request a password reset, you can safely ignore this email.
          </p>
        </div>
      `,
    });

    if (error) {
      console.error('❌ Failed to send password reset email (Resend error):', error);
      return { success: false, error: JSON.stringify(error) };
    }

    console.log('✅ Password reset email sent successfully:', emailData);
    return { success: true };
  } catch (err: any) {
    console.error('❌ Failed to send password reset email (exception):', err);
    return { success: false, error: err?.message ?? 'Unknown error' };
  }
};

export const sendSubscriptionNotificationEmail = async (
  data: SubscriptionNotificationData
): Promise<EmailResponse> => {
  const { userName, userId, userEmail, planName, accountName } = data;
  const adminEmail = process.env.SYS_ADMIN_USER;

  if (!adminEmail) {
    console.error('❌ SYS_ADMIN_USER not configured in environment variables');
    return { success: false, error: 'Admin email not configured' };
  }

  try {
    console.log('📧 Attempting to send subscription notification to admin:', adminEmail);

    const { data: emailData, error } = await getResendClient().emails.send({
      from: emailFrom,
      to: adminEmail,
      subject: `New Subscription Request: ${planName}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>New Subscription Request</h2>
          <p>A new subscription has been requested on WorkReg.</p>

          <div style="background-color: #f5f5f5; padding: 20px; border-radius: 6px; margin: 20px 0;">
            <h3 style="margin-top: 0;">User Details:</h3>
            <p style="margin: 8px 0;"><strong>Name:</strong> ${userName}</p>
            <p style="margin: 8px 0;"><strong>Email:</strong> ${userEmail}</p>
            <p style="margin: 8px 0;"><strong>User ID:</strong> ${userId}</p>
          </div>

          <div style="background-color: #e3f2fd; padding: 20px; border-radius: 6px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Subscription Details:</h3>
            <p style="margin: 8px 0;"><strong>Account:</strong> ${accountName}</p>
            <p style="margin: 8px 0;"><strong>Plan:</strong> ${planName}</p>
          </div>

          <p style="color: #666; font-size: 14px; margin-top: 30px;">
            This is an automated notification from WorkReg.
          </p>
        </div>
      `,
    });

    if (error) {
      console.error('❌ Failed to send subscription notification email (Resend error):', error);
      return { success: false, error: JSON.stringify(error) };
    }

    console.log('✅ Subscription notification email sent successfully:', emailData);
    return { success: true };
  } catch (err: any) {
    console.error('❌ Failed to send subscription notification email (exception):', err);
    return { success: false, error: err?.message ?? 'Unknown error' };
  }
};

/**
 * Send an in-app notification to the system admin about a new subscription
 */
export const sendSubscriptionInAppNotification = async (
  data: SubscriptionNotificationData & { senderId: string; accountId: string }
): Promise<EmailResponse> => {
  const { userName, userId, userEmail, planName, accountName, senderId, accountId } = data;
  const adminEmail = process.env.SYS_ADMIN_USER;

  if (!adminEmail) {
    console.error('❌ SYS_ADMIN_USER not configured - cannot send in-app notification');
    return { success: false, error: 'Admin email not configured' };
  }

  try {
    // Find the system admin user by email
    const adminUser = await prisma.tbluser.findFirst({
      where: { email: adminEmail },
    });

    if (!adminUser) {
      console.error('❌ System admin user not found in database:', adminEmail);
      return { success: false, error: 'System admin user not found' };
    }

    const messageContent = `New Subscription Request

Account: ${accountName}
Plan: ${planName}

User Details:
- Name: ${userName}
- Email: ${userEmail}
- User ID: ${userId}

This subscription request requires your attention.`;

    // Create the in-app message delivery
    await prisma.tblmessagedelivery.create({
      data: {
        sender_id: BigInt(senderId),
        recipient_id: adminUser.id,
        message_content: messageContent,
        subject: `New Subscription: ${planName} - ${accountName}`,
        status: 'sent',
        account_id: BigInt(accountId),
      },
    });

    console.log('✅ In-app subscription notification sent to admin:', adminEmail);
    return { success: true };
  } catch (err: any) {
    console.error('❌ Failed to send in-app subscription notification:', err);
    return { success: false, error: err?.message ?? 'Unknown error' };
  }
};

/**
 * Send email notification to system admin about a new account creation
 */
export const sendNewAccountNotificationEmail = async (
  data: NewAccountNotificationData
): Promise<EmailResponse> => {
  const { userName, userId, userEmail, accountName, accountId } = data;
  const adminEmail = process.env.SYS_ADMIN_USER;

  if (!adminEmail) {
    console.error('❌ SYS_ADMIN_USER not configured in environment variables');
    return { success: false, error: 'Admin email not configured' };
  }

  try {
    console.log('📧 Attempting to send new account notification to admin:', adminEmail);

    const { data: emailData, error } = await getResendClient().emails.send({
      from: emailFrom,
      to: adminEmail,
      subject: `New Account Created: ${accountName}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>New Account Created</h2>
          <p>A new account has been created on WorkReg.</p>

          <div style="background-color: #f5f5f5; padding: 20px; border-radius: 6px; margin: 20px 0;">
            <h3 style="margin-top: 0;">User Details:</h3>
            <p style="margin: 8px 0;"><strong>Name:</strong> ${userName}</p>
            <p style="margin: 8px 0;"><strong>Email:</strong> ${userEmail}</p>
            <p style="margin: 8px 0;"><strong>User ID:</strong> ${userId}</p>
          </div>

          <div style="background-color: #e8f5e9; padding: 20px; border-radius: 6px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Account Details:</h3>
            <p style="margin: 8px 0;"><strong>Account Name:</strong> ${accountName}</p>
            <p style="margin: 8px 0;"><strong>Account ID:</strong> ${accountId}</p>
            <p style="margin: 8px 0;"><strong>Plan:</strong> Free (default)</p>
          </div>

          <p style="color: #666; font-size: 14px; margin-top: 30px;">
            This is an automated notification from WorkReg.
          </p>
        </div>
      `,
    });

    if (error) {
      console.error('❌ Failed to send new account notification email (Resend error):', error);
      return { success: false, error: JSON.stringify(error) };
    }

    console.log('✅ New account notification email sent successfully:', emailData);
    return { success: true };
  } catch (err: any) {
    console.error('❌ Failed to send new account notification email (exception):', err);
    return { success: false, error: err?.message ?? 'Unknown error' };
  }
};

/**
 * Send an in-app notification to the system admin about a new account creation
 */
export const sendNewAccountInAppNotification = async (
  data: NewAccountNotificationData
): Promise<EmailResponse> => {
  const { userName, userId, userEmail, accountName, accountId } = data;
  const adminEmail = process.env.SYS_ADMIN_USER;

  if (!adminEmail) {
    console.error('❌ SYS_ADMIN_USER not configured - cannot send in-app notification');
    return { success: false, error: 'Admin email not configured' };
  }

  try {
    // Find the system admin user by email and their primary account
    const adminUser = await prisma.tbluser.findFirst({
      where: { email: adminEmail },
      include: {
        tblaccountuser: {
          orderBy: { account_id: 'asc' },
          take: 1,
          select: { account_id: true },
        },
      },
    });

    if (!adminUser) {
      console.error('❌ System admin user not found in database:', adminEmail);
      return { success: false, error: 'System admin user not found' };
    }

    // Use the admin's primary account (lowest account_id) for the notification
    const adminAccountId = adminUser.tblaccountuser[0]?.account_id;
    if (!adminAccountId) {
      console.error('❌ System admin has no account association');
      return { success: false, error: 'System admin has no account' };
    }

    const messageContent = `New Account Created

Account: ${accountName}
Account ID: ${accountId}

User Details:
- Name: ${userName}
- Email: ${userEmail}
- User ID: ${userId}

A new user has registered and created a new account on WorkReg.`;

    // Create the in-app message delivery to the admin's primary account
    await prisma.tblmessagedelivery.create({
      data: {
        sender_id: BigInt(userId),
        recipient_id: adminUser.id,
        message_content: messageContent,
        subject: `New Account: ${accountName}`,
        status: 'sent',
        account_id: adminAccountId,
      },
    });

    console.log('✅ In-app new account notification sent to admin:', adminEmail);
    return { success: true };
  } catch (err: any) {
    console.error('❌ Failed to send in-app new account notification:', err);
    return { success: false, error: err?.message ?? 'Unknown error' };
  }
};
