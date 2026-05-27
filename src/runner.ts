import { TelegramBotController } from './bot/TelegramBotController';
import { ApiServer } from './api/ApiServer';
import { env } from './config/env';
import { logger } from './utils/logger';

async function main() {
  logger.info('Initializing Telegram Bot Controller in Docker...');

  const controller = new TelegramBotController();

  // Start the API server for the mini app, passing the Drive uploader for video streaming
  const apiServer = new ApiServer(controller, controller.getDriveUploader());
  await apiServer.start(env.api.port);

  let stopping = false;
  const stopController = async () => {
    if (stopping) return;
    stopping = true;
    logger.info('Termination signal received. Stopping bot and processing remaining chunks...');
    apiServer.stop();
    await controller.stop();
    logger.info('Graceful shutdown complete.');
    process.exit(0);
  };

  process.on('SIGTERM', () => { stopController(); });
  process.on('SIGINT', () => { stopController(); });

  await controller.start();
}

main().catch((err) => {
  logger.fatal({ err }, 'Application crashed');
  process.exit(1);
});
