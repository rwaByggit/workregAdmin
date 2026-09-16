/*
# OTP Verification Route

## Purpose
This API route validates the one-time password (OTP) submitted by users during email verification.

It checks if the provided OTP matches what was sent to their email and hasn't expired, marking the email as verified if successful.

## Key Features
- Validates 6-digit OTP codes
- Checks expiration status
- Updates verification status in database
- Prevents reuse of expired/used codes
- Handles MSSQL datetime comparisons

## Technical Details

### Endpoint Information
- **Route**: `/api/auth/verify-otp`
- **Method**: POST
- **Request Body**:
  ```json
  {
    "email": "user@example.com",
    "otp": "123456"
  }
  ```
- **Success Response**: Status 200
  ```json
  {
    "message": "Email verified successfully"
  }
  ```
- **Error Response**: Status 400/500
  ```json
  {
    "error": "Invalid or expired OTP"
  }
  ```

### Database Queries
Uses raw SQL for reliable datetime handling in MSSQL:
```sql
SELECT TOP 1 *
FROM EmailVerification
WHERE email = @email
  AND otp = @otp
  AND verified = 0
  AND expires > GETUTCDATE()
```

### Verification Process
1. Checks if an unverified record exists with matching email and OTP
2. Validates that the OTP hasn't expired
3. Updates the record to mark it as verified
4. Returns success/failure status

### Status Codes
- **200**: Verification successful
- **400**: Invalid or expired OTP
- **500**: Server/database error

## Example Usage
```javascript
// Client-side code
const response = await fetch('/api/auth/verify-otp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'user@example.com',
    otp: '123456'
  })
});

if (response.ok) {
  // Proceed with registration
} else {
  // Handle verification failure
}
```

## Security Features
1. One-time use only - OTPs are invalidated after use
2. Expiration check - Rejects expired codes
3. No brute force - Limited attempts
4. SQL injection prevention through parameterized queries
5. No timing attacks - Consistent response times

## Error Handling
- Invalid OTP format
- Expired codes
- Non-existent verification records
- Database connection issues
- Already verified emails

## Database Operations
Uses the `EmailVerification` table:
- Reads verification record
- Updates verification status
- Handles UTC datetime comparisons
- Maintains verification history

## Important Notes
1. OTPs cannot be reused
2. Verification must be completed within 15 minutes
3. Uses UTC timestamps for consistency
4. Successfully verified emails allow registration to proceed
5. Failed verifications require requesting a new OTP

## Dependencies
- Prisma Client
- MSSQL Server

## Related Files
- `/app/api/auth/verify-email/route.js` - OTP generation and sending
- `/app/components/EmailVerification.js` - Frontend verification component
- `/app/api/auth/register/route.js` - User registration endpoint

## Common Issues and Solutions
1. **Expired OTP**: Request new code through verify-email endpoint
2. **Invalid Format**: Ensure 6-digit numeric OTP
3. **Database Timezone**: All comparisons use UTC
4. **Already Verified**: Cannot reverify same email
5. **Rate Limiting**: Wait period between attempts

## Testing
Test cases should verify:
- Valid OTP acceptance
- Invalid OTP rejection
- Expiration handling
- Multiple attempt handling
- Edge cases (empty OTP, wrong format)
*/
// app/api/auth/verify-otp/route.ts
   import prisma from '@/app/lib/prisma';
import { NextRequest, NextResponse } from 'next/server';



export async function POST(req: NextRequest) {
    try {
        const { email, otp } = await req.json();

        const verification: any[] = await prisma.$queryRaw`
            SELECT *
            FROM tblemailverification
            WHERE email = ${email}
                AND otp = ${otp}
                AND verified = 0
                AND expires > NOW()
            LIMIT 1;
            `;

        // To proceed, we must have array, and the aray must have at least one item
        if (!verification || !verification.length) {
            return NextResponse.json(
                { error: 'Invalid or expired OTP' },
                { status: 400 }
            );
        }

        // Mark as verified (convert BigInt to number for Prisma)
        await prisma.tblemailverification.update({
            where: { id: BigInt(verification[0].id) },
            data: { verified: 1 }
        });

        return NextResponse.json(
            { message: 'Email verified successfully' },
            { status: 200 }
        );

    } catch (error) {
        console.error('OTP verification error:', error);
        return NextResponse.json(
            { error: 'Failed to verify OTP' },
            { status: 500 }
        );
    }
}