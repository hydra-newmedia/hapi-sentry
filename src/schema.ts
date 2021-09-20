"use strict";

import { z } from "zod";

export const sentryClient = z
  .object({
    configureScope: z.function().returns(z.void()),
    Handlers: z
      .object({
        parseRequest: z.function().args(z.object({}), z.object({})),
      })
      .passthrough(),
    withScope: z.function().args(z.object({})),
    captureException: z.function().args(z.object({})),
  })
  .passthrough();

const sentryOptions = z
  .object({
    dsn: z.string().url().or(z.boolean()),
  })
  .passthrough();

export const options = z
  .object({
    baseUri: z.string().url().optional(),
    trackUser: z.boolean().default(true),
    scope: z
      .object({
        tags: z
          .object({
            name: z.string(),
            value: z.any(),
          })
          .array()
          .optional(),
        level: z.string().optional(),
        extra: z.map(z.string(), z.unknown()).optional(),
      })
      .optional(),
    client: sentryOptions.or(sentryClient),
    catchLogErrors: z.union([z.boolean(), z.string().array()]).default(false),
    useDomainPerRequest: z.boolean().default(false),
    flushTimeout: z.number().optional(),
  })
  .passthrough();
