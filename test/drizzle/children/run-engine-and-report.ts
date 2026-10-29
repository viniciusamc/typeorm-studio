import { runStudioEngine } from '../../../src/drizzle/run-studio-engine.ts';
import type { StudioDatabase } from '../../../src/drizzle/run-studio-engine.ts';

const request = JSON.parse(process.env['STUDIO_TEST_REQUEST'] ?? 'null') as {
  readonly database: StudioDatabase;
  readonly port: number;
};

const exit = await runStudioEngine({
  database: request.database,
  port: request.port,
  abortSignal: new AbortController().signal,
  onListening: (studio): void => {
    process.send?.({ listening: studio });
  },
});

process.send?.({ exit }, () => process.exit(0));
