'use strict';

const Hoek = require('@hapi/hoek');
const joi = require('joi');
const domain = require('domain');

const { name, version } = require('./package.json');
const schema = require('./schema');

exports.register = (server, options) => {
  const opts = joi.attempt(options, schema, 'Invalid hapi-sentry options:');

  let Sentry = opts.client;
  // initialize own sentry client if none passed as option
  if (opts.client.dsn !== undefined) {
    // eslint-disable-next-line global-require
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

  server.ext({
    type: 'onRequest',
    method(request, h) {
      if (opts.useDomainPerRequest) {
        // Sentry looks for current hub in active domain
        // Therefore simply by creating&entering domain Sentry will create
        // request scoped hub for breadcrumps and other scope metadata
        request.__sentryDomain = domain.create();
        request.__sentryDomain.enter();
      }

      // attach a new scope to each request for breadcrumbs/tags/extras/etc capturing
      request.sentryScope = new Sentry.Scope();

      return h.continue;
    },
  });

  let errorTags = ['error', 'fatal', 'fail'];
  if (opts.catchLogErrors && Array.isArray(opts.catchLogErrors)) {
    errorTags = opts.catchLogErrors;
  }

  const channels = ['error'];
  // also listen for app events to get log messages
  if (opts.catchLogErrors) channels.push('app');

  // get request errors to capture them with sentry
  server.events.on({ name: 'request', channels }, (request, event) => {
    // check for errors in request logs
    if (event.channel === 'app') {
      if (!event.error) return; // no error, just a log message
      if (event.tags.some(tag => errorTags.includes(tag)) === false) return; // no matching tag
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

  if (opts.useDomainPerRequest) {
    server.events.on('response', request => {
      if (request.__sentryDomain) {
        // exiting domain, not sure if thats necessary, hard to find definitive answer,
        // but its safer to prevent potentional memory leaks
        request.__sentryDomain.exit();
      }
    });
  }

  if (opts.catchLogErrors) {
    server.events.on({ name: 'log', channels: ['app'] }, event => {
      if (!event.error) return; // no error, just a log message
      if (event.tags.some(tag => errorTags.includes(tag)) === false) return; // no matching tag

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
  }
};

exports.name = name;
