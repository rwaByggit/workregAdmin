import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import prisma from '@/app/lib/prisma';
import type { Prisma } from '@prisma/client';

// Extend JWT token and Session to include the user ID and account ID
declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    accountId?: string;
  }
}

declare module "next-auth" {
  interface Session {
    user?: {
      id?: string;
      accountId?: string;
      isSystemAdmin?: boolean;
      email?: string | null;
      name?: string | null;
      image?: string | null;
    };
  }
}

function getConfiguredSysAdminEmail() {
	return (
		process.env.SYS_ADMIN_USER ||
		process.env.NEXT_PUBLIC_SYS_ADMIN_USER ||
		''
	).trim().toLowerCase();
}

type AuthUser = {
	id: bigint;
	email: string;
	fname: string | null;
	lname: string | null;
	password: string | null;
	access_level: number;
	last_activity: Date;
	failed_login_attempts?: number | null;
	account_locked_until?: Date | null;
};

async function validateUserAccountSetup(userId: bigint) {
	const linkedAccount = await prisma.tblaccountuser.findFirst({
		where: { user_id: userId },
		select: {
			account_id: true,
			tblaccount: {
				select: {
					company_name: true,
					org_number: true,
					company_phone: true,
				},
			},
		},
	});

	if (!linkedAccount?.tblaccount) {
		return;
	}

	const missingFields: string[] = [];
	if (!linkedAccount.tblaccount.company_name?.trim()) missingFields.push('company name');
	if (!linkedAccount.tblaccount.org_number?.trim()) missingFields.push('organization number');
	if (!linkedAccount.tblaccount.company_phone?.trim()) missingFields.push('phone number');

	if (missingFields.length > 0) {
		throw new Error(
			`Your linked account setup is incomplete. Please complete the following before logging in: ${missingFields.join(', ')}.`
		);
	}
}

const userIdentitySelect = {
	id: true,
	email: true,
	fname: true,
	lname: true,
};

let lockoutColumnsAvailablePromise: Promise<boolean> | null = null;

async function areLockoutColumnsAvailable() {
	if (!lockoutColumnsAvailablePromise) {
		lockoutColumnsAvailablePromise = prisma.$queryRaw<Array<{ exists: boolean }>>`
			SELECT EXISTS (
				SELECT 1
				FROM information_schema.columns
				WHERE table_schema = current_schema()
				  AND table_name = 'tbluser'
				  AND column_name IN ('failed_login_attempts', 'account_locked_until')
				GROUP BY table_name
				HAVING COUNT(DISTINCT column_name) = 2
			) AS exists
		`
			.then((rows) => Boolean(rows[0]?.exists))
			.catch((error) => {
				console.warn('Could not inspect tbluser login lockout columns; continuing without lockout tracking.', error);
				return false;
			});
	}

	return lockoutColumnsAvailablePromise;
}

async function findAuthUserByEmail(email: string, includeLockoutColumns: boolean) {
	const select = {
		id: true,
		email: true,
		fname: true,
		lname: true,
		password: true,
		access_level: true,
		last_activity: true,
		...(includeLockoutColumns
			? {
				failed_login_attempts: true,
				account_locked_until: true,
			}
			: {}),
	};

	const exactUser = await prisma.tbluser.findUnique({
		where: { email },
		select,
	}) as AuthUser | null;

	if (exactUser) {
		return exactUser;
	}

	return prisma.tbluser.findFirst({
		where: {
			email: {
				equals: email,
				mode: 'insensitive',
			},
		},
		select,
	}) as Promise<AuthUser | null>;
}



