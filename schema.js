'use strict';

const { Severity } = require('@sentry/node');
const joi = require('joi');

const levels = Object.values(Severity).filter(level => typeof level === 'string')
  || ['fatal', 'error', 'warning', 'log', 'info', 'debug', 'critical'];

const sentryClient = joi.object().keys({
  configureScope: joi.func().minArity(1),
  Scope: joi.func().required(),
  Parsers: joi.object().keys({
    parseError: joi.func().minArity(1).required(),
  }).unknown().required(),
  Handlers: joi.object().keys({
    parseRequest: joi.func().minArity(2).required(),
  }).unknown().required(),
  withScope: joi.func().minArity(1).required(),
  captureEvent: joi.func().minArity(1).required(),
}).unknown();

const sentryOptions = joi.object().keys({
  dsn: joi.string().uri().allow(false).required(),
}).unknown();

module.exports = joi.object().keys({
  baseUri: joi.string().uri(),
  channels: joi.array().items(joi.string().only(levels)).single().default('error'),
  trackUser: joi.boolean().default(true),
  scope: joi.object().keys({
    tags: joi.array().items(joi.object().keys({
      name: joi.string().required(),
      value: joi.any().required(),
    })),
    level: joi.string().only(levels),
    extra: joi.object(),
  }),
  client: joi.alternatives().try([sentryOptions, sentryClient]).required(),
});
