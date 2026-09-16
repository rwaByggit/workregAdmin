/*app/api/auth/register/route.ts
The endpoint:
- Validates registration input
- Checks for existing users
- Handles password hashing
- Creates new users in the tblusertable
- Creates a new account if the user isn't invited
- Links users to accounts through the AccountUser table
- Uses transactions to ensure data consistency

This path follows Next.js 13+ App Router conventions, where:
- api indicates it's an API route
- auth/register creates the /api/auth/register endpoint
- route.js is the required filename for API routes in Next.js 13+ (instead of the older pages/api style)

*/
// app/api/auth/register/route.ts
 /*app/api/auth/register/route.ts
The endpoint:
- Validates registration input
- Checks for existing users
- Handles password hashing
- Creates new users in the tblusertable
- Creates a new account if the user isn't invited
- Links users to accounts through the AccountUser table
- Uses transactions to ensure data consistency

This path follows Next.js 13+ App Router conventions, where:
- api indicates it's an API route
- auth/register creates the /api/auth/register endpoint
- route.js is the required filename for API routes in Next.js 13+ (instead of the older pages/api style)

*/
/*app/api/auth/register/route.ts
The endpoint:
- Validates registration input
- Checks for existing users (and redirects them to login)
- Handles password hashing
- Creates new users in the tbluser table
- If invitation provided: accepts it immediately (creates tblaccountuser)
- If no invitation: creates new account for user
- Uses transactions to ensure data consistency
*/
import prisma from '@/app/lib/prisma';
import bcrypt from 'bcryptjs';
import { NextRequest, NextResponse } from 'next/server';
import { sendNewAccountNotificationEmail, sendNewAccountInAppNotification } from '@/lib/email';
import { getSystemAdminUserId } from '@/lib/filter-system-admin';
import type { PrismaClient } from '@prisma/client';
import { verifyRegistrationPaymentReceipt, type RegistrationPaymentReceipt } from '@/app/lib/paypal-registration';
import { getPlanPriceAmount, isOneTimePaymentPlan } from '@/app/lib/subscription-plan';

interface RegisterRequest {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  invitationId?: string;
  subscription_plan_id?: number | string | null;
  paymentReceipt?: RegistrationPaymentReceipt | null;
  paymentReceiptSignature?: string;
}

type PrismaExecutor = PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

function getReceiptPaymentId(receipt: RegistrationPaymentReceipt | null | undefined) {
  if (!receipt?.paymentId) return null;

  try {
    return BigInt(receipt.paymentId);
  } catch {
    return null;
  }
}

