'use strict';

// Domain is deprecated, but Sentry relies on it
const domain = require('domain'); // eslint-disable-line node/no-deprecated-api
const joi = require('joi');
const shimmer = require('shimmer');
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

  // Set up request interceptor for creating and destroying a domain on each request
  // It'll intercept events emitted by the Hapi `server.listener` which is a `http.Server`
  // eventEmitter. This allows us to to create a domain before any of HAPIs processing starts
  // thus allowing us to use the normal HAPI extensions to add context to Sentry scopes.
  function interceptor(next, req, res, ...args) {
    const local = domain.create(); // Create domain to hold context for request
    local.add(req);
    local.add(res);

    // The interceptor will call the original function being either intercepted or wrapped
    // that function should only ever return `undefined` but it's good practice to always
    // capture that value and pass it back upstream, just in case our original function
    // decides to start returning something other than `undefined` in the future.
    //
    // We need to declare it here, because the body of our interceptor runs inside
    // an anonymous function wrapped by the `domain` run function. So this declaration
    // ensures we can pull the value out of anonymous function's scope and actually
    // return it.
    let originalFuncReturnValue;

    local.run(() => { // Create new scope for request
      const currentHub = Sentry.getCurrentHub();

      currentHub.configureScope(scope => {
        scope.addEventProcessor(_sentryEvent => {
          // format a sentry event from the request and triggered event
          const sentryEvent = Sentry.Handlers.parseRequest(_sentryEvent, req);

          // overwrite events request url if a baseUrl is provided
          if (opts.baseUri) {
            if (opts.baseUri.slice(-1) === '/') opts.baseUri = opts.baseUri.slice(0, -1);
            sentryEvent.request.url = opts.baseUri + req.path;
          }

          // some SDK identifier
          sentryEvent.sdk = { name: 'sentry.javascript.node.hapi', version };
          return sentryEvent;
        });
      });

      // Capture return value here
      originalFuncReturnValue = next.apply(this, [null, req, res].concat(args));
    });

    return originalFuncReturnValue;
  }

  // Wrap HAPI core _dispatch function. It's a factory that returns Node request listeners.
  // We need to wrap it to make Hapi's `server.inject()` API work, but the wrapped function
  // isn't involved in normal request handling.
  //
  // Normal requests are intercepted before they get to the `_dispatch` function, and never pass
  // through our wrapped `_dispatch` function because Hapi uses `_dispatch` function and binds
  // the created request listeners to the eventEmitter before we have an opportunity to wrap it.
  //
  // https://github.com/hapijs/hapi/blob/c95985e225fa09c4b640a887ccb4be46dbe265bc/lib/core.js#L505-L539
  //
  // We only wrap if it hasn't already been wrapped (as indicated by `__wrapped`)
  if (server._core && server._core._dispatch && !server._core._dispatch.__wrapped) {
    shimmer.wrap(server._core, '_dispatch', function (original) { // eslint-disable-line

      // Wrapper for `_dispatch`
      return function _dispatch_wrapped(...dispatchArgs) { // eslint-disable-line
        // Call the original `_dispatch` function to get a request listener because we actually want
        // to intercept calls to the listener, rather than to `_dispatch` itself.
        const listener = original.apply(this, dispatchArgs);

        // Create a `next` function compatible with our interceptor function.
        // It simply extracts the err value and throws it away, passing the remaining arguments to
        // the original listener.
        // It safe to do this because our interceptor function never calls `next` with an error, it
        // always passes null. Doing so because it's a requirement of the `eventInterceptor` library
        function next(err, ...args) {
          listener.apply(this, args);
        }

        // Bind the interceptor, to `this` and `next` so when the interceptor is called with a
        // request it runs in the context that Hapi intended it to. Additionally the first argument
        // to the interceptor will be `next`, followed by whatever arguments the original caller
        // passes.
        return interceptor.bind(this, next);
      };
    });
  }

  // Setup listener interceptors so we can intercept inbound requests from Node, needed
  // because we can't patch HAPI before it sets up listeners
  eventsIntercept.patch(server.listener);
  server.listener.intercept('request', function _requestInterceptor(...args) {
    // Rearrange incoming arguments. The `eventsInterceptor` sends us arguments in the following
    // order: `func(origArg1, ..., origArgN, nextFunc)` but we want the `nextFunc` to be first

    // `func(origArg1, ..., origArgN, nextFunc)` -> `func(nextFunc, origArg1, ..., origArgN)`
    interceptor.apply(this, [args[args.length - 1], ...args.slice(0, -1)]);
  });
  server.listener.intercept('checkContinue', function _checkContinueInterceptor(...args) {
    // `func(origArg1, ..., origArgN, nextFunc)` -> `func(nextFunc, origArg1, ..., origArgN)`
    interceptor.apply(this, [args[args.length - 1], ...args.slice(0, -1)]);
  });

  server.ext([
    {
      type: 'onRequest',
      method: (request, h) => {
        // To maintain backwards compatibility attached the Hub scope to the request
        request.sentryScope = Sentry.getCurrentHub().getScope();
        return h.continue;
      },
    },
    {
      type: 'onCredentials',
      method: (request, h) => {
        Sentry.configureScope(scope => {
          // use request credentials for current scope
          if (opts.trackUser && request.auth && request.auth.credentials) {
            const creds = { ...request.auth.credentials };
            Object.keys(creds) // hide credentials
              .filter(prop => /^(p(ass)?w(or)?(d|t)?|secret)?$/i.test(prop))
              .forEach(prop => delete creds[prop]);
            scope.setUser(creds);
          }
        });

        return h.continue;
      },
    }]);

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
