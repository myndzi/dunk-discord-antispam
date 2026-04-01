import {
  Attachment,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  GuildMember,
  Message,
  Partials,
  Snowflake,
  Sticker,
} from 'discord.js';
import { createHash } from 'node:crypto';

import type { DiscordConfig, DiscordSecrets } from './config/_discord';
import { logger } from './util';
import { DiscordSnowflake } from '@sapphire/snowflake';

export type DiscordInit = {
  config: DiscordConfig;
  secrets: DiscordSecrets;
};

export type Discord = {
  shutdown: () => Promise<void>;
};

export const initDiscord = async ({ config, secrets }: DiscordInit): Promise<Discord> => {
  const log = logger('discord');

  log.info('connect to discord');
  const client = await new Promise<Client<true>>((resolve, reject) => {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });
    client.once(Events.ClientReady, resolve);
    client.once(Events.Error, reject);
    client.login(secrets.token.unwrap());
    return client;
  });

  log.info('fetch details');
  const guild = await client.guilds.fetch(config.server);
  const channels = await guild.channels.fetch();

  const getChannelReference = (name: string) => {
    const resolved = channels.find(v => v && v.name === name);
    if (!resolved) throw new Error(`failed to find channel: ${name}`);
    if (!resolved.isSendable()) throw new Error(`channel is not sendable: ${name}`);
    return resolved;
  };
  const modChannel = getChannelReference(config.modChannel);
  const honeypot = getChannelReference(config.honeypot);

  const notify = async (msg: string) => {
    const notice = `[antispam] ${msg}`;
    try {
      await modChannel.send(notice);
      log.info(notice);
    } catch (err) {
      log.error('attempted to notify', notice);
      log.error('failed to notify mod channel', err);
    }
  };

  const tsOf = (msg: Message): number => Number(DiscordSnowflake.timestampFrom(msg.id));

  const sortAttachments = (a: Attachment, b: Attachment) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    if (a.size < b.size) return -1;
    if (a.size > b.size) return 1;
    return 0;
  };
  const sortStickers = (a: Sticker, b: Sticker) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  };

  const hashMessage = (msg: Message): string => {
    const hash = createHash('sha256');
    hash.update(msg.author.id);
    hash.update(msg.content);
    for (const a of msg.attachments.map(v => v).sort(sortAttachments)) {
      if (a.contentType) hash.update(a.contentType);
      hash.update(a.size.toString());
    }
    for (const st of msg.stickers.map(v => v).sort(sortStickers)) {
      hash.update(st.id);
    }
    return hash.digest('base64');
  };

  const WINDOW_MS = 1 * 60 * 1000;

  type Entry = { msg: Message; hash: string };
  const recentEntries: Entry[] = [];

  const recordMessage = (msg: Message): { hash: string; distinctChannels: number } => {
    const cutoff = tsOf(msg) - WINDOW_MS;
    const start = recentEntries.findIndex(e => tsOf(e.msg) > cutoff);
    recentEntries.splice(0, start === -1 ? recentEntries.length : start);

    const hash = hashMessage(msg);
    recentEntries.push({ msg, hash });

    const distinctChannels = new Set(recentEntries.filter(e => e.hash === hash).map(e => e.msg.channelId)).size;

    return { hash, distinctChannels };
  };

  const kickedUsers = new Set<Snowflake>();

  type DeleteNotice = { timer: NodeJS.Timeout; count: number; failed: number };
  const deleteNoticeTimers = new Map<Snowflake, DeleteNotice>();

  // Returns true if deleted (or dry-run), false if failed, undefined if skipped
  const deleteMessage = async (msg: Message): Promise<boolean | undefined> => {
    if (msg.channel.isDMBased()) return undefined;

    const truncated = msg.cleanContent.length > 100 ? `${msg.cleanContent.slice(0, 97)}...` : msg.cleanContent;
    const summary = `user=${msg.author.username} channel=${msg.channel.name} content=${truncated}`;

    if (config.dryRun) {
      log.info(`[dry-run] would delete message: ${summary}`);
      return true;
    }

    try {
      await msg.delete();
      log.info(`deleted message: ${summary}`);
      msg.attachments.forEach(att =>
        log.info(`  attachment: ${att.name}: ${att.contentType} (${att.size}): ${att.url}`)
      );
      msg.stickers.forEach(st => log.info(`  sticker: ${st.name}: ${st.id}`));
      return true;
    } catch (err) {
      log.error(`failed to delete message: ${summary}`);
      if (err instanceof DiscordAPIError) log.error(err.message);
      else log.error(err);
      return false;
    }
  };

  const deleteMessages = async (msgs: Message[]): Promise<{ deleted: number; failed: number }> => {
    let deleted = 0;
    let failed = 0;
    for (const msg of msgs) {
      const result = await deleteMessage(msg);
      if (result === true) deleted++;
      else if (result === false) failed++;
    }
    return { deleted, failed };
  };

  const kickAndDelete = async (member: GuildMember, reason: string, sample: Message) => {
    kickedUsers.add(member.id);

    const kickPromise = config.dryRun
      ? Promise.resolve()
          .then(() => {
            log.info(`[dry-run] would kick id=${member.id} username=${member.user.username}`);
          })
          .finally(() => kickedUsers.delete(member.id))
      : member
          .kick('spam')
          .then(() => {
            log.info(`kicked id=${member.id} username=${member.user.username}`);
            notify(`Kicked ${member}: ${reason}`);
          })
          .catch(e => {
            log.error('kick failed', e);
            notify(`Kick failed: ${e.message}`);
          })
          .finally(() => kickedUsers.delete(member.id));

    const msgsToDelete: Message[] = [];
    let write = 0;
    for (const entry of recentEntries) {
      if (entry.msg.author.id === member.id) {
        msgsToDelete.push(entry.msg);
      } else {
        recentEntries[write++] = entry;
      }
    }
    recentEntries.length = write;
    const { deleted, failed } = await deleteMessages(msgsToDelete);

    const prev = deleteNoticeTimers.get(member.id);
    if (prev) clearTimeout(prev.timer);

    const dn: DeleteNotice = {
      count: (prev?.count ?? 0) + deleted,
      failed: (prev?.failed ?? 0) + failed,
      timer: setTimeout(() => {
        deleteNoticeTimers.delete(member.id);

        let notice = `Deleted ${dn.count} messages from ${member}`;
        if (dn.failed > 0) notice += ` (failed=${dn.failed})`;
        notice += `\nSample: ${sample.cleanContent}`;
        for (const att of sample.attachments.values()) {
          notice += `\nAttachment: ${att.name}: ${att.contentType} (${att.size}): ${att.url}`;
        }
        for (const st of sample.stickers.values()) {
          notice += `\nSticker: ${st.name}: ${st.id} ${st.url}`;
        }

        notify(notice);
      }, 10_000),
    };
    deleteNoticeTimers.set(member.id, dn);

    await kickPromise;
  };

  const onMessage = async (message: Message) => {
    if (message.channel.isDMBased()) return;

    const member = await guild.members.fetch(message.author);

    if (kickedUsers.has(member.id)) {
      await deleteMessage(message);
      return;
    }

    const { hash, distinctChannels } = recordMessage(message);

    log.info(
      `[${hash}:${distinctChannels}] <${message.author.username}:${message.channel.name}>: ${message.cleanContent}`
    );
    message.attachments.forEach(att => log.info(`  ${att.name}: ${att.contentType} (${att.size}): ${att.url}`));
    message.stickers.forEach(st => log.info(`  ${st.name}: ${st.id}`));

    if (message.channelId === honeypot.id) {
      log.info(`kick user: message sent to honeypot channel ${honeypot.name}`);
      await kickAndDelete(member, `message sent to honeypot channel ${honeypot.name}`, message);
    } else if (distinctChannels >= 3) {
      log.info(`kick user: same message sent to ${distinctChannels} channels`);
      await kickAndDelete(member, `same message sent to ${distinctChannels} channels`, message);
    }
  };

  client.on(Events.MessageCreate, message => {
    onMessage(message);
  });

  return {
    shutdown: async (): Promise<void> => {
      await client.destroy();
    },
  };
};
