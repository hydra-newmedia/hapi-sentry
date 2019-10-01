'use strict';

const { name, version } = require('./package.json');
const schema = require('./schema');

const Hoek = require('@hapi/hoek');
const joi = require('@hapi/joi');

exports.register = (server, options) => {
  const opts = joi.attempt(options, schema, 'Invalid hapi-sentry options:');

  let Sentry = opts.client;
  // initialize own sentry client if none passed as option
  if (opts.client.dsn !== undefined) {
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

  // get request errors to capture them with sentry
  server.events.on({ name: 'request', channels: ['error', 'app'] }, (request, event, tags) => {
    if (event.channel === 'app' && (!tags.error || !event.error)) {
      return;
    }

    Sentry.withScope(scope => { // thus use a temp scope and re-assign it
      scope.addEventProcessor(_sentryEvent => {
        // format a sentry event from the request and triggered event
        const sentryEvent = Sentry.Handlers.parseRequest(_sentryEvent, request.raw.req);

        // overwrite events request url if a baseUrl is provided
        if (opts.baseUri) {
          if (opts.baseUri.slice(-1) === '/') opts.baseUri = opts.baseUri.slice(0, -1);
          sentryEvent.request.url = opts.baseUri + request.path;
        }

        sentryEvent.level = 'error';

        // use request credentials for capturing user
        if (opts.trackUser) sentryEvent.user = request.auth && request.auth.credentials;
        if (sentryEvent.user) {
          Object.keys(sentryEvent.user) // hide credentials
            .filter(prop => /^(p(ass)?w(or)?(d|t)?|secret)?$/i.test(prop))
            .forEach(prop => delete sentryEvent.user[prop]);
        }

        // some SDK identificator
        sentryEvent.sdk = { name: 'sentry.javascript.node.hapi', version };
        return sentryEvent;
      });

      Hoek.merge(scope, request.sentryScope);
      Sentry.captureException(event.error);
    });
  });

  server.events.on('log', (event, tags) => {
    if (!tags.error || !event.error) {
      return;
    }

    Sentry.withScope(scope => {
      scope.addEventProcessor(sentryEvent => {
        sentryEvent.level = 'error';

        // some SDK identificator
        sentryEvent.sdk = { name: 'sentry.javascript.node.hapi', version };
        return sentryEvent;
      });

      Sentry.captureException(event.error);
    });
  });
};

exports.name = name;
