'use strict';

const test = require('ava');
const hapi = require('@hapi/hapi');
const defer = require('p-defer');
const delay = require('delay');

const plugin = require('./');

const dsn = 'https://user@sentry.io/project';

test.beforeEach(t => {
  delete global.__SENTRY__;
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
  });

  let eventCaptured = false;
  deferred.promise.then(() => eventCaptured = true);

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
  });

  const { request } = await deferred.promise;
  t.is(request.method, 'GET');
  t.is(typeof request.headers, 'object');
  t.is(request.url, `http://${request.headers.host}/route`);
});

// sorry for console.log being the easiest way to set breadcrumbs
test('collects breadcrumbs per domain', async t => {
  const { server } = t.context;


  server.route({
    method: 'GET',
    path: '/route1',
    async handler() {
      await delay(400);
      clearInterval(interval);
      throw new Error('Error 1');
    },
  });

  server.route({
    method: 'GET',
    path: '/route2',
    async handler() {
      await delay(200);
      console.log('domain breadcrumb');
      throw new Error('Error 2');
    },
  });

  const deferred1 = defer();
  const deferred2 = defer();
  await server.register({
    plugin,
    options: {
      useDomainPerRequest: true,
      client: {
        dsn,
        beforeSend(event) {
          const { request } = event;
          if (request.url === `http://${request.headers.host}/route1`) {
            return deferred1.resolve(event);
          }
          return deferred2.resolve(event);
        },
      },
    },
  });

  let n = 1;
  const interval = setInterval(() => console.log(`global breadcrumb ${n++}`), 60);

  await Promise.all([
    server.inject({ method: 'GET', url: '/route1' }),
    server.inject({ method: 'GET', url: '/route2' }),
  ]);

  // /route1 should not see local breadcrumb of /route2
  const event1 = await deferred1.promise;
  t.is(event1.exception.values[0].value, 'Error 1');
  const event1Breadcrumbs = event1.breadcrumbs.map(b => b.message);
  const breadcrumbs1 = [
    // /route2 consumes number 1 to 3, leaves 4 to 6 for /route1
    'global breadcrumb 4',
    'global breadcrumb 5',
    'global breadcrumb 6',
  ];
  t.true(breadcrumbs1.every(b => event1Breadcrumbs.includes(b)));

  const event2 = await deferred2.promise;
  t.is(event2.exception.values[0].value, 'Error 2');
  const event2Breadcrumbs = event2.breadcrumbs.map(b => b.message);
  const breadcrumbs2 = [
    'global breadcrumb 1',
    'global breadcrumb 2',
    'global breadcrumb 3',
    'domain breadcrumb',
  ];
  t.true(event2Breadcrumbs.some(b => b.includes('[DEP0097]'))); // yeah, domains are deprecated
  t.true(breadcrumbs2.every(b => event2Breadcrumbs.includes(b)));
});

test('sanitizes user info from auth', async t => {
  const { server } = t.context;

  server.auth.scheme('mock', () => {
    return {
      authenticate(request, h) {
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
  });

  const event = await deferred.promise;
  t.is(event.exception.values[0].value, 'Oh no!');
  t.is(event.exception.values[0].type, 'Error');
});
