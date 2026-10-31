import { flushSentry } from './instrument';
import http from 'http';
import { createApp } from './app';
import { createSocketServer } from './infra/socket';
import { beginPresenceShutdown, registerSocketHandlers } from './modules/chat/chat.socket';
import { setIo } from './infra/realtime';
import { startWorkers } from './jobs';
import { env } from './config/env';
import { logger } from './infra/logger';

const app = createApp();
const server = http.createServer(app);

// Socket.io shares the SAME http server as Express.
const io = createSocketServer(server);
setIo(io);
registerSocketHandlers(io);

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason instanceof Error ? reason : undefined, reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  void flushSentry().finally(() => process.exit(1));
});

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

startWorkers(); // in-process now; can move to its own Render service later

server.listen(env.PORT, () => logger.info(`API + sockets on :${env.PORT}`));

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down HTTP server');
  beginPresenceShutdown();
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'HTTP server shutdown failed');
      void flushSentry().finally(() => process.exit(1));
      return;
    }

    logger.info('HTTP server stopped');
    void flushSentry().finally(() => process.exit(0));
  });

  setTimeout(() => {
    logger.error({ signal }, 'Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}
