import crypto from 'crypto';

export interface RegistrationPaymentReceipt {
  paymentId: string;
  planId: number;
  email: string;
  orderId: string;
  captureId: string;
  amount: string;
  currency: string;
  paidAt: string;
}

const getReceiptSecret = () => process.env.PAYPAL_RECEIPT_SECRET || process.env.NEXTAUTH_SECRET || '';

function stablePayload(receipt: RegistrationPaymentReceipt) {
  return [
    receipt.paymentId,
    receipt.planId,
    receipt.email.toLowerCase(),
    receipt.orderId,
    receipt.captureId,
    receipt.amount,
    receipt.currency,
    receipt.paidAt,
  ].join('|');
}

export function signRegistrationPaymentReceipt(receipt: RegistrationPaymentReceipt) {
  const secret = getReceiptSecret();
  if (!secret) {
    throw new Error('Payment receipt signing secret is not configured');
  }

  return crypto
    .createHmac('sha256', secret)
    .update(stablePayload(receipt))
    .digest('hex');
}

export function verifyRegistrationPaymentReceipt(
  receipt: RegistrationPaymentReceipt,
  signature: string | undefined,
) {
  if (!signature) return false;

  const expected = signRegistrationPaymentReceipt(receipt);
  if (expected.length !== signature.length) return false;

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
