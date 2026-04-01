import { StaticDecode, Type as T } from '@sinclair/typebox';

import { TSecret } from './secret';

export const DiscordConfig = T.Object({
  server: T.String(),
  modChannel: T.String(),
  honeypot: T.String(),
  dryRun: T.Boolean({ default: false }),
});
export type DiscordConfig = StaticDecode<typeof DiscordConfig>;

export const DiscordSecrets = T.Object({
  token: TSecret('token', T.String()),
});
export type DiscordSecrets = StaticDecode<typeof DiscordSecrets>;
