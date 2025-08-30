import 'dotenv/config';
import express from 'express';
import { connect as mongoConnect } from './db_connect';
import { logger } from './logger';
import { delay } from './util';
import { imageCache } from './util/imageCache';
import { createIndexes } from './models/indexes';

(async () => {
  process.on('unhandledRejection', e => {
    if (e) {
      logger.error(`Unhandled Rejection: ${e}`);
    }
  });

  process.on('uncaughtException', e => {
    if (e) {
      logger.error(`Uncaught Exception: ${e}`);
    }
  });

  const mongoose = mongoConnect();
  mongoose.connection
    .once('open', async () => {
      logger.info('Connected to Mongo instance.');

      await createIndexes();
      await imageCache.initialize();

      const app = express();
      const port = process.env.PORT || 3000;
      app.get('/health', (_req, res) => {
        res.send('OK');
      });

      app.listen(port, () => logger.info(`Server listening on port ${port}`));

      await delay(1000);
    })
    .on('error', (error: Error) => logger.error(`Error connecting to Mongo: ${error}`));
})();
