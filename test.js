/* eslint-disable max-classes-per-file */
/* eslint import/no-extraneous-dependencies: ["error", {"devDependencies": true}] */
/* eslint-disable node/no-unpublished-require */

'use strict';

const test = require('ava');
const hapi = require('@hapi/hapi');
const defer = require('p-defer');
const Sentry = require('@sentry/node');

const plugin = require('.');

const dsn = 'https://examplePublicKey@o0.ingest.sentry.io/0';

test.beforeEach(t => {
  delete global.__SENTRY__;
  // Sentry does some patching to the __SENTRY__ global on import
  // we need that patching to be reapplied after deleting the global
  // or domain stuff doesn't work. To do this we first remove sentry
  // from the node module cache, then re-import.
  delete require.cache[require.resolve('@sentry/node')];
  require('@sentry/node'); // eslint-disable-line global-require
  t.context.server = new hapi.Server();
});

test('requires a dsn or a Scope (sentry opts vs. sentry client)', async t => {
  const { server } = t.context;
  const err = await t.throwsAsync(() => server.register({
    plugin,
    options: {
      client: {},
    },
  }), {
    name: 'ValidationError',
    message: /Invalid hapi-sentry options/,
  });

  t.deepEqual(err.details.map(d => d.message), [
    '"client" does not match any of the allowed types',
  ]);
});

test('allows deactivating capture (opts.dsn to be false)', async t => {
  const { server } = t.context;

  server.route({
    method: 'GET',
    path: '/',
    handler() {
      throw new Error('Oh no!');
    },
  });

  const deferred = defer();
  await t.notThrowsAsync(() => server.register({
    plugin,
    options: {
      client: {
        dsn: false,
        beforeSend: deferred.resolve,
      },
    },
  }));

  await server.inject({
    method: 'GET',
    url: '/',
    payload: t.title,
  });

  let eventCaptured = false;
  deferred.promise.then(() => {
    eventCaptured = true;
  });

  // wait for sentry event possibly to be sent
  await new Promise(resolve => setTimeout(resolve, 20));
  t.is(eventCaptured, false);
});

test('uses a custom sentry client', async t => {
  const { server } = t.context;

  const error = new Error('Error to be thrown');

  server.route({
    method: 'GET',
    path: '/route',
    handler() {
      throw error;
    },
  });

  const deferred = defer();
  const customSentry = {
    Scope: class Scope { },
    getCurrentHub() {
      return {
        getScope() {
          return {};
        },
        configureScope() {
          return null;
        },
      };
    },
    // arity needed to pass joi validation
    Handlers: { parseRequest: (_x, _y) => { } }, // eslint-disable-line no-unused-vars
    withScope: cb => cb({ addEventProcessor: () => { } }),
    captureException: deferred.resolve,
  };

  // check exposing of custom client
  await server.register({
    plugin,
    options: {
      client: customSentry,
    },
  });

  t.deepEqual(server.plugins['hapi-sentry'].client, customSentry);

  // check if custom sentry is used per request
  await server.inject({
    method: 'GET',
    url: '/route',
    payload: t.title,
  });

  const event = await deferred.promise;
  t.is(event, error);
});

test('exposes the sentry client', async t => {
  const { server } = t.context;

  await server.register({
    plugin,
    options: {
      client: { dsn },
    },
  });

  t.is(typeof server.plugins['hapi-sentry'].client.captureException, 'function');
});

test('exposes a per-request scope', async t => {
  const { server } = t.context;

  server.route({
    method: 'GET',
    path: '/',
    handler(request) {
      t.is(typeof request.sentryScope.setTag, 'function');
      return null;
    },
  });

  await server.register({
    plugin,
    options: {
      client: { dsn },
    },
  });

  await server.inject({
    method: 'GET',
    url: '/',
    payload: t.title,
  });
});

test('captures request errors', async t => {
  const { server } = t.context;

  server.route({
    method: 'GET',
    path: '/',
    handler() {
      throw new Error('Oh no!');
    },
  });

  const deferred = defer();
  await server.register({
    plugin,
    options: {
      client: {
        dsn,
        beforeSend: deferred.resolve,
      },
    },
  });

  await server.inject({
    method: 'GET',
    url: '/',
    payload: t.title,
  });

  const event = await deferred.promise;
  t.is(event.exception.values[0].value, 'Oh no!');
  t.is(event.exception.values[0].type, 'Error');
});

test('parses request metadata', async t => {
  const { server } = t.context;

  server.route({
    method: 'GET',
    path: '/route',
    handler() {
      throw new Error('Oh no!');
    },
  });

  const deferred = defer();
  await server.register({
    plugin,
    options: {
      client: {
        dsn,
        beforeSend: deferred.resolve,
      },
    },
  });

  await server.inject({
    method: 'GET',
    url: '/route',
    payload: t.title,
  });

  const { request } = await deferred.promise;
  t.is(request.method, 'GET');
  t.is(typeof request.headers, 'object');
  t.is(request.url, `http://${request.headers.host}/route`);
});

