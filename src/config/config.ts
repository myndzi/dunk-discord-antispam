import { resolve } from 'node:path';

import { StaticDecode, Type as T } from '@sinclair/typebox';

import { FileSource } from './file_source';
import { DiscordConfig, DiscordSecrets } from './_discord';

const Config = T.Object({
  discord: DiscordConfig,
});

const Secrets = T.Object({
  discord: DiscordSecrets,
});

const configFile = new FileSource(resolve(__dirname, '..', '..', 'config.json'), Config);
const secretsFile = new FileSource(resolve(__dirname, '..', '..', 'secrets.json'), Secrets);

export type Secrets = StaticDecode<typeof Secrets>;
export type Config = StaticDecode<typeof Config>;

export const loadConfig = async (): Promise<{ config: Config; secrets: Secrets }> => {
  const [config, secrets] = await Promise.all([configFile.load(), secretsFile.load()]);
  return {
    config,
    secrets,
  };
};
