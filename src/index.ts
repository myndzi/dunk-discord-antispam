import { loadConfig } from './config/config';
import { initDiscord } from './discord';
import { logger } from './util';

(async () => {
  const log = logger('main');
  log.info('load config');
  const { config, secrets } = await loadConfig();

  log.info('init discord');
  await initDiscord({
    config: config.discord,
    secrets: secrets.discord,
  });

  log.info('ready');
})();
