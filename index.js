'use strict';

const { name, version } = require('./package.json');
const schema = require('./schema');

const Hoek = require('hoek');
const joi = require('joi');

exports.register = (server, options) => {
  const opts = joi.attempt(options, schema, 'Invalid hapi-sentry options:');

  let Sentry = opts.client;
  // initialize own sentry client if none passed as option
  if (opts.client.dsn) {
    Sentry = require('@sentry/node');
    Sentry.init(opts.client);
  }

  // initialize global scope if set via plugin options
  if (opts.scope) {
    Sentry.configureScope(scope => {
      if (opts.scope.tags) opts.scope.tags.forEach(tag => scope.setTag(tag.name, tag.value));
      if (opts.scope.level) scope.setLevel(opts.scope.level);
      if (opts.scope.extra) {
        Object.keys(opts.scope.extra).forEach(key => scope.setExtra(key, opts.scope.extra[key]));
      }
    });
  }
  // expose sentry client at server.plugins['hapi-sentry'].client
  server.expose('client', Sentry);

  // attach a new scope to each request for breadcrumbs/tags/extras/etc capturing
  server.ext({
    type: 'onRequest',
    method(request, h) {
      request.sentryScope = new Sentry.Scope();
      return h.continue;
    },
  });

  // catch request errors/warnings/etc (default: only errors) and capture them with sentry
  server.events.on({ name: 'request', channels: opts.channels }, async (request, event) => {
    // format a sentry event from the request and triggered event
    const sentryEvent = await Sentry.Parsers.parseError(event.error);
    Sentry.Handlers.parseRequest(sentryEvent, request.raw.req);

    // overwrite events request url if a baseUrl is provided
    if (opts.baseUri) {
      if (opts.baseUri.slice(-1) === '/') opts.baseUri = opts.baseUri.slice(0, -1);
      sentryEvent.request.url = opts.baseUri + request.path;
    }

    // set severity according to the filters channel
    sentryEvent.level = event.channel;

    // use request credentials for capturing user
    if (opts.trackUser) sentryEvent.user = request.auth && request.auth.credentials;
    if (sentryEvent.user) {
      Object.keys(sentryEvent.user) // hide credentials
        .filter(prop => /^(p(ass)?w(or)?(d|t)?|secret)?$/i.test(prop))
        .forEach(prop => delete sentryEvent.user[prop]);
    }

    // some SDK identificator
    sentryEvent.sdk = { name: 'sentry.javascript.node.hapi', version };

    // @sentry/node.captureEvent does not support scope parameter, if it's not from Sentry.Hub(?)
    Sentry.withScope(scope => { // thus use a temp scope and re-assign it
      Hoek.applyToDefaults(scope, request.sentryScope);
      Sentry.captureEvent(sentryEvent);
    });
  });

};

exports.name = name;
