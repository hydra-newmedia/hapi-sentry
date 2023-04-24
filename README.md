# hapi-sentry

[![package on npm](https://img.shields.io/npm/v/hapi-sentry.svg)](https://www.npmjs.com/package/hapi-sentry)
[![GitHub Workflow Status](https://github.com/hydra-newmedia/hapi-sentry/actions/workflows/nodejs.yml/badge.svg)](https://github.com/hydra-newmedia/hapi-sentry/actions/workflows/nodejs.yml)
![node 14+ required](https://img.shields.io/badge/node-14%2B-brightgreen.svg)
[![GitHub license](https://img.shields.io/badge/license-MIT-blue.svg)](https://raw.githubusercontent.com/hydra-newmedia/hapi-sentry/master/LICENSE)

A hapi [plugin](https://hapijs.com/api#plugins) for
request error logging to [Sentry](https://sentry.io/).

## Usage

Use the hapi plugin like this:
```JavaScript
const hapi = require('@hapi/hapi');
const Sentry = require('@sentry/node');
const server = hapi.server();

Sentry.init({ dsn: 'dsn-here' });
await server.register({
  plugin: require('hapi-sentry'),
  options: {
    client: Sentry,
  },
});
```

This setup will:
* Capture all unhandled exceptions thrown or returned in routes
* Use request data and `request.auth.credentials` to enhance errors from routes

You can use the following options to customize this behavior further.

## Options

The plugin options, you can pass in while registering are the following:

| property                  | type          | description                                                                                                                  |
|:--------------------------|:--------------|:-----------------------------------------------------------------------------------------------------------------------------|
| `baseUri`                 | string        | [uri](https://github.com/hapijs/joi/blob/master/API.md#stringurioptions) to be used as base for captured urls                |
| `scope.tags`              | object        | An array of tags to be sent with every event                                                                                 |
| `scope.tags.name`         | string        | The name of a tag                                                                                                            |
| `scope.tags.value`        | any           | The value of a tag                                                                                                           |
| `scope.extra`             | object        | An object of arbitrary format to be sent as extra data on every event                                                        |
| `client`                  | object        | **required** A [@sentry/node](https://www.npmjs.com/package/@sentry/node) instance which was already initialized (using `Sentry.init`) |
| `trackUser`               | boolean       | Whether or not to track the user via the per-request scope. Default: `true`                                                  |
| `catchLogErrors`          | boolean/array | Handles [capturing server.log and request.log events](#capturing-serverlog-and-requestlog-events). Default: `false`          |
| `useDomainPerRequest`     | boolean       | Whether or not to use [Domains](https://nodejs.org/docs/latest-v12.x/api/domain.html) for seperating request processing. Only activate this feature, if you really need to seperate breadcrumbs, etc. of requests. It utilizes a deprecated Node.js feature which reduces [performance](https://github.com/hydra-newmedia/hapi-sentry/pull/21#issuecomment-574602486). Default: `false` |

The `baseUri` option is used internally to get a correct URL in sentry issues.
The `scope` option is used to set up a global
[`Scope`](http://getsentry.github.io/sentry-javascript/classes/hub.scope.html)
for all events.

## Scope

You can alter the scope of an event in every
hapi [route handler](https://hapijs.com/api#route.options.handler)
by accessing `request.sentryScope`.
Just use some of the [`Scope`](http://getsentry.github.io/sentry-javascript/classes/hub.scope.html)s
methods to add breadcrumbs, set extra, fingerprint or level information, etc. like this:

```JavaScript
server.route({
  method: 'GET',
  path: '/your/route',
  handler(request) {
    try {
      // ... some logic here
    } catch (error) {
      request.sentryScope.setExtra('someErrorSpecificInfo', 'yourInformation');
      throw error;
    }
  },
});
```

## Capturing server.log and request.log events

You can enable capturing of `request.log` and `server.log` events using the `catchLogErrors` option.
All events which are `Error` objects and are tagged by one of `['error', 'fatal', 'fail']` are
automatically being tracked when `catchLogErrors` is set to `true`,  e.g.:

```js
request.log(['error', 'foo'], new Error('Oh no!'));
server.log(['error', 'foo'], new Error('No no!'));
```

The considered tags can be changed by setting `catchLogErrors` to a custom array of tags like
`['error', 'warn', 'failure']`.

## Capturing the request body

`hapi-sentry` currently does not capture the body for performance reasons. You can use the following snippet to capture the body in all sentry errors:

```js
server.ext({
  type: 'onPostAuth',
  method(request, h) {
    request.payload && request.sentryScope.setExtra('payload', request.payload);
    return h.continue;
  },
});
```
