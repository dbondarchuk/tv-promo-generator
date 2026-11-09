import type { NextFunction, Request, Response } from "express";
import { createLogger } from "./log.js";

const log = createLogger("http");

/** Paths polled often — successful fast GETs stay at debug. */
function isQuietGet(req: Request): boolean {
  if (req.method !== "GET") return false;

  const path = req.path;
  return (
    path === "/api/channels" ||
    path === "/api/jobs" ||
    path === "/api/health" ||
    path === "/api/settings/status" ||
    path.startsWith("/api/jobs/stream")
  );
}

/** Log every request; always surface /graphics, /live, errors, and slow calls. */
export function requestLogMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const started = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - started;
    const payload: Record<string, unknown> = {
      status: res.statusCode,
      ms,
    };

    if (req.query && Object.keys(req.query).length > 0) {
      payload.query = req.query;
    }

    const line = `${req.method} ${req.originalUrl}`;
    const noisy =
      res.statusCode >= 400 ||
      ms >= 1000 ||
      req.path.startsWith("/graphics") ||
      req.path.startsWith("/live") ||
      !isQuietGet(req);

    if (res.statusCode >= 500) {
      log.error(line, payload);
    } else if (res.statusCode >= 400) {
      log.warn(line, payload);
    } else if (noisy) {
      log.info(line, payload);
    } else {
      log.debug(line, payload);
    }
  });

  next();
}
