'use strict';

const z = require('zod');

const levels = ['fatal', 'error', 'warning', 'log', 'info', 'debug'];

const sentryClientSchema = z.object({
  configureScope: z.function().args(z.function()),
  Scope: z.any(),
  Handlers: z.object({
    parseRequest: z.function().args(z.function(), z.function()),
  }),
  withScope: z.function().args(z.function()),
  captureException: z.function(),
}).passthrough();

const sentryOptionsSchema = z.object({
  dsn: z.string().url().or(z.boolean()).nullable(),
}).passthrough();

module.exports = z.object({
  baseUri: z.string().url().optional(),
  trackUser: z.boolean().default(true),
  scope: z.object({
    tags: z.array(z.object({
      name: z.string(),
      value: z.any(),
    })),
    level: z.enum(levels).optional(),
    extra: z.object().optional(),
  }).optional(),
  client: z.union([
    sentryOptionsSchema,
    sentryClientSchema,
  ]),
  catchLogErrors: z.union([
    z.boolean(),
    z.array(z.string()),
  ]).default(false),
  useDomainPerRequest: z.boolean().default(false),
});
