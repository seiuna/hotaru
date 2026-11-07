import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  accountViewSchema,
  claimAccountRequestSchema,
  portalBindRequestSchema,
  portalChangePasswordRequestSchema,
  portalEmailChangeRequestSchema,
  portalForgotPasswordRequestSchema,
  portalLoginRequestSchema,
  portalMeResponseSchema,
  portalRefreshRequestSchema,
  portalResetPasswordRequestSchema,
  portalTokenResponseSchema,
  portalTotpDisableRequestSchema,
  portalTotpEnableRequestSchema,
  portalTotpSetupResponseSchema,
  portalUnbindRequestSchema,
  activateAccountRequestSchema,
} from '@hotaru/api-contract';
import type { AppContext } from '../../context.js';
import { clientIp, toJsonSchema, userAgentOf } from '../../http/zod-schema.js';
import { authenticatePortal, currentPortalAuth } from '../../plugins/portal.js';
import {
  activateAccount,
  bindMinecraft,
  changeEmail,
  changePassword,
  claimAccount,
  disableTotp,
  enableTotp,
  forgotPassword,
  getPortalAccount,
  loginAccount,
  refreshPortalToken,
  resetPassword,
  setupTotp,
  unbindMinecraft,
} from './service.js';

function requestMeta(request: FastifyRequest): { ip: string | null; userAgent: string | null } {
  return {
    ip: clientIp(request.headers, request.ip),
    userAgent: userAgentOf(request.headers),
  };
}

