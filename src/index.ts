"use strict";

// Domain is deprecated, but Sentry relies on it
import domain = require("domain");
import shimmer = require("shimmer");
import eventsIntercept = require("events-intercept");
import { logger, isString } from "@sentry/utils";
import { extractTraceparentData, SpanStatus } from "@sentry/tracing";
import { isAutoSessionTrackingEnabled, flush } from "@sentry/node/dist/sdk";
import { RequestSessionStatus, Transaction, Span } from "@sentry/types";
import { extractRequestData } from "@sentry/node/dist/handlers";
import type * as SentryNamespace from "@sentry/node";
import type { NodeOptions } from "@sentry/node";
import type { Server } from "@hapi/hapi";
import { z } from "zod";
import type * as http from "http";
import { ExpressRequest } from "@sentry/node/dist/handlers";
import { options as optionsSchema } from "./schema";
import { extractransactionName } from "./utils";
import { name, version } from "../package.json";

declare module "@hapi/hapi" {
  interface Request {
    sentryScope?: SentryNamespace.Scope;
    sentrySpan?: Span;
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
        req: http.IncomingMessage,
        res: http.ServerResponse,
        done: InterceptorNext
      ) => void
    ) => void;
  }
}

type InterceptorNext = (
  e: Error | null,
  req: http.IncomingMessage,
  res: http.ServerResponse,
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

  const currentHub = Sentry.getCurrentHub();
  const client = currentHub.getClient<SentryNamespace.NodeClient>();
  // Setup the session flusher
  if (client && isAutoSessionTrackingEnabled(client)) {
    client.initSessionFlusher();

    // If Scope contains a Single mode Session, it is removed in favor of using Session Aggregates mode
    const scope = currentHub.getScope();
    if (scope && scope.getSession()) {
      scope.setSession();
    }
  }

  // Set up request interceptor for creating and destroying a domain on each request
  // It'll wrap the request handler returned by the _dispatch function in HAPI core
  // allowing it to create the domain before any of HAPIs processing starts
  // thus allowing us to use the normal HAPI extensions to add context to Sentry scopes
  // https://github.com/hapijs/hapi/blob/c95985e225fa09c4b640a887ccb4be46dbe265bc/lib/core.js#L507-L538
  function interceptor(
    this: any,
    next: InterceptorNext,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ...args: any[]
  ) {
    const _end = res.end;
    res.end = function (chunk?: any, encoding?: any, cb?: () => void): void {
      void flush(options.flushTimeout)
        .then(() => {
          _end.call(this, chunk, encoding, cb);
        })
        .then(null, (e) => {
          logger.error(e);
        });
    };

    const local = domain.create(); // Create domain to hold context for request
    local.add(req);
    local.add(res);

    let rtn;

    local.run(() => {
      // Create new scope for request
      const currentHub = Sentry.getCurrentHub();

      currentHub.configureScope((scope) => {
        /*                                    */
        /* Setup session tracking per request */
        /*                                    */
        const client = currentHub.getClient<SentryNamespace.NodeClient>();
        if (isAutoSessionTrackingEnabled(client)) {
          const scope = currentHub.getScope();
          if (scope) {
            // Set `status` of `RequestSession` to Ok, at the beginning of the request
            scope.setRequestSession({ status: RequestSessionStatus.Ok });
          }
        }

        res.once("finish", () => {
          const client = currentHub.getClient<SentryNamespace.NodeClient>();
          if (isAutoSessionTrackingEnabled(client)) {
            setImmediate(() => {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
              if (client && (client as any)._captureRequestSession) {
                // Calling _captureRequestSession to capture request session at the end of the request by incrementing
                // the correct SessionAggregates bucket i.e. crashed, errored or exited
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                (client as any)._captureRequestSession();
              }
            });
          }
        });

        /*                                     */
        /* Setup trace transaction per request */
        /*                                     */
        if (opts.tracing) {
          // If there is a trace header set, we extract the data from it (parentSpanId, traceId, and sampling decision)
          let traceparentData;
          if (req.headers && isString(req.headers["sentry-trace"])) {
            traceparentData = extractTraceparentData(
              req.headers["sentry-trace"] as string
            );
          }

          const transaction = Sentry.startTransaction(
            {
              name: extractransactionName(req, { path: true, method: true }),
              op: "http.server",
              ...traceparentData,
            },
            // extra context passed to the tracesSampler
            { request: extractRequestData(req) }
          );

          // We put the transaction on the scope so users can attach children to it
          Sentry.getCurrentHub().configureScope((scope) => {
            scope.setSpan(transaction);
          });

          res.once("finish", () => {
            // Push `transaction.finish` to the next event loop so open spans have a chance to finish before the transaction
            // closes
            setImmediate(() => {
              transaction.setHttpStatus(res.statusCode);
              transaction.finish();
            });
          });
        }

        /*                               */
        /* Setup request event processor */
        /*                               */
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
            sentryEvent.request.url = opts.baseUri + req.url;
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
      req: http.IncomingMessage,
      res: http.ServerResponse,
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
      req: http.IncomingMessage,
      res: http.ServerResponse,
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
            req: http.IncomingMessage,
            res: http.ServerResponse,
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

        // Create a span so we can trace Hapi's request lifecycle before the request
        // handler is fired.
        const transaction = request.sentryScope?.getTransaction();
        if (transaction) {
          (request as any).__preHandlerSpan = transaction.startChild({
            op: "preHandler",
            description:
              "Hapi lifecycle process before request handler is called",
          });
        }
        return h.continue;
      },
    },
    {
      type: "onPreHandler",
      method: (request, h) => {
        const preHandlerSpan: Span = (request as any).__preHandlerSpan;
        if (preHandlerSpan) {
          preHandlerSpan.setStatus(SpanStatus.Ok);
          preHandlerSpan.finish();

          // Also create a new span for the request handler
          request.sentrySpan = Sentry.getCurrentHub()
            .getScope()
            ?.getTransaction()
            ?.startChild({
              op: "requestHandler",
              description: "Request handler",
            });
        }

        return h.continue;
      },
    },
    {
      type: "onPostHandler",
      method: (request, h) => {
        // Close off the request span
        const requestSpan = request.sentrySpan;
        if (requestSpan) {
          requestSpan.finish();
          if (requestSpan.status === undefined) {
            requestSpan.setStatus(SpanStatus.Ok);
          }
        }

        // Create a span so we can trace Hapi's request lifecycle after the request
        // handler is fired.
        const transaction = request.sentryScope?.getTransaction();
        if (transaction) {
          (request as any).__postHandlerSpan = transaction.startChild({
            op: "postHandler",
            description:
              "Hapi lifecycle process after request handler is called",
          });
        }

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
    Sentry.withScope((_scope) => {
      // check for errors in request logs
      if (event.channel === "app") {
        if (!event.error) return; // no error, just a log message
        if (event.tags.some((tag) => errorTags.includes(tag)) === false) return; // no matching tag
      }

      const client =
        Sentry.getCurrentHub().getClient<SentryNamespace.NodeClient>();
      if (client && isAutoSessionTrackingEnabled(client)) {
        // Check if the `SessionFlusher` is instantiated on the client to go into this branch that marks the
        // `requestSession.status` as `Crashed`, and this check is necessary because the `SessionFlusher` is only
        // instantiated when the the`requestHandler` middleware is initialised, which indicates that we should be
        // running in SessionAggregates mode
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const isSessionAggregatesMode =
          (client as any)._sessionFlusher !== undefined;
        if (isSessionAggregatesMode) {
          const requestSession = _scope.getRequestSession();
          // If an error bubbles to the `errorHandler`, then this is an unhandled error, and should be reported as a
          // Crashed session. The `_requestSession.status` is checked to ensure that this error is happening within
          // the bounds of a request, and if so the status is updated
          if (requestSession && requestSession.status !== undefined)
            requestSession.status = RequestSessionStatus.Crashed;
        }
      }

      // Mark any unfinished spans as failed
      if (opts.tracing) {
        const preSpan: Span = (request as any).__preHandlerSpan;
        const handlerSpan: Span = (request as any).sentrySpan;
        const postSpan: Span = (request as any).__postHandlerSpan;

        const spans = [preSpan, handlerSpan, postSpan];

        spans.map((span) => {
          if (span) {
            if (span.status === undefined) {
              span.setStatus(SpanStatus.InternalError);
            }
            if (span.endTimestamp === undefined) {
              span.finish();
            }
          }
        });
      }

      Sentry.captureException(event.error);
    });
  });

  server.events.on("response", (request) => {
    if (opts.tracing) {
      const postSpan: Span = (request as any).__postHandlerSpan;
      if (postSpan) {
        postSpan.setStatus(SpanStatus.Ok);
        postSpan.finish();
      }

      const transaction: Transaction | undefined = Sentry.getCurrentHub()
        .getScope()
        ?.getTransaction();
      if (transaction) {
        if ("statusCode" in request.response) {
          transaction.setHttpStatus(request.response.statusCode);
        } else {
          transaction.setStatus(SpanStatus.Cancelled);
        }
        transaction.finish();
      }
    }
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