test('sanitizes user info from auth', async t => {
  const { server } = t.context;

  server.auth.scheme('mock', () => ({
    authenticate(_request, h) {
      return h.authenticated({
        credentials: {
          username: 'me',
          password: 'open sesame',
          pw: 'os',
          secret: 'abc123',
        },
      });
    },
  }));
  server.auth.strategy('mock', 'mock');

  server.route({
    method: 'GET',
    path: '/',
    handler() {
      throw new Error('Oh no!');
    },
    config: {
      auth: 'mock',
    },
  });

  const deferred = defer();
  await server.register({
    plugin,
    options: {
      client: {
        dsn,
        beforeSend: deferred.resolve,
      },
    },
  });

  await server.inject({
    method: 'GET',
    url: '/',
    payload: t.title,
  });

  const event = await deferred.promise;
  t.deepEqual(event.user, { username: 'me' });
});

test('process \'app\' channel events with default tags', async t => {
  const { server } = t.context;

  server.route({
    method: 'GET',
    path: '/route',
    handler(request) {
      request.log(['error', 'foo'], new Error('Oh no!'));
      return null;
    },
  });

  const deferred = defer();
  await server.register({
    plugin,
    options: {
      client: {
        dsn,
        beforeSend: deferred.resolve,
      },
      catchLogErrors: true,
    },
  });

  await server.inject({
    method: 'GET',
    url: '/route',
    payload: t.title,
  });

  const event = await deferred.promise;
  t.is(event.exception.values[0].value, 'Oh no!');
  t.is(event.exception.values[0].type, 'Error');
});

test('process \'app\' channel events with `catchLogErrors` tags', async t => {
  const { server } = t.context;

  server.route({
    method: 'GET',
    path: '/route',
    handler(request) {
      request.log('exception', new Error('Oh no!'));
      return null;
    },
  });

  const deferred = defer();
  await server.register({
    plugin,
    options: {
      client: {
        dsn,
        beforeSend: deferred.resolve,
      },
      catchLogErrors: ['exception', 'failure'],
    },
  });

  await server.inject({
    method: 'GET',
    url: '/route',
    payload: t.title,
  });

  const event = await deferred.promise;
  t.is(event.exception.values[0].value, 'Oh no!');
  t.is(event.exception.values[0].type, 'Error');
});

test('process \'log\' events with default tags', async t => {
  const { server } = t.context;

  server.route({
    method: 'GET',
    path: '/route',
    handler() {
      server.log(['error', 'foo'], new Error('Oh no!'));
      return null;
    },
  });

  const deferred = defer();
  await server.register({
    plugin,
    options: {
      client: {
        dsn,
        beforeSend: deferred.resolve,
      },
      catchLogErrors: true,
    },
  });

  await server.inject({
    method: 'GET',
    url: '/route',
    payload: t.title,
  });

  const event = await deferred.promise;
  t.is(event.exception.values[0].value, 'Oh no!');
  t.is(event.exception.values[0].type, 'Error');
});

test('process \'log\' events with `catchLogErrors` tags', async t => {
  const { server } = t.context;

  server.route({
    method: 'GET',
    path: '/route',
    handler() {
      server.log('exception', new Error('Oh no!'));
      return null;
    },
  });

  const deferred = defer();
  await server.register({
    plugin,
    options: {
      client: {
        dsn,
        beforeSend: deferred.resolve,
      },
      catchLogErrors: ['exception', 'failure'],
    },
  });

  await server.inject({
    method: 'GET',
    url: '/route',
    payload: t.title,
  });

  const event = await deferred.promise;
  t.is(event.exception.values[0].value, 'Oh no!');
  t.is(event.exception.values[0].type, 'Error');
});

test('request scope separation', async t => {
  const { server } = t.context;

  let remaining = 3;
  const deferred = defer();

  class DummyTransport {
    // eslint-disable-next-line class-methods-use-this
    sendEvent() {
      remaining -= 1;

      if (remaining === 0) {
        deferred.resolve();
      }

      return Promise.resolve({
        status: 'success',
      });
    }
  }

  await server.register({
    plugin,
    options: {
      client: {
        dsn,
        transport: DummyTransport,
        beforeSend: (event) => {
          if (event.transaction === 'GET /one') {
            t.deepEqual(event.tags,
              {
                globalTag: 'global',
                oneTag: '👋',
              });
          } else if (event.transaction === 'GET /two') {
            t.deepEqual(event.tags,
              {
                globalTag: 'global',
                twoTag: '👋',
              });
          } else if (event.transaction === 'GET /three') {
            t.deepEqual(event.tags,
              {
                globalTag: 'global',
                threeTag: '👋',
              });
          } else {
            t.fail(`Unknown transaction ${event.transaction}`);
          }
          return event;
        },
      },
    },
  });

  Sentry.configureScope(scope => {
    scope.setTag('globalTag', 'global');
  });

  server.route({
    method: 'GET',
    path: '/one',
    handler() {
      Sentry.configureScope(scope => {
        scope.setTag('oneTag', '👋');
      });

      throw new Error('one');
    },
  });

  server.route({
    method: 'GET',
    path: '/two',
    handler() {
      Sentry.configureScope(scope => {
        scope.setTag('twoTag', '👋');
      });

      throw new Error('two');
    },
  });

  server.route({
    method: 'GET',
    path: '/three',
    handler() {
      Sentry.configureScope(scope => {
        scope.setTag('threeTag', '👋');
      });

      throw new Error('three');
    },
  });

  await Promise.all([
    server.inject({
      method: 'GET',
      url: '/one',
      payload: t.title,
    }),
    server.inject({
      method: 'GET',
      url: '/two',
    }),
    server.inject({
      method: 'GET',
      url: '/three',
    }),
  ]);

  // Will cause test to time out if not fired
  await deferred.promise;
});
