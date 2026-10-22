import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/mail.service';
import { AuditService } from '../common/audit.service';
import { SafeUser, toSafeUser } from '../common/user.util';
import { User, Role, UserStatus, AuthProvider } from '@prisma/client';
import {
  ActivateDto,
  ForgotPasswordDto,
  GoogleAuthDto,
  LinkGoogleDto,
  LoginDto,
  ResetPasswordDto,
  UnlinkGoogleDto,
} from './auth.dto';

interface TokenPayload {
  sub: string;
  role: Role;
  type: 'access' | 'refresh';
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwtSecret: string;
  private readonly jwtTtl: string;
  private readonly refreshTtl: string;
  private readonly isProduction: boolean;
  private readonly googleClientId?: string;
  private readonly googleClient: OAuth2Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {
    this.jwtSecret = this.config.getOrThrow<string>('JWT_SECRET');
    this.jwtTtl = this.config.get<string>('JWT_TTL', '15m');
    this.refreshTtl = this.config.get<string>('REFRESH_TOKEN_TTL', '7d');
    this.isProduction = this.config.get<string>('NODE_ENV') === 'production';
    this.googleClientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    this.googleClient = new OAuth2Client(this.googleClientId);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private setRefreshCookie(res: Response | undefined, refreshToken: string) {
    if (!res) return;
    // Keep REFRESH_COOKIE flag support; cookie is HttpOnly, SameSite=Lax, Secure in prod
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
  }

  private clearRefreshCookie(res: Response | undefined) {
    if (!res) return;
    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'lax',
      path: '/api/v1/auth',
    });
  }

  async login(dto: LoginDto, req?: Request, res?: Response) {
    const identifier = dto.identifier.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: { equals: identifier, mode: 'insensitive' } },
          { matricNo: { equals: identifier, mode: 'insensitive' } },
          { staffId: { equals: identifier, mode: 'insensitive' } },
        ],
      },
      include: { department: true },
    });

    if (!user || !user.passwordHash || !(await compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid matric number / email or password');
    }
    if (user.status !== UserStatus.active) {
      throw new UnauthorizedException(`Account is ${user.status}`);
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return this.issueTokens(user, undefined, req, res);
  }

  async refresh(
    refreshTokenInput?: string,
    req?: Request,
    res?: Response,
  ) {
    const token =
      refreshTokenInput ||
      req?.cookies?.refreshToken ||
      req?.body?.refreshToken;

    if (!token) {
      throw new UnauthorizedException('Refresh token is required');
    }

    const hashedInput = this.hashToken(token);
    const existingRecord = await this.prisma.refreshToken.findFirst({
      where: { tokenHash: hashedInput },
    });

    if (!existingRecord) {
      throw new UnauthorizedException('Refresh token not found or revoked');
    }

    // Reuse detection: If token was already revoked, revoke the entire family!
    if (existingRecord.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: existingRecord.familyId },
        data: { revokedAt: new Date() },
      });
      this.clearRefreshCookie(res);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (existingRecord.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: existingRecord.userId },
      include: { department: true },
    });

    if (!user || user.status !== UserStatus.active) {
      throw new UnauthorizedException('User is inactive or not found');
    }

    // Mark current token as revoked and rotated
    await this.prisma.refreshToken.update({
      where: { id: existingRecord.id },
      data: { revokedAt: new Date() },
    });

    // Issue new pair maintaining the family ID
    return this.issueTokens(user, existingRecord.familyId, req, res, existingRecord.id);
  }

  async logout(user: { id: string }, res?: Response) {
    await this.prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.clearRefreshCookie(res);
    return { success: true };
  }

  async activateLookup(matricNo: string) {
    const normalized = matricNo.trim().toUpperCase();
    const user = await this.prisma.user.findUnique({
      where: { matricNo: normalized },
      include: { department: true },
    });

    const isDevEnv =
      !this.isProduction && this.config.get<string>('NODE_ENV') !== 'test';
    const isDevRosterAccount =
      isDevEnv &&
      ['CSC/2026/001', 'SEN/2026/005', 'CYB/2026/012', 'IFT/2026/020'].includes(
        normalized,
      );

    // Timing-attack mitigation: run a dummy bcrypt hash if user does not qualify
    if (!user || (user.status === UserStatus.active && !isDevRosterAccount)) {
      await hash('dummy-activation-code-for-timing', 10);
      if (!this.isProduction) {
        console.log(
          `[AUTH DEV] Activation lookup for ${normalized}: ${!user ? 'student not found on roster' : 'account already active'}`,
        );
      }
      return {
        success: true,
        message: 'If the student is on the approved roster, an activation code has been sent',
      };
    }

    // Generate random 6-digit numeric activation code
    const rawCode = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await hash(rawCode, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await this.prisma.activationCode.create({
      data: {
        userId: user.id,
        codeHash,
        expiresAt,
        attempts: 0,
      },
    });

    const targetEmail = user.email || `${user.matricNo?.replaceAll('/', '').toLowerCase()}@student.foc.edu.ng`;
    await this.mail.sendActivationCode(
      targetEmail,
      isDevEnv ? `${rawCode} (or static dev bypass: CODICS)` : rawCode,
    );

    return {
      success: true,
      message: 'If the student is on the approved roster, an activation code has been sent',
    };
  }

  async activate(dto: ActivateDto, req?: Request, res?: Response) {
    const normalizedMatric = dto.matricNo.trim().toUpperCase();
    const user = await this.prisma.user.findUnique({
      where: { matricNo: normalizedMatric },
      include: { department: true },
    });

    const isDevEnv =
      !this.isProduction && this.config.get<string>('NODE_ENV') !== 'test';
    const isDevRosterAccount =
      isDevEnv &&
      ['CSC/2026/001', 'SEN/2026/005', 'CYB/2026/012', 'IFT/2026/020'].includes(
        normalizedMatric,
      );

    if (!user || (user.status === UserStatus.active && !isDevRosterAccount)) {
      await hash('dummy-for-timing', 10);
      throw new BadRequestException('Invalid or expired activation details');
    }

    const cleanInputCode = dto.activationCode.trim();
    const isDevBypass = isDevEnv && cleanInputCode.toUpperCase() === 'CODICS';

    // Find the latest active code for this user
    const latestCode = await this.prisma.activationCode.findFirst({
      where: {
        userId: user.id,
        usedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: 5 },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!latestCode && !isDevBypass) {
      await hash('dummy-for-timing', 10);
      throw new BadRequestException('Invalid or expired activation details');
    }

    if (latestCode) {
      // Increment attempts count
      await this.prisma.activationCode.update({
        where: { id: latestCode.id },
        data: { attempts: { increment: 1 } },
      });
    }

    // Check code (accepts generated 6-digit code or static dev bypass CODICS in development)
    const isMatch =
      isDevBypass ||
      (latestCode
        ? (await compare(cleanInputCode, latestCode.codeHash)) ||
          (await compare(cleanInputCode.toUpperCase(), latestCode.codeHash))
        : false);
    if (!isMatch) {
      throw new BadRequestException('Invalid or expired activation details');
    }

    // Activation succeeds: mark code as used and activate user
    const newPasswordHash = await hash(dto.password, 12);
    const updatedUser = await this.prisma.$transaction(async (tx) => {
      if (latestCode) {
        await tx.activationCode.update({
          where: { id: latestCode.id },
          data: { usedAt: new Date() },
        });
      }
      return tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: newPasswordHash,
          status: UserStatus.active,
          email: dto.email ? dto.email.trim().toLowerCase() : user.email,
          activatedAt: new Date(),
        },
        include: { department: true },
      });
    });

    if (
      updatedUser.email &&
      typeof this.mail.sendAccountApprovedNotification === 'function'
    ) {
      await this.mail
        .sendAccountApprovedNotification(updatedUser.email, {
          fullName: updatedUser.fullName,
          role: updatedUser.role,
          department: updatedUser.department?.name,
        })
        .catch(() => {});
    }

    return this.issueTokens(updatedUser, undefined, req, res);
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const id = (dto.identifier || dto.email || '').trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: { equals: id, mode: 'insensitive' } },
          { matricNo: { equals: id, mode: 'insensitive' } },
          { staffId: { equals: id, mode: 'insensitive' } },
        ],
      },
    });

    if (!user || user.status !== UserStatus.active || !user.email) {
      await hash('dummy-reset-timing', 10);
      return {
        success: true,
        message: 'If an account exists, a password reset link has been sent',
      };
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    await this.prisma.passwordReset.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    await this.mail.sendPasswordReset(user.email, rawToken);

    return {
      success: true,
      message: 'If an account exists, a password reset link has been sent',
    };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const tokenHash = this.hashToken(dto.token.trim());
    const resetRecord = await this.prisma.passwordReset.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!resetRecord) {
      throw new BadRequestException('Invalid or expired password reset token');
    }

    const newHash = await hash(dto.newPassword, 12);
    await this.prisma.$transaction(async (tx) => {
      await tx.passwordReset.update({
        where: { id: resetRecord.id },
        data: { usedAt: new Date() },
      });
      await tx.user.update({
        where: { id: resetRecord.userId },
        data: { passwordHash: newHash },
      });
      // Revoke all refresh tokens on password reset for security
      await tx.refreshToken.updateMany({
        where: { userId: resetRecord.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    return {
      success: true,
      message: 'Password has been reset successfully',
    };
  }

  async issueTokens(
    user: User & { department?: { name: string } | null },
    existingFamilyId?: string,
    req?: Request,
    res?: Response,
    replacedById?: string,
  ): Promise<{ user: SafeUser; accessToken: string; refreshToken: string; token: string }> {
    const role = this.effectiveRole(user);
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role, type: 'access' } satisfies TokenPayload,
      { secret: this.jwtSecret, expiresIn: this.jwtTtl as any },
    );

    const rawRefreshToken = `${randomBytes(40).toString('hex')}.${randomUUID()}`;
    const familyId = existingFamilyId || randomUUID();
    const tokenHash = this.hashToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const ip = req?.ip || req?.socket.remoteAddress || '127.0.0.1';
    const userAgent = req?.headers['user-agent'] || undefined;

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash,
        expiresAt,
        replacedById: replacedById || null,
        ip,
        userAgent,
      },
    });

    this.setRefreshCookie(res, rawRefreshToken);

    const safeUser = toSafeUser(user);
    safeUser.role = role;

    return {
      user: safeUser,
      accessToken,
      refreshToken: rawRefreshToken,
      token: accessToken,
    };
  }

  effectiveRole(user: {
    role: Role;
    repTermEnd?: Date | string | null;
    repTermEndDate?: string | Date | null;
    baseRole?: Role;
    staffId?: string | null;
  }): Role {
    const rawEnd = user.repTermEnd || user.repTermEndDate;
    const repEnd = rawEnd
      ? typeof rawEnd === 'string'
        ? new Date(rawEnd)
        : rawEnd
      : null;
    // Follow-up Check 2: Active assignments with nullable or absent expiry dates (repEnd === null)
    // remain active and must NOT be considered expired.
    // Expiration only takes effect if repEnd is explicitly set and in the past.
    if (user.role === Role.course_rep && repEnd && repEnd < new Date()) {
      return (user as any).baseRole || Role.student;
    }
    return user.role;
  }

  /**
   * Verifies a Google ID token with Google's public certs.
   * Validates signature, issuer, audience, expiry, and required email claims.
   */
  async verifyGoogleIdToken(idToken: string): Promise<{
    googleId: string;
    email: string;
    emailVerified: boolean;
    fullName?: string;
    avatarUrl?: string;
  }> {
    if (!idToken || typeof idToken !== 'string' || idToken.trim().length === 0) {
      throw new BadRequestException('Google ID token is required');
    }

    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: this.googleClientId,
      });

      const payload = ticket.getPayload();
      if (!payload) {
        throw new UnauthorizedException('Invalid Google ID token payload');
      }

      // Check issuer
      const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
      if (!validIssuers.includes(payload.iss)) {
        throw new UnauthorizedException(`Invalid Google token issuer: ${payload.iss}`);
      }

      // Check subject (stable Google ID)
      if (!payload.sub) {
        throw new UnauthorizedException('Google ID token missing subject claim');
      }

      // Check email and verified claim
      if (!payload.email) {
        throw new UnauthorizedException('Google ID token missing email claim');
      }

      const emailNormalized = payload.email.trim().toLowerCase();
      const emailVerified = Boolean(payload.email_verified);

      if (!emailVerified) {
        throw new UnauthorizedException('Google email is not verified by Google');
      }

      return {
        googleId: payload.sub,
        email: emailNormalized,
        emailVerified,
        fullName: payload.name,
        avatarUrl: payload.picture,
      };
    } catch (err: any) {
      this.logger.warn(`Google token verification failed: ${err?.message}`);
      if (err instanceof UnauthorizedException || err instanceof BadRequestException) {
        throw err;
      }
      throw new UnauthorizedException(`Google token verification failed: ${err?.message || 'Invalid token'}`);
    }
  }

  /**
   * Main Google authentication entrypoint.
   * Handles:
   * 1. Existing user with bound googleId -> logs in directly.
   * 2. Existing user matching email but unlinked -> requires proof-of-control (returns NEEDS_LINKING).
   * 3. Google ID already bound to a different email -> rejected (duplicate identity conflict).
   * 4. New Google user not in system -> returns NEEDS_ONBOARDING (does not grant unauthenticated access).
   */
  async googleAuth(
    dto: GoogleAuthDto,
    req?: Request,
    res?: Response,
  ): Promise<
    | { action: 'LOGIN_SUCCESS'; tokens: { user: SafeUser; accessToken: string; refreshToken: string; token: string } }
    | { action: 'NEEDS_LINKING'; email: string; googleId: string; message: string }
    | { action: 'NEEDS_ONBOARDING'; email: string; fullName?: string; googleId: string; message: string }
  > {
    const verified = await this.verifyGoogleIdToken(dto.idToken);

    // 1. Check if user already exists with this exact googleId
    const userByGoogleId = await this.prisma.user.findUnique({
      where: { googleId: verified.googleId },
      include: { department: true },
    });

    if (userByGoogleId) {
      if (userByGoogleId.status !== UserStatus.active) {
        throw new UnauthorizedException(`Account is ${userByGoogleId.status}`);
      }

      await this.prisma.user.update({
        where: { id: userByGoogleId.id },
        data: {
          lastLoginAt: new Date(),
          avatarUrl: verified.avatarUrl || userByGoogleId.avatarUrl,
        },
      });

      const tokens = await this.issueTokens(userByGoogleId, undefined, req, res);
      return {
        action: 'LOGIN_SUCCESS',
        tokens,
      };
    }

    // 2. Check if user exists with matching normalized email
    const userByEmail = await this.prisma.user.findFirst({
      where: { email: { equals: verified.email, mode: 'insensitive' } },
      include: { department: true },
    });

    if (userByEmail) {
      // User has an existing CODICS account.
      // MANDATORY SECURITY RULE: Never auto-link solely on email match.
      // Return NEEDS_LINKING so client challenges for password proof of control.
      return {
        action: 'NEEDS_LINKING',
        email: verified.email,
        googleId: verified.googleId,
        message: 'An existing account was found for this email. Please authenticate with your password to link your Google identity.',
      };
    }

    // 3. Completely new Google identity with no matching CODICS account
    // Academic authorization cannot be inferred from personal Gmail.
    // Return NEEDS_ONBOARDING so client guides them to fast-track admissions matching or staff invitation.
    return {
      action: 'NEEDS_ONBOARDING',
      email: verified.email,
      fullName: verified.fullName,
      googleId: verified.googleId,
      message: 'No existing CODICS account matches this Google identity. Please proceed to student onboarding or accept a staff invitation.',
    };
  }

  /**
   * Links a Google identity to an existing CODICS account with mandatory proof of control (password verification).
   * Prevents Account Takeover (ATO) and ensures 1:1 binding.
   */
  async linkGoogleAccount(
    dto: LinkGoogleDto,
    req?: Request,
    res?: Response,
  ) {
    const verified = await this.verifyGoogleIdToken(dto.idToken);

    // Find the targeted existing account by identifier (email, matricNo, or staffId)
    const identifier = dto.identifier.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: { equals: identifier, mode: 'insensitive' } },
          { matricNo: { equals: identifier, mode: 'insensitive' } },
          { staffId: { equals: identifier, mode: 'insensitive' } },
        ],
      },
      include: { department: true },
    });

    if (!user) {
      throw new NotFoundException('Target account not found');
    }

    // Proof of control: verify existing account password
    if (!user.passwordHash || !(await compare(dto.password, user.passwordHash))) {
      await this.audit.log(
        { id: user.id, fullName: user.fullName, role: user.role },
        'GOOGLE_ACCOUNT_LINK_FAILED',
        'User',
        user.id,
        'Invalid password during Google account linking attempt',
      );
      throw new UnauthorizedException('Invalid credentials for the target account');
    }

    if (user.status !== UserStatus.active) {
      throw new UnauthorizedException(`Target account is ${user.status}`);
    }

    // Invariant: One Google identity cannot be linked to multiple CODICS accounts
    const existingBound = await this.prisma.user.findUnique({
      where: { googleId: verified.googleId },
    });
    if (existingBound && existingBound.id !== user.id) {
      throw new ConflictException('This Google identity is already linked to another CODICS account');
    }

    // Invariant: If user already has a different googleId linked, require explicit unlink first
    if (user.googleId && user.googleId !== verified.googleId) {
      throw new ConflictException('This CODICS account is already linked to a different Google identity. Please unlink it first.');
    }

    // Update user with bound googleId
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        googleId: verified.googleId,
        googleEmail: verified.email,
        authProvider: AuthProvider.google_linked,
        avatarUrl: verified.avatarUrl || user.avatarUrl,
        lastLoginAt: new Date(),
      },
      include: { department: true },
    });

    await this.audit.log(
      { id: user.id, fullName: user.fullName, role: user.role },
      'GOOGLE_ACCOUNT_LINKED',
      'User',
      user.id,
      `Linked Google identity (${verified.googleId})`,
    );

    return this.issueTokens(updated, undefined, req, res);
  }

  /**
   * Unlinks Google identity from an authenticated user's profile after verifying their password.
   * Ensures the user has a local password so they are never locked out.
   */
  async unlinkGoogleAccount(
    currentUser: { id: string },
    dto: UnlinkGoogleDto,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: currentUser.id },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.googleId) {
      throw new BadRequestException('No Google identity is currently linked to this account');
    }

    if (!user.passwordHash || !(await compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid password verification to unlink Google identity');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        googleId: null,
        googleEmail: null,
        authProvider: AuthProvider.local,
      },
    });

    // Revoke all refresh tokens on security change
    await this.prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.audit.log(
      { id: user.id, fullName: user.fullName, role: user.role },
      'GOOGLE_ACCOUNT_UNLINKED',
      'User',
      user.id,
      'Unlinked Google identity',
    );

    return {
      success: true,
      message: 'Google identity unlinked successfully',
    };
  }
}
