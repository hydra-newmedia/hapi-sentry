'use strict';

const { Severity } = require('@sentry/node');
const joi = require('@hapi/joi');

const levels = Object.values(Severity).filter(level => typeof level === 'string')
  || ['fatal', 'error', 'warning', 'log', 'info', 'debug', 'critical'];

const sentryClient = joi.object().keys({
  configureScope: joi.function().minArity(1),
  Scope: joi.function().required(),
  Handlers: joi.object().keys({
    parseRequest: joi.function().minArity(2).required(),
  }).unknown().required(),
  withScope: joi.function().minArity(1).required(),
  captureException: joi.function().minArity(1).required(),
}).unknown();

const sentryOptions = joi.object().keys({
  dsn: joi.string().uri().allow(false).required(),
}).unknown();

module.exports = joi.object().keys({
  baseUri: joi.string().uri(),
  trackUser: joi.boolean().default(true),
  scope: joi.object().keys({
    tags: joi.array().items(joi.object().keys({
      name: joi.string().required(),
      value: joi.any().required(),
    })),
    level: joi.string().valid(...levels),
    extra: joi.object(),
  }),
  client: joi.alternatives().try(sentryOptions, sentryClient).required(),
  catchLogErrors: joi.alternatives().try(
    joi.boolean(),
    joi.array().items(joi.string()),
  ).default(false),
  useDomainPerRequest: joi.boolean().default(false),
});
