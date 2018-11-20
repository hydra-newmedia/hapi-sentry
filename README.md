# hapi-sentry

A hapi [plugin](https://hapijs.com/api#plugins) for
request error logging to [Sentry](https://sentry.io/).

## Usage

Use the hapi plugin like this:
```JavaScript
const server = hapi.server();
await server.register({ plugin: require('hapi-sentry'), options });
```

## Options

The plugin options, you can pass in while registering are the following:

| property                  | type         | description                                                                                                                  |
|:--------------------------|:-------------|:-----------------------------------------------------------------------------------------------------------------------------|
| `baseUri`                 | string       | [uri](https://github.com/hapijs/joi/blob/master/API.md#stringurioptions) to be used as base for captured urls                |
| `channels`                | \[string\]   | One or array of hapi [server.events](https://hapijs.com/api#-servereventevents) channels to be captured. Default: `'error'`  |
| `trackUser`               | boolean      | Whether or not to track the user via the per-request scope. Default: `true`                                                  |
| `scope.tags`              | object       | An array of tags to be sent with every event                                                                                 |
| `scope.tags.name`         | string       | The name of a tag                                                                                                            |
| `scope.tags.value`        | any          | The value of a tag                                                                                                           |
| `scope.extra`             | object       | An object of arbitrary format to be sent as extra data on every event                                                        |
| `client`                  | object       | **required** Options to be passed to the [@sentry/node](https://www.npmjs.com/package/@sentry/node)s init function           |
| `client.dsn`              | string/false | **required** The Dsn used to connect to Sentry and identify the project. If false, the SDK will not send any data to Sentry. |
| `client.debug`            | boolean      | Turn debug mode on/off                                                                                                       |
| `client.release`          | string       | Tag events with the version/release identifier of your application                                                           |
| `client.environment`      | string       | The current environment of your application (e.g. `'production'`)                                                            |
| `client.sampleRate`       | number       | A global sample rate to apply to all events (0 - 1)                                                                          |
| `client.maxBreadcrumbs`   | number       | The maximum number of breadcrumbs sent with events. Default: `100`                                                           |
| `client.attachStacktrace` | any          | Attaches stacktraces to pure capture message / log integrations                                                              |
| `client.sendDefaultPii`   | boolean      | If this flag is enabled, certain personally identifiable information is added by active integrations                         |
| `client.serverName`       | string       | Overwrite the server name (device name)                                                                                      |
| `client.beforeSend`       | func         | A callback invoked during event submission, allowing to optionally modify the event before it is sent to Sentry              |
| `client.beforeBreadcrumb` | func         | A callback invoked when adding a breadcrumb, allowing to optionally modify it before adding it to future events.             |

The `baseUri` and `channels` options are used internally,
the `scope` option is used to set up a global
[`Scope`](http://getsentry.github.io/sentry-javascript/classes/hub.scope.html)
for all events and the
[`client`](http://getsentry.github.io/sentry-javascript/interfaces/node.nodeoptions.html) option
is used to initialize the Sentry library.

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
