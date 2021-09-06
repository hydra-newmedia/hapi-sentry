import * as http from "http";
import { ExtractedNodeRequestData } from "@sentry/types";
import { isString, normalize, stripUrlQueryAndFragment } from "@sentry/utils";
import * as cookie from "cookie";
import * as url from "url";

// Based on @sentry/node express handler
export function extractransactionName(
  req: http.IncomingMessage,
  options: { path?: boolean; method?: boolean } = {}
): string {
  const method = req.method?.toUpperCase();

  const path = stripUrlQueryAndFragment(req.url || "");

  let info = "";
  if (options.method && method) {
    info += method;
  }
  if (options.method && options.path) {
    info += ` `;
  }
  if (options.path && path) {
    info += path;
  }

  return info;
}

// Taken from @sentry/node

/** Default request keys that'll be used to extract data from the request */
const DEFAULT_REQUEST_KEYS = [
  "cookies",
  "data",
  "headers",
  "method",
  "query_string",
  "url",
];

export function extractRequestData(
  req: { [key: string]: any },
  keys: string[] = DEFAULT_REQUEST_KEYS
): ExtractedNodeRequestData {
  const requestData: { [key: string]: any } = {};

  // headers:
  //   node, express, nextjs: req.headers
  //   koa: req.header
  const headers = (req.headers || req.header || {}) as {
    host?: string;
    cookie?: string;
  };
  // method:
  //   node, express, koa, nextjs: req.method
  const method = req.method;
  // host:
  //   express: req.hostname in > 4 and req.host in < 4
  //   koa: req.host
  //   node, nextjs: req.headers.host
  const host = req.hostname || req.host || headers.host || "<no host>";
  // protocol:
  //   node, nextjs: <n/a>
  //   express, koa: req.protocol
  const protocol =
    req.protocol === "https" ||
    req.secure ||
    ((req.socket || {}) as { encrypted?: boolean }).encrypted
      ? "https"
      : "http";
  // url (including path and query string):
  //   node, express: req.originalUrl
  //   koa, nextjs: req.url
  const originalUrl = (req.originalUrl || req.url || "") as string;
  // absolute url
  const absoluteUrl = `${protocol}://${host}${originalUrl}`;

  keys.forEach((key) => {
    switch (key) {
      case "headers":
        requestData.headers = headers;
        break;
      case "method":
        requestData.method = method;
        break;
      case "url":
        requestData.url = absoluteUrl;
        break;
      case "cookies":
        // cookies:
        //   node, express, koa: req.headers.cookie
        //   vercel, sails.js, express (w/ cookie middleware), nextjs: req.cookies
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        requestData.cookies = req.cookies || cookie.parse(headers.cookie || "");
        break;
      case "query_string":
        // query string:
        //   node: req.url (raw)
        //   express, koa, nextjs: req.query
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        requestData.query_string =
          req.query || url.parse(originalUrl || "", false).query;
        break;
      case "data":
        if (method === "GET" || method === "HEAD") {
          break;
        }
        // body data:
        //   express, koa, nextjs: req.body
        //
        //   when using node by itself, you have to read the incoming stream(see
        //   https://nodejs.dev/learn/get-http-request-body-data-using-nodejs); if a user is doing that, we can't know
        //   where they're going to store the final result, so they'll have to capture this data themselves
        if (req.body !== undefined) {
          requestData.data = isString(req.body)
            ? req.body
            : JSON.stringify(normalize(req.body));
        }
        break;
      default:
        if ({}.hasOwnProperty.call(req, key)) {
          requestData[key] = (req as { [key: string]: any })[key];
        }
    }
  });

  return requestData;
}
