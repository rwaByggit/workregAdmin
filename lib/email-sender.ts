const emailFromName = process.env.RESEND_FROM_NAME || process.env.EMAIL_FROM_NAME || 'WorkReg';
const configuredEmailFromAddress = process.env.RESEND_FROM_EMAIL || process.env.EMAIL_FROM;
const emailFromAddress =
  configuredEmailFromAddress?.toLowerCase() === 'onboarding@resend.dev'
    ? 'no-reply@just4us.no'
    : configuredEmailFromAddress || 'no-reply@just4us.no';

function cleanEmailDisplayName(name: string) {
  return name
    .replace(/[\r\n<>]/g, '')
    .replace(/"/g, "'")
    .trim();
}

export function getEmailFrom(displayName?: string | null) {
  const name = cleanEmailDisplayName(displayName || emailFromName) || 'WorkReg';
  return `${name} <${emailFromAddress}>`;
}

export const emailFrom = getEmailFrom();
