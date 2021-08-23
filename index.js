'use strict';

const Hoek = require('@hapi/hoek');
const joi = require('joi');
const domain = require('domain');
const eventsIntercept = require('events-intercept');

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

  eventsIntercept.patch(server.listener)

  const interceptor = (req, res, done) => {
    const local = domain.create() // Create domain to hold context for request
    local.enter()
    local.add(req)
    local.add(res)

    let rtn = undefined

    local.run(() => { // Create new scope for request
      const currentHub = Sentry.getCurrentHub();

      currentHub.configureScope(scope => {
        scope.addEventProcessor(_sentryEvent => {
          // format a sentry event from the request and triggered event
          const sentryEvent = Sentry.Handlers.parseRequest(_sentryEvent, req);

          // overwrite events request url if a baseUrl is provided
          if (opts.baseUri) {
            if (opts.baseUri.slice(-1) === '/') opts.baseUri = opts.baseUri.slice(0, -1);
            sentryEvent.request.url = opts.baseUri + request.path;
          }

          // some SDK identifier
          sentryEvent.sdk = { name: 'sentry.javascript.node.hapi', version };
          return sentryEvent;
        });
      })
      rtn = done(null, req, res)
    });

    return rtn
  }

  server.listener.intercept('request', interceptor)
  server.listener.intercept('checkContinue', interceptor)

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

    Sentry.captureException(event.error);
  });

  if (opts.catchLogErrors) {
    server.events.on({ name: 'log', channels: ['app'] }, event => {
      if (!event.error) return; // no error, just a log message
      if (event.tags.some(tag => errorTags.includes(tag)) === false) return; // no matching tag

      Sentry.captureException(event.error);
    });
  }
};

exports.name = name;
