// Vercel serverless entry. Vercel's Express support runs src/app.ts and needs
// the module itself to be a request handler, so this file exports exactly one
// function (`export =` compiles to `module.exports = handler`). The app is built
// on the first request. Long-running servers start from src/index.ts instead,
// which also runs the background jobs.
import type { Request, Response } from 'express';
import { createApp } from './createApp';

let app: ReturnType<typeof createApp> | undefined;

function handler(req: Request, res: Response) {
  app ??= createApp();
  return app(req, res);
}

export = handler;
