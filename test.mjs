/* eslint-disable import/no-extraneous-dependencies */
// eslint-disable-next-line import/no-unresolved
import test from 'ava';
import hapi from '@hapi/hapi';
import * as Sentry from '@sentry/node';
import defer from 'p-defer';

// eslint-disable-next-line import/extensions
import plugin from './index.js';

const dsn = 'https://examplePublicKey@o0.ingest.sentry.io/0';

const sentryTestClient = (beforeSend) => {
  Sentry.init({ dsn, beforeSend });
  return Sentry;
};

test.beforeEach(t => {
  delete global.__SENTRY__;
  t.context.server = new hapi.Server();
});

test('requires a dsn or a Scope (sentry opts vs. sentry client)', async t => {
  const { server } = t.context;
  const err = await t.throwsAsync(() => server.register({
    plugin,
    options: { client: null },
  }), {
    name: 'ValidationError',
    message: /Invalid hapi-sentry options/,
  });

  t.deepEqual(err.details.map(d => d.message), [
    '"client" must be of type object',
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
  Sentry.init({ dsn: null, beforeSend: deferred.resolve });

  await t.notThrowsAsync(() => server.register({
    plugin,
    options: {
      client: Sentry,
    },
  }));

  await server.inject({
    method: 'GET',
    url: '/',
  });

  let eventCaptured = false;
  deferred.promise.then(() => {
    eventCaptured = true;
  });

  // wait for sentry event possibly to be sent
  await new Promise(resolve => {
    setTimeout(resolve, 20);
  });
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
    Scope: class Scope {},
    getCurrentHub() {
      return {
        getScope() {
          return {};
        },
      };
    },
    // arity needed to pass joi validation
    Handlers: { parseRequest: (x, y) => { } }, // eslint-disable-line no-unused-vars
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
  });

  const event = await deferred.promise;
  t.is(event, error);
});

test('exposes the sentry client', async t => {
  const { server } = t.context;

  await server.register({
    plugin,
    options: {
      client: sentryTestClient(),
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
      client: sentryTestClient(),
    },
  });

  await server.inject({
    method: 'GET',
    url: '/',
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
      client: sentryTestClient(deferred.resolve),
    },
  });

  await server.inject({
    method: 'GET',
    url: '/',
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
      client: sentryTestClient(deferred.resolve),
    },
  });

  await server.inject({
    method: 'GET',
    url: '/route',
  });

  const { request } = await deferred.promise;
  t.is(request.method, 'GET');
  t.is(typeof request.headers, 'object');
  t.is(request.url, `http://${request.headers.host}/route`);
});

test('sanitizes user info from auth', async t => {
  const { server } = t.context;

  server.auth.scheme('mock', () => ({
    authenticate(_, h) {
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
      client: sentryTestClient(deferred.resolve),
    },
  });

  await server.inject({
    method: 'GET',
    url: '/',
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
      client: sentryTestClient(deferred.resolve),
      catchLogErrors: true,
    },
  });

  await server.inject({
    method: 'GET',
    url: '/route',
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
      client: sentryTestClient(deferred.resolve),
      catchLogErrors: ['exception', 'failure'],
    },
  });

  await server.inject({
    method: 'GET',
    url: '/route',
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
      client: sentryTestClient(deferred.resolve),
      catchLogErrors: true,
    },
  });

  await server.inject({
    method: 'GET',
    url: '/route',
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
      client: sentryTestClient(deferred.resolve),
      catchLogErrors: ['exception', 'failure'],
    },
  });

  await server.inject({
    method: 'GET',
    url: '/route',
  });

  const event = await deferred.promise;
  t.is(event.exception.values[0].value, 'Oh no!');
  t.is(event.exception.values[0].type, 'Error');
});
