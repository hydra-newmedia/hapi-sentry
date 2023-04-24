'use strict';

const joi = require('joi');

const levels = ['fatal', 'error', 'warning', 'log', 'info', 'debug'];

const sentryClient = joi.object().keys({
  configureScope: joi.function().minArity(1),
  Scope: joi.function().required(),
  Handlers: joi.object().keys({
    parseRequest: joi.function().minArity(2).required(),
  }).unknown().required(),
  withScope: joi.function().minArity(1).required(),
  captureException: joi.function().minArity(1).required(),
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
  client: sentryClient,
  catchLogErrors: joi.alternatives().try(
    joi.boolean(),
    joi.array().items(joi.string()),
  ).default(false),
  useDomainPerRequest: joi.boolean().default(false),
});
