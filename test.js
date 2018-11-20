'use strict';

const test = require('ava');
const hapi = require('hapi');
const defer = require('p-defer');
const plugin = require('./');

const dsn = 'https://user@sentry.io/project';

test.beforeEach(t => {
  delete global.__SENTRY__;
  t.context.server = new hapi.Server();
});

test('requires a dsn', async t => {
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
    '"dsn" is required',
  ]);
});

test('exposes the sentry client', async t => {
  const { server } = t.context;

  await server.register({
    plugin,
    options: {
      client: { dsn, beforeSend: e => e },
    },
  });

  t.is(typeof server.plugins['hapi-sentry'].client.captureException, 'function');
});

test('exposes a per-request scope', async t => {
  const { server } = t.context;

  server.route({
    method: 'GET',
    path: '/',
    handler: (request) => {
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
  });
});

test('captures request errors', async t => {
  const { server } = t.context;

  server.route({
    method: 'GET',
    path: '/',
    handler: () => {
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
  });

  const event = await deferred.promise;
  t.is(event.message, 'Error: Oh no!');
  t.is(event.level, 'error');
});

test('parses request metadata', async t => {
  const { server } = t.context;

  server.route({
    method: 'GET',
    path: '/route',
    handler: () => {
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
  });

  const { request } = await deferred.promise;
  t.is(request.method, 'GET');
  t.is(typeof request.headers, 'object');
  t.is(request.url, `http://${request.headers.host}/route`);
});

test('sanitizes user info from auth', async t => {
  const { server } = t.context;

  server.auth.scheme('mock', () => {
    return {
      authenticate: (request, h) => {
        return h.authenticated({
          credentials: {
            username: 'me',
            password: 'open sesame',
            pw: 'os',
            secret: 'abc123',
          },
        });
      },
    };
  });
  server.auth.strategy('mock', 'mock');

  server.route({
    method: 'GET',
    path: '/',
    handler: () => {
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
  });

  const event = await deferred.promise;
  t.deepEqual(event.user, { username: 'me' });
});
