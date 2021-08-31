"use strict";

// Domain is deprecated, but Sentry relies on it
import domain = require("domain");
import shimmer = require("shimmer");
import eventsIntercept = require("events-intercept");
import type * as SentryNamespace from "@sentry/node";
import type { NodeOptions } from "@sentry/node";
import type { Server } from "@hapi/hapi";
import { z } from "zod";
import type * as Http from "http";
import { ExpressRequest } from "@sentry/node/dist/handlers";
import { options as optionsSchema } from "./schema";
import { name, version } from "../package.json";

declare module "@hapi/hapi" {
  interface Request {
    [key: string]: any;
  }

  interface Server {
    _core: any;
  }

  interface PluginProperties {
    "hapi-sentry": {
      client: typeof SentryNamespace;
    };
  }
}

declare module "http" {
  interface Server {
    intercept: (
      event: string,
      interceptor: (
        req: Http.ClientRequest,
        res: Http.ServerResponse,
        done: InterceptorNext
      ) => void
    ) => void;
  }
}

type InterceptorNext = (
  e: Error | null,
  req: Http.ClientRequest,
  res: Http.ServerResponse,
  ...args: any[]
) => void;

const once = true;
interface Options extends Omit<z.input<typeof optionsSchema>, "client"> {
  client: z.input<typeof optionsSchema>["client"] | NodeOptions; // Make it possible to pass either a valid Sentry option, or something that looks like it
}

