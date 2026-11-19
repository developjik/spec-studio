import { startMockConfluence } from './mock-confluence';

/**
 * Runs a Confluence-shaped server on an ephemeral port and prints its address
 * as JSON on the first line. Used by the end-to-end check, never by the app.
 */
const mock = await startMockConfluence();
console.log(JSON.stringify({ url: mock.url, port: mock.port }));

const shutdown = async () => {
  await mock.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
