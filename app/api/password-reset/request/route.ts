// app/api/password-reset/request/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { sendPasswordResetEmail } from '@/lib/email';

const prisma = new PrismaClient();

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json();

    if (!email) {
      return NextResponse.json(
        { error: 'Email is required' },
        { status: 400 }
      );
    }

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // Find user by email case-insensitively. Stored email casing may differ from
    // what the user typed, and password reset should still work.
    const user = await prisma.tbluser.findFirst({
      where: {
        email: {
          equals: normalizedEmail,
          mode: 'insensitive',
        },
      },
    });

    // Always return success to prevent email enumeration
    // Don't reveal whether the email exists or not
    if (!user) {
      console.log(`Password reset requested for non-existent email: ${normalizedEmail}`);
      return NextResponse.json(
        {
          success: true,
          message: 'If an account with that email exists, a password reset link has been sent.'
        },
        { status: 200 }
      );
    }

    // Generate secure random token
    const token = randomBytes(32).toString('hex');

    // Set expiration to 24 hours from now
    const expires = new Date();
    expires.setHours(expires.getHours() + 24);

    // Delete any existing password reset tokens for this user
    await prisma.tbl_password_reset_token.deleteMany({
      where: { user_id: user.id },
    });

    // Create new password reset token
    await prisma.tbl_password_reset_token.create({
      data: {
        user_id: user.id,
        token,
        expires,
      },
    });

    // Generate reset URL
    const resetUrl = `${process.env.NEXT_PUBLIC_APP_URL}/password-reset/${token}`;

    // Send email
    const userName = user.fname ? `${user.fname} ${user.lname || ''}`.trim() : undefined;
    const emailResult = await sendPasswordResetEmail({
      email: user.email,
      resetUrl,
      userName,
    });

    if (!emailResult.success) {
      console.error('Failed to send password reset email:', emailResult.error);
      // Don't reveal email sending failure to prevent enumeration
    }

    return NextResponse.json(
      {
        success: true,
        message: 'If an account with that email exists, a password reset link has been sent.'
      },
      { status: 200 }
    );

  } catch (error: any) {
    console.error('Error in password reset request:', error);
    return NextResponse.json(
      { error: 'An error occurred processing your request' },
      { status: 500 }
    );
  } finally {
    await prisma.$disconnect();
  }
}