export async function registerPortalRoutes(
  app: FastifyInstance,
  _ctx: AppContext,
): Promise<void> {
  app.post(
    '/api/v1/portal/activate',
    {
      schema: {
        tags: ['portal'],
        summary: 'Create a portal account from an activation code',
        body: toJsonSchema(activateAccountRequestSchema),
        response: { 201: toJsonSchema(accountViewSchema) },
      },
    },
    async (request, reply) => {
      const ctx = request.server.ctx;
      const body = activateAccountRequestSchema.parse(request.body);
      const account = await activateAccount(ctx, body, requestMeta(request));
      reply.status(201);
      return account;
    },
  );

  app.post(
    '/api/v1/portal/claim',
    {
      schema: {
        tags: ['portal'],
        summary: 'Claim an existing Minecraft-only account with a signed claim code',
        body: toJsonSchema(claimAccountRequestSchema),
        response: { 201: toJsonSchema(accountViewSchema) },
      },
    },
    async (request, reply) => {
      const ctx = request.server.ctx;
      const body = claimAccountRequestSchema.parse(request.body);
      const account = await claimAccount(ctx, body, requestMeta(request));
      reply.status(201);
      return account;
    },
  );

  app.post(
    '/api/v1/portal/refresh',
    {
      schema: {
        tags: ['portal'],
        summary: 'Rotate a portal refresh token',
        body: toJsonSchema(portalRefreshRequestSchema),
        response: { 200: toJsonSchema(portalTokenResponseSchema) },
      },
    },
    async (request) => {
      const ctx = request.server.ctx;
      const body = portalRefreshRequestSchema.parse(request.body);
      return refreshPortalToken(ctx, body, requestMeta(request));
    },
  );

  app.post(
    '/api/v1/portal/forgot-password',
    {
      schema: {
        tags: ['portal'],
        summary: 'Request a password reset email (always 202)',
        body: toJsonSchema(portalForgotPasswordRequestSchema),
      },
    },
    async (request, reply) => {
      const ctx = request.server.ctx;
      const body = portalForgotPasswordRequestSchema.parse(request.body);
      await forgotPassword(ctx, body, requestMeta(request));
      reply.status(202);
    },
  );

  app.post(
    '/api/v1/portal/reset-password',
    {
      schema: {
        tags: ['portal'],
        summary: 'Reset a portal password with a single-use token',
        body: toJsonSchema(portalResetPasswordRequestSchema),
      },
    },
    async (request, reply) => {
      const ctx = request.server.ctx;
      const body = portalResetPasswordRequestSchema.parse(request.body);
      await resetPassword(ctx, body, requestMeta(request));
      reply.status(204);
    },
  );

  app.post(
    '/api/v1/portal/login',
    {
      schema: {
        tags: ['portal'],
        summary: 'Log in to the user portal with username and password',
        body: toJsonSchema(portalLoginRequestSchema),
        response: { 200: toJsonSchema(portalTokenResponseSchema) },
      },
    },
    async (request) => {
      const ctx = request.server.ctx;
      const body = portalLoginRequestSchema.parse(request.body);
      return loginAccount(ctx, body, requestMeta(request));
    },
  );

  app.get(
    '/api/v1/portal/me',
    {
      preHandler: authenticatePortal(),
      schema: {
        tags: ['portal'],
        summary: 'Current portal account and linked Minecraft identities',
        response: { 200: toJsonSchema(portalMeResponseSchema) },
      },
    },
    async (request) => {
      const auth = currentPortalAuth(request);
      return { account: await getPortalAccount(auth.accountId) };
    },
  );

  app.post(
    '/api/v1/portal/email',
    {
      preHandler: authenticatePortal(),
      schema: {
        tags: ['portal'],
        summary: 'Set or replace the account email',
        body: toJsonSchema(portalEmailChangeRequestSchema),
        response: { 200: toJsonSchema(portalMeResponseSchema) },
      },
    },
    async (request) => {
      const ctx = request.server.ctx;
      const auth = currentPortalAuth(request);
      const body = portalEmailChangeRequestSchema.parse(request.body);
      return { account: await changeEmail(ctx, auth.accountId, body, requestMeta(request)) };
    },
  );

  app.post(
    '/api/v1/portal/2fa/setup',
    {
      preHandler: authenticatePortal(),
      schema: {
        tags: ['portal'],
        summary: 'Generate a TOTP secret for the current account',
        response: { 200: toJsonSchema(portalTotpSetupResponseSchema) },
      },
    },
    async (request) => {
      const ctx = request.server.ctx;
      const auth = currentPortalAuth(request);
      return setupTotp(ctx, auth.accountId);
    },
  );

  app.post(
    '/api/v1/portal/2fa/enable',
    {
      preHandler: authenticatePortal(),
      schema: {
        tags: ['portal'],
        summary: 'Enable TOTP after verifying a code',
        body: toJsonSchema(portalTotpEnableRequestSchema),
        response: { 200: toJsonSchema(portalMeResponseSchema) },
      },
    },
    async (request) => {
      const ctx = request.server.ctx;
      const auth = currentPortalAuth(request);
      const body = portalTotpEnableRequestSchema.parse(request.body);
      return { account: await enableTotp(ctx, auth.accountId, body, requestMeta(request)) };
    },
  );

  app.post(
    '/api/v1/portal/2fa/disable',
    {
      preHandler: authenticatePortal(),
      schema: {
        tags: ['portal'],
        summary: 'Disable TOTP after verifying the password and a current code',
        body: toJsonSchema(portalTotpDisableRequestSchema),
        response: { 200: toJsonSchema(portalMeResponseSchema) },
      },
    },
    async (request) => {
      const ctx = request.server.ctx;
      const auth = currentPortalAuth(request);
      const body = portalTotpDisableRequestSchema.parse(request.body);
      return { account: await disableTotp(ctx, auth.accountId, body, requestMeta(request)) };
    },
  );

  app.post(
    '/api/v1/portal/bind',
    {
      preHandler: authenticatePortal(),
      schema: {
        tags: ['portal'],
        summary: 'Bind a Minecraft UUID with a one-time code',
        body: toJsonSchema(portalBindRequestSchema),
        response: { 200: toJsonSchema(portalMeResponseSchema) },
      },
    },
    async (request) => {
      const ctx = request.server.ctx;
      const auth = currentPortalAuth(request);
      const body = portalBindRequestSchema.parse(request.body);
      return { account: await bindMinecraft(ctx, auth.accountId, body.code, requestMeta(request)) };
    },
  );

  app.post(
    '/api/v1/portal/unbind',
    {
      preHandler: authenticatePortal(),
      schema: {
        tags: ['portal'],
        summary: 'Remove a Minecraft UUID from the current account',
        body: toJsonSchema(portalUnbindRequestSchema),
        response: { 200: toJsonSchema(portalMeResponseSchema) },
      },
    },
    async (request) => {
      const ctx = request.server.ctx;
      const auth = currentPortalAuth(request);
      const body = portalUnbindRequestSchema.parse(request.body);
      return {
        account: await unbindMinecraft(ctx, auth.accountId, body.uuid, requestMeta(request)),
      };
    },
  );

  app.post(
    '/api/v1/portal/password',
    {
      preHandler: authenticatePortal(),
      schema: {
        tags: ['portal'],
        summary: 'Change the portal account password',
        body: toJsonSchema(portalChangePasswordRequestSchema),
      },
    },
    async (request, reply) => {
      const ctx = request.server.ctx;
      const auth = currentPortalAuth(request);
      const body = portalChangePasswordRequestSchema.parse(request.body);
      await changePassword(ctx, auth.accountId, body, requestMeta(request));
      reply.status(204);
    },
  );
}
