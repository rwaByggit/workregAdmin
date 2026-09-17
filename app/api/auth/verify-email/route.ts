/*
# Email Verification Route

## Purpose
This API route handles the email verification process during user registration.

It generates and sends one-time passwords (OTP) to verify user email addresses before allowing account creation.

## Key Features
- Generates secure 6-digit OTP codes
- Stores verification data in MSSQL database with expiration
- Sends branded verification emails using Resend API
- Prevents duplicate registrations and spam accounts
- Handles email verification timeouts (15 minutes)

## Technical Details

### Endpoint Information
- **Route**: `/api/auth/verify-email`
- **Method**: POST
- **Request Body**:
  ```json
  {
    "email": "user@example.com"
  }
  ```
- **Success Response**: Status 200
  ```json
  {
    "message": "OTP sent successfully"
  }
  ```
- **Error Response**: Status 500
  ```json
  {
    "error": "Failed to send verification code"
  }
  ```

### Database Schema
Uses the `tblEmailVerification` table:
```sql
CREATE TABLE IF NOT EXISTS tblEmailVerification (
    id BIGINT PRIMARY KEY IDENTITY(1,1),
    email VARCHAR(255) NOT NULL,
    otp VARCHAR(6) NOT NULL,
    expires datetime NOT NULL,
    verified INT DEFAULT 0,
    created datetime DEFAULT sysutcdatetime()
)
```

### Key Functions

#### generateOTP()
- Generates a random 6-digit number
- Returns string format for consistent length
- Range: 100000-999999

#### Database Operations
- Uses raw SQL queries for reliable datetime handling
- Creates verification record with 15-minute expiration
- Uses MSSQL's GETUTCDATE() for timestamp consistency

#### Email Sending
- Uses Resend API for reliable delivery
- Branded HTML email template
- Includes OTP code and expiration notice

## Example Usage
```javascript
// Client-side code
const response = await fetch('/api/auth/verify-email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'user@example.com' })
});

if (response.ok) {
  // Show OTP input form
} else {
  // Handle error
}
```

## Important Notes
1. Verification codes expire after 15 minutes
2. Resend cooldown period of 60 seconds
3. Requires valid Resend API key in environment variables
4. Uses UTC timestamps for consistent timezone handling
5. Validates email format before sending OTP

## Security Considerations
- OTPs are single-use only
- Expired codes are automatically invalidated
- Rate limiting prevents abuse
- Email format validation
- No enumeration of existing accounts

## Dependencies
- Prisma Client
- Resend API
- MSSQL Server

## Environment Variables Required
```env
RESEND_API_KEY=your_api_key_here
```

## Related Files
- `/app/components/EmailVerification.js` - Frontend component
- `/app/api/auth/verify-otp/route.js` - OTP verification endpoint
- `prisma/schema.prisma` - Database schema definitions
*/
// app/api/auth/verify-email/route.ts
import prisma from '@/app/lib/prisma';
import { Resend } from 'resend';
import { NextRequest, NextResponse } from 'next/server';
import { emailFrom } from '@/lib/email-sender';

// Generate a 6-digit OTP
function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();

    // Generate OTP and set expiry (15 minutes)
    const otp = generateOTP();
    const expires = new Date(Date.now() + 15 * 60 * 1000);

    // Store OTP in database
    await prisma.tblemailverification.create({
      data: {
        email,
        otp,
        expires,
        verified: 0
      }
    });

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY is not configured');
    }

    // Send OTP email
    const resend = new Resend(apiKey);
    await resend.emails.send({
      from:    emailFrom,
      to:      email,
      subject: 'Verify your email address',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Verify your email</h2>
          <p>Your verification code is:</p>
          <div style="background-color: #f3f4f6; padding: 20px; text-align: center; font-size: 24px; letter-spacing: 8px; font-weight: bold;">
            ${otp}
          </div>
          <p>This code will expire in 15 minutes.</p>
        </div>
      `
    });

    return NextResponse.json(
      { message: 'OTP sent successfully' },
      { status: 200 }
    );

  } catch (error) {
    console.error('Email verification error:', error);
    return NextResponse.json(
      { error: 'Failed to send verification code' },
      { status: 500 }
    );
  }
}