async function syncRegistrationSequences(tx: PrismaExecutor) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext('workreg.registration.sequence_sync'))
  `;
  await tx.$executeRaw`
    SELECT setval(
      pg_get_serial_sequence('"tbluser"', 'id'),
      COALESCE((SELECT MAX("id") FROM "tbluser"), 0) + 1,
      false
    )
  `;
  await tx.$executeRaw`
    SELECT setval(
      pg_get_serial_sequence('"tblemployee"', 'employeeid'),
      COALESCE((SELECT MAX("employeeid") FROM "tblemployee"), 0) + 1,
      false
    )
  `;
  await tx.$executeRaw`
    SELECT setval(
      pg_get_serial_sequence('"tblaccount"', 'id'),
      COALESCE((SELECT MAX("id") FROM "tblaccount"), 0) + 1,
      false
    )
  `;
}

export async function POST(req: NextRequest) {
  try {
    const body: RegisterRequest = await req.json();
    const {
      email,
      password,
      firstName,
      lastName,
      invitationId,
      subscription_plan_id,
      paymentReceipt,
      paymentReceiptSignature,
    } = body;
    const requestedPlanId = subscription_plan_id ? Number(subscription_plan_id) : null;

    console.log("api/auth/register - received data:", { email, firstName, lastName, invitationId, requestedPlanId });

    // Validate input
    if (!email || !password || !firstName || !lastName) {
      return NextResponse.json(
        { error: 'All fields are required' },
        { status: 400 }
      );
    }

    // Check if user already exists
    const existingUser = await prisma.tbluser.findUnique({
      where: { email },
    });

    let selectedPlan = null;
    if (!invitationId) {
      selectedPlan = requestedPlanId
        ? await prisma.tblsubscriptionplan.findFirst({
            where: {
              id: requestedPlanId,
              is_active: true,
              is_public: true,
            },
          })
        : await prisma.tblsubscriptionplan.findUnique({
            where: { plan_name: 'free' },
          });

      if (!selectedPlan) {
        return NextResponse.json(
          { error: 'Selected subscription plan is not available' },
          { status: 400 },
        );
      }

      const selectedPlanPrice = getPlanPriceAmount(selectedPlan);
      if (selectedPlanPrice > 0) {
        const paidForSelectedPlan =
          !!getReceiptPaymentId(paymentReceipt) &&
          paymentReceipt?.planId === selectedPlan.id &&
          paymentReceipt.email.toLowerCase() === email.toLowerCase() &&
          Number(paymentReceipt.amount) === selectedPlanPrice &&
          verifyRegistrationPaymentReceipt(paymentReceipt, paymentReceiptSignature);

        if (!paidForSelectedPlan) {
          return NextResponse.json(
            { error: 'Payment must be completed before registering this subscription plan' },
            { status: 402 },
          );
        }
      }
    }
    
    console.log("api/auth/register - existing user check:", existingUser?.id);
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Start transaction
    const result = await prisma.$transaction(async (tx) => {
      await syncRegistrationSequences(tx);

      let invitation = null;
      
      // Check for invitation if provided
      if (invitationId) {
        invitation = await tx.tblinvitation.findFirst({
          where: {
            id: BigInt(invitationId),
            email: email, // Verify invitation is for this email
            status: 'pending',
            expires: {
              gt: new Date()
            }
          },
          include: {
            tblaccount: {
              select: {
                name: true
              }
            }
          }
        });

        console.log("api/auth/register - invitation lookup:", invitation?.id);

        if (!invitation) {
          throw new Error('Invalid or expired invitation');
        }

        // Verify the invitation email matches the registration email
        if (invitation.email.toLowerCase() !== email.toLowerCase()) {
          throw new Error('Invitation email does not match registration email');
        }
      }
      let user;
      if (existingUser){
        user = await tx.tbluser.update({
        where: {id: Number(existingUser.id) },
        data: {
          password: hashedPassword,
          fname: firstName,
          lname: lastName,
          // optionally adjust access_level here
      }
        });
        console.log('api/auth/register - updated user:', user.id);
      }else{
      // Create new user
      user = await tx.tbluser.create({
        data: {
          email,
          password: hashedPassword,
          fname: firstName,
          lname: lastName,
          access_level: 99, // Default access level
        }
      });
            console.log('api/auth/register - created user:', user.id);
      }


      // Create employee record if it doesn't exist (case-insensitive check)
      const existingEmployee = await tx.tblemployee.findFirst({
        where: {
          email: {
            equals: email,
            mode: 'insensitive'
          }
        }
      });

      if (!existingEmployee) {
        console.log('api/auth/register - creating employee for:', email);
        try {
          await tx.tblemployee.create({
            data: {
              firstname: firstName,
              lastname: lastName,
              email: email,
              lvlaccess: invitation?.role || 99
            }
          });
        } catch (err: any) {
          // If unique constraint fails, employee might have been created by another process
          if (err.code !== 'P2002') {
            throw err;
          }
          console.log('api/auth/register - employee creation skipped (already exists)');
        }
      } else {
        console.log('api/auth/register - employee already exists:', existingEmployee.employeeid);
      }

      if (invitation) {

        // Update invitation status to accepted
        await tx.tblinvitation.update({
          where: { id: invitation.id },
          data: { status: 'accepted' }
        });

        console.log('api/auth/register - invitation accepted');
        await tx.tblaccountuser.create({
          data: {
            account_id: invitation.account_id,
            user_id: user.id,
            access_level: invitation.role
          }
        });

        return { user, invitation };
      } else {
        if (!selectedPlan) {
          throw new Error('Selected subscription plan is not available');
        }

        // No invitation - create new account for the user
        const subscriptionExpire = new Date();
        const selectedPlanPrice = getPlanPriceAmount(selectedPlan);
        if (selectedPlanPrice > 0) {
          if (isOneTimePaymentPlan(selectedPlan)) {
            subscriptionExpire.setDate(subscriptionExpire.getDate() + 70);
          } else {
            subscriptionExpire.setMonth(subscriptionExpire.getMonth() + 1);
          }
        } else {
          subscriptionExpire.setDate(subscriptionExpire.getDate() + 70);
        }

        const account = await tx.tblaccount.create({
          data: {
            name: `${firstName}'s Account`,
            subscription_plan_id: selectedPlan?.id ?? null,
            subscription_expire: subscriptionExpire,
          }
        });

        console.log('api/auth/register - created new account:', account.id);

        if (selectedPlanPrice > 0) {
          const paymentId = getReceiptPaymentId(paymentReceipt);
          if (!paymentId || !paymentReceipt) {
            throw new Error('Payment must be completed before registering this subscription plan');
          }

          const consumedPayment = await tx.tblregistrationpayment.updateMany({
            where: {
              id: paymentId,
              email: {
                equals: email,
                mode: 'insensitive',
              },
              plan_id: selectedPlan.id,
              amount: selectedPlanPrice.toFixed(2),
              currency: paymentReceipt.currency,
              paypal_order_id: paymentReceipt.orderId,
              paypal_capture_id: paymentReceipt.captureId,
              status: 'PAID',
              paid_at: {
                not: null,
              },
            },
            data: {
              account_id: account.id,
              paypal_transaction_id: paymentReceipt.captureId,
              status: 'REGISTERED',
            },
          });

          if (consumedPayment.count !== 1) {
            throw new Error('Payment has already been used or could not be verified');
          }
        }

        // Link user to new account with admin rights
        await tx.tblaccountuser.create({
          data: {
            account_id: account.id,
            user_id: user.id,
            access_level: 1 // Admin rights for their own account
          }
        });

        // Add SYS_ADMIN_USER to the account so it's visible in admin list
        const sysAdminUserId = await getSystemAdminUserId(tx);
        if (sysAdminUserId && sysAdminUserId !== user.id) {
          await tx.tblaccountuser.upsert({
            where: {
              account_id_user_id: {
                account_id: account.id,
                user_id: sysAdminUserId,
              },
            },
            update: {},
            create: {
              account_id: account.id,
              user_id: sysAdminUserId,
              access_level: 1,
            },
          });
          console.log('api/auth/register - linked account to sys_admin_user');
        }

        return { user, invitation: null, newAccount: account };
      }
    });

    // Send notifications for new account creation (outside transaction)
    if (!result.invitation && result.newAccount) {
      const notificationData = {
        userName: `${firstName} ${lastName}`.trim(),
        userId: result.user.id.toString(),
        userEmail: email,
        accountName: result.newAccount.name || `${firstName}'s Account`,
        accountId: result.newAccount.id.toString(),
      };

      // Send email notification to admin
      await sendNewAccountNotificationEmail(notificationData).catch(error => {
        console.error('Failed to send new account email notification:', error);
      });

      // Send in-app notification to admin
      await sendNewAccountInAppNotification(notificationData).catch(error => {
        console.error('Failed to send new account in-app notification:', error);
      });
    }
    console.log('api/auth/register - result of TX:', result);
    return NextResponse.json(
      {
        message: result.invitation 
          ? `Registration successful! You have been added to ${result.invitation.tblaccount.name}.` 
          : 'Registration successful!',
        userId: result.user.id.toString(),
        hasInvitation: !!result.invitation,
        accountName: result.invitation?.tblaccount.name
      },
      { status: 201 }
    );

  } catch (error: any) {
    console.error('Registration error:', error);

    if (error.message === 'Invalid or expired invitation') {
      return NextResponse.json(
        { error: 'Invalid or expired invitation. Please request a new invitation.' },
        { status: 400 }
      );
    }

    if (error.message === 'Invitation email does not match registration email') {
      return NextResponse.json(
        { error: 'This invitation was sent to a different email address.' },
        { status: 400 }
      );
    }

    if (error.message === 'Payment must be completed before registering this subscription plan') {
      return NextResponse.json(
        { error: error.message },
        { status: 402 },
      );
    }

    if (error.message === 'Payment has already been used or could not be verified') {
      return NextResponse.json(
        { error: error.message },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { error: 'Registration failed. Please try again.' },
      { status: 500 }
    );
  } finally {
    await prisma.$disconnect();
  }
}