export const authOptions: NextAuthOptions = {
	providers: [
		CredentialsProvider({
			name: 'Credentials',
			credentials: {
				email: { label: 'Email', type: 'text' },
				password: { label: 'Password', type: 'password' }
			},
			async authorize(credentials) {
				if (!credentials?.email || !credentials?.password) {
					throw new Error('Email and password required');
				}

				const normalizedEmail = credentials.email.trim().toLowerCase();
				const sysAdminEmail = getConfiguredSysAdminEmail();
				const sysAdminPassword = process.env.SYS_ADMIN_PWD;
				const isSystemAdminBootstrap = Boolean(
					sysAdminEmail &&
					sysAdminPassword &&
					normalizedEmail === sysAdminEmail &&
					credentials.password === sysAdminPassword
				);
				const lockoutColumnsAvailable = await areLockoutColumnsAvailable();

				const user = await findAuthUserByEmail(normalizedEmail, lockoutColumnsAvailable);

				if (!user || !user.password) {
					if (!isSystemAdminBootstrap) {
						throw new Error('User not found');
					}

					if (!sysAdminPassword) {
						throw new Error('System admin password is not configured');
					}

					const hashedPassword = await bcrypt.hash(sysAdminPassword, 10);
					const bootstrapUpdateData: Prisma.tbluserUpdateInput = {
						password: hashedPassword,
						access_level: 1,
						last_activity: new Date(),
						...(lockoutColumnsAvailable
							? {
								failed_login_attempts: 0,
								account_locked_until: null,
							}
							: {}),
					};
					const bootstrapUser = user
						? await prisma.tbluser.update({
							where: { id: user.id },
							data: bootstrapUpdateData,
							select: userIdentitySelect,
						})
						: await prisma.tbluser.create({
							data: {
								email: normalizedEmail,
								fname: 'System',
								lname: 'Admin',
								password: hashedPassword,
								access_level: 1,
								created: new Date(),
								last_activity: new Date(),
							},
							select: userIdentitySelect,
						});

					return {
						id: bootstrapUser.id.toString(),
						email: bootstrapUser.email,
						name: `${bootstrapUser.fname || ''} ${bootstrapUser.lname || ''}`.trim()
					};
				}

				// Check if account is locked
				if (lockoutColumnsAvailable && user.account_locked_until && user.account_locked_until > new Date()) {
					const minutesRemaining = Math.ceil(
						(user.account_locked_until.getTime() - new Date().getTime()) / (1000 * 60)
					);
					throw new Error(
						`Account locked due to too many failed login attempts. Please try again in ${minutesRemaining} minute(s) or reset your password.`
					);
				}

				console.log("authOptions: Authorizing user:", user.email);
				const passwordMatch = await bcrypt.compare(credentials.password, user.password);

				if (!passwordMatch) {
					if (!lockoutColumnsAvailable) {
						throw new Error('Invalid password');
					}

					// Increment failed login attempts
					const newFailedAttempts = (user.failed_login_attempts || 0) + 1;
					const MAX_ATTEMPTS = 3;
					const LOCKOUT_DURATION_MINUTES = 30;

					// Lock account if max attempts reached
					if (newFailedAttempts >= MAX_ATTEMPTS) {
						const lockoutUntil = new Date();
						lockoutUntil.setMinutes(lockoutUntil.getMinutes() + LOCKOUT_DURATION_MINUTES);

						await prisma.tbluser.update({
							where: { id: user.id },
							data: {
								failed_login_attempts: newFailedAttempts,
								account_locked_until: lockoutUntil,
							},
							select: { id: true },
						});

						throw new Error(
							`Too many failed login attempts. Your account has been locked for ${LOCKOUT_DURATION_MINUTES} minutes. You can reset your password to unlock immediately.`
						);
					} else {
						// Just increment the counter
						await prisma.tbluser.update({
							where: { id: user.id },
							data: {
								failed_login_attempts: newFailedAttempts,
							},
							select: { id: true },
						});

						const attemptsRemaining = MAX_ATTEMPTS - newFailedAttempts;
						throw new Error(
							`Invalid password. ${attemptsRemaining} attempt(s) remaining before account lockout.`
						);
					}
				}

				// Successful login - reset failed attempts, unlock account, and update last_activity
				const loginUpdateData: Prisma.tbluserUpdateInput = {
					last_activity: new Date(),
					...(lockoutColumnsAvailable
						? {
							failed_login_attempts: 0,
							account_locked_until: null,
						}
						: {}),
				};
				await prisma.tbluser.update({
					where: { id: user.id },
					data: loginUpdateData,
					select: { id: true },
				});

				await validateUserAccountSetup(user.id);

				// Just return essential user information
				return {
					id: user.id.toString(),
					email: user.email,
					name: `${user.fname || ''} ${user.lname || ''}`.trim()
				};
			}
		})
	],
	callbacks: {
		async jwt({ token, user }) {
			// Pass user ID and fetch account ID
			if (user) {
				token.id = user.id;

				// Fetch the user's account ID
				const accountUser = await prisma.tblaccountuser.findFirst({
					where: { user_id: BigInt(user.id) },
					select: { account_id: true },
				});

				if (accountUser) {
					token.accountId = accountUser.account_id.toString();
				}
			}
			return token;
		},
		async session({ session, token }) {
			// Pass user ID and account ID to session
			if (session?.user) {
				if (!token.id) {
					delete session.user;
					return session;
				}

				const user = await prisma.tbluser.findUnique({
					where: { id: BigInt(token.id) },
					select: { id: true, email: true },
				});

				if (!user) {
					delete session.user;
					return session;
				}

				session.user.id = user.id.toString();
				session.user.email = user.email;
				session.user.accountId = token.accountId;
				session.user.isSystemAdmin = user.email.trim().toLowerCase() === getConfiguredSysAdminEmail();
			}
			return session;
		}
	},
	pages: {
		signIn:  '/login',
		signOut: '/login',
		newUser: '/register'
	},
	session: {
		strategy: 'jwt'
	},
	secret: process.env.NEXTAUTH_SECRET
};