async function register(server: Server, options: Options): Promise<void> {
  const opts = optionsSchema.parse(options);

  let Sentry: typeof SentryNamespace;
  // initialize own sentry client if none passed as option
  if ("dsn" in opts.client) {
    // eslint-disable-next-line global-require
    Sentry = await import("@sentry/node");
    Sentry.init(opts.client as SentryNamespace.NodeOptions);
  } else {
    // Get the original sentry client, not the deep copy from Zod
    Sentry = options.client as unknown as typeof SentryNamespace;
  }

  // initialize global scope if set via plugin options
  if (opts.scope) {
    Sentry.configureScope((scope) => {
      if (opts.scope?.tags)
        opts.scope.tags.forEach((tag) => scope.setTag(tag.name, tag.value));
      if (opts.scope?.level)
        scope.setLevel(opts.scope.level as SentryNamespace.Severity);
      if (opts.scope?.extra) {
        Object.keys(opts.scope.extra).forEach((key) =>
          scope.setExtra(key, opts.scope?.extra?.get(key))
        );
      }
    });
  }
  // expose sentry client at server.plugins['hapi-sentry'].client
  server.expose("client", Sentry);

  // Set up request interceptor for creating and destroying a domain on each request
  // It'll wrap the request handler returned by the _dispatch function in HAPI core
  // allowing it to create the domain before any of HAPIs processing starts
  // thus allowing us to use the normal HAPI extensions to add context to Sentry scopes
  // https://github.com/hapijs/hapi/blob/c95985e225fa09c4b640a887ccb4be46dbe265bc/lib/core.js#L507-L538
  function interceptor(
    this: any,
    next: InterceptorNext,
    req: Http.ClientRequest,
    res: Http.ServerResponse,
    ...args: any[]
  ) {
    const local = domain.create(); // Create domain to hold context for request
    local.add(req);
    local.add(res);

    let rtn;

    local.run(() => {
      // Create new scope for request
      const currentHub = Sentry.getCurrentHub();

      currentHub.configureScope((scope) => {
        scope.addEventProcessor((_sentryEvent) => {
          // format a sentry event from the request and triggered event
          const sentryEvent = Sentry.Handlers.parseRequest(
            _sentryEvent,
            req as ExpressRequest
          );

          // overwrite events request url if a baseUrl is provided
          if (opts.baseUri && sentryEvent.request) {
            if (opts.baseUri.slice(-1) === "/")
              opts.baseUri = opts.baseUri.slice(0, -1);
            sentryEvent.request.url = opts.baseUri + req.path;
          }

          // some SDK identifier
          sentryEvent.sdk = { name: "sentry.javascript.node.hapi", version };
          return sentryEvent;
        });
      });

      rtn = next.apply(this, [null, req, res, ...args]);
    });

    return rtn;
  }

  // Setup listener interceptors so we can intercept inbound requests from Node, needed
  // because we can't patch HAPI before it sets up listeners
  eventsIntercept.patch(server.listener);
  server.listener.intercept(
    "request",
    function _requestInterceptor(
      this: any,
      req: Http.ClientRequest,
      res: Http.ServerResponse,
      ...args: any[]
    ) {
      interceptor.apply(this, [
        args[args.length - 1],
        req,
        res,
        ...args.slice(0, -1),
      ]);
    }
  );
  server.listener.intercept(
    "checkContinue",
    function _checkContinueInterceptor(
      this: any,
      req: Http.ClientRequest,
      res: Http.ServerResponse,
      ...args: any[]
    ) {
      interceptor.apply(this, [
        args[args.length - 1],
        req,
        res,
        ...args.slice(0, -1),
      ]);
    }
  );

  // Wrap HAPI core _dispatch function. This function is primary entry point into HAPI for an
  // external request. It's a factory that returns Node request handlers
  // https://github.com/hapijs/hapi/blob/c95985e225fa09c4b640a887ccb4be46dbe265bc/lib/core.js#L505-L539
  if (
    server._core &&
    server._core._dispatch &&
    !server._core._dispatch.__wrapped
  ) {
    shimmer.wrap(
      server._core,
      "_dispatch",
      (original) =>
        // eslint-disable-line
        function _dispatch_wrapped(this: any, ...dispatchArgs: any[]) {
          // eslint-disable-line
          const listener = original.apply(this, dispatchArgs);

          function next(
            this: any,
            err: Error | null,
            req: Http.ClientRequest,
            res: Http.ServerResponse,
            ...args: any[]
          ) {
            listener.apply(this, [req, res, ...args]);
          }

          return interceptor.bind(this, next);
        }
    );
  }

  server.ext([
    {
      type: "onRequest",
      method: (request, h) => {
        // To maintain backwards compatibility attached the Hub scope to the request
        request.sentryScope = Sentry.getCurrentHub().getScope();
        return h.continue;
      },
    },
    {
      type: "onCredentials",
      method: (request, h) => {
        Sentry.configureScope((scope) => {
          // use request credentials for current scope
          if (opts.trackUser && request.auth && request.auth.credentials) {
            const creds = { ...request.auth.credentials };
            Object.keys(creds) // hide credentials
              .filter((prop) => /^(p(ass)?w(or)?(d|t)?|secret)?$/i.test(prop))
              .forEach((prop) => delete creds[prop]);
            scope.setUser(creds);
          }
        });

        return h.continue;
      },
    },
  ]);

  let errorTags = ["error", "fatal", "fail"];
  if (opts.catchLogErrors && Array.isArray(opts.catchLogErrors)) {
    errorTags = opts.catchLogErrors;
  }

  const channels = ["error"];
  // also listen for app events to get log messages
  if (opts.catchLogErrors) channels.push("app");

  // get request errors to capture them with sentry
  server.events.on({ name: "request", channels }, (request, event) => {
    // check for errors in request logs
    if (event.channel === "app") {
      if (!event.error) return; // no error, just a log message
      if (event.tags.some((tag) => errorTags.includes(tag)) === false) return; // no matching tag
    }

    Sentry.captureException(event.error);
  });

  if (opts.catchLogErrors) {
    server.events.on({ name: "log", channels: ["app"] }, (event) => {
      if (!event.error) return; // no error, just a log message
      if (event.tags.some((tag) => errorTags.includes(tag)) === false) return; // no matching tag

      Sentry.captureException(event.error);
    });
  }
}

export { register, name, version, once, Options };
