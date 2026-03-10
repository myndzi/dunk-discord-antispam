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
import { Heap, LRUMap } from 'mnemonist';
import { createHash } from 'node:crypto';

import type { DiscordConfig, DiscordSecrets } from './config/_discord';
import { logger } from './util';
import { Temporal } from '@js-temporal/polyfill';
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

  const discordServer = config.server;
  const token = secrets.token;

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
    client.login(token.unwrap());
    return client;
  });

  log.info('fetch details');
  const guild = await client.guilds.fetch(discordServer);

  const channels = await guild.channels.fetch();

  const getChannelReference = (name: string) => {
    const resolved = channels.find(v => v && v.name === name);
    if (!resolved) {
      throw new Error(`failed to find ${name}: ${resolved}`);
    }
    if (!resolved.isSendable()) {
      throw new Error(`channel is not sendable: ${resolved}`);
    }
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

  const instantFrom = (snowflake: Snowflake): Temporal.Instant => {
    return Temporal.Instant.fromEpochMilliseconds(DiscordSnowflake.timestampFrom(snowflake));
  };
  const maxInstant = (a: Temporal.Instant, b: Temporal.Instant): Temporal.Instant =>
    Temporal.Instant.compare(a, b) === -1 ? b : a;

  const timestampCache = new WeakMap<Message, Temporal.Instant>();
  const getTimestamp = (msg: Message): Temporal.Instant => {
    const cached = timestampCache.get(msg);
    if (cached != undefined) return cached;
    const instant = instantFrom(msg.id);
    timestampCache.set(msg, instant);
    return instant;
  };

  const sortMessages = (a: Message, b: Message) => Temporal.Instant.compare(getTimestamp(a), getTimestamp(b));

  class MessageGroup {
    static cache = new LRUMap<Snowflake, MessageGroup>(1000);
    static hash(message: Message) {
      const hash = createHash('sha256');

      const userId: Snowflake = message.author.id;
      hash.update(userId);
      hash.update(message.content);

      const attachments = message.attachments.map(v => v).sort(sortAttachments);
      const stickers = message.stickers.map(v => v).sort(sortStickers);
      for (const a of attachments) {
        if (a.contentType) {
          hash.update(a.contentType);
        }
        hash.update(a.size.toString());
      }

      for (const st of stickers) {
        hash.update(st.id);
      }

      return hash.digest('base64');
    }
    static get(message: Message): MessageGroup {
      const hash = MessageGroup.hash(message);
      const group = MessageGroup.cache.get(hash) ?? new MessageGroup(hash);
      MessageGroup.cache.set(hash, group);
      return group;
    }

    private messages: Heap<Message> = new Heap(sortMessages);

    oldest: Temporal.Instant | undefined = undefined;
    newest: Temporal.Instant | undefined = undefined;
    lastDeleted: Temporal.Instant | undefined = undefined;
    channels: Map<Snowflake, number> = new Map();

    constructor(readonly hash: string) {}

    private decChannels(channelId: Snowflake) {
      const count = (this.channels.get(channelId) ?? 0) - 1;
      if (count <= 0) this.channels.delete(channelId);
      else this.channels.set(channelId, count);
    }

    private incChannels(channelId: Snowflake) {
      const count = (this.channels.get(channelId) ?? 0) + 1;
      this.channels.set(channelId, count);
    }

    private clearedThisTick: boolean = false;
    private clearOld() {
      if (this.clearedThisTick) return;
      this.clearedThisTick = true;
      queueMicrotask(() => {
        this.clearedThisTick = false;
      });

      const now = Temporal.Now.instant();
      while (this.messages.size > 0) {
        const msg = this.messages.peek()!;
        const ageSeconds = getTimestamp(msg).until(now).total('minutes');
        if (ageSeconds <= 5) break;
        this.messages.pop();
        this.decChannels(msg.channelId);
      }
      const old = this.messages.peek();
      if (old === undefined) {
        this.oldest = undefined;
        this.newest = undefined;
      } else {
        this.oldest = getTimestamp(old);
      }
    }

    getForDelete() {
      this.clearOld();
      const arr = this.messages.toArray();
      if (arr.length === 0) return [];

      const last = this.lastDeleted;

      let max: Temporal.Instant = getTimestamp(arr[0]!);
      for (let i = 1; i < arr.length; i++) {
        max = maxInstant(max, getTimestamp(arr[i]));
      }
      this.lastDeleted = max;

      return last === undefined ? arr : arr.filter(msg => Temporal.Instant.compare(getTimestamp(msg), last) > 0);
    }

    count() {
      this.clearOld();
      return this.messages.size;
    }

    channelCount() {
      this.clearOld();
      return this.channels.size;
    }

    push(msg: Message) {
      this.clearOld();
      this.messages.push(msg);
      this.incChannels(msg.channelId);
      this.updateNewest(getTimestamp(msg));
    }

    updateNewest(ts: Temporal.Instant) {
      if (this.newest === undefined) {
        this.newest = ts;
      } else {
        this.newest = maxInstant(this.newest, ts);
      }
    }
  }

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

  const banCache = new LRUMap<Snowflake, Temporal.Instant>(1000);
  const deletedCache = new LRUMap<Snowflake, boolean>(1000);
  type DeleteNotice = {
    timer: NodeJS.Timeout;
    count: number;
    failed: number;
  };
  const timers = new Map<string, DeleteNotice>();

  const banUser = async (member: GuildMember, group: MessageGroup) => {
    const now = Temporal.Now.instant();
    const bannedAt = banCache.get(member.id);
    const attemptKick = bannedAt === undefined || bannedAt.until(now).total('minutes') > 5;

    if (attemptKick) {
      log.info(`attempt kick ${member.user.username}`);

      await member
        .kick('spam')
        .then(() => {
          log.info(`kicked id=${member.id} username=${member.user.username}`);
          notify(`Kicked ${member} for spam`);
        })
        .catch(e => {
          log.error('kick failed', e);
          notify(`Kicked failed: ${e.message}`);
        });
    }

    let sample: string | undefined = undefined;
    let sampleAtts: Attachment[] | undefined = undefined;
    let sampleSts: Sticker[] | undefined = undefined;
    let deleted = 0;
    let failed = 0;

    for (const msg of group.getForDelete()) {
      if (msg.channel.isDMBased()) {
        log.error('??? message is dm-based?');
        continue;
      }

      if (deletedCache.has(msg.id)) continue;

      sample ??= msg.content;
      sampleAtts ??= msg.attachments.map(v => v);
      sampleSts ??= msg.stickers.map(st => st);
      const truncated = msg.cleanContent.length > 100 ? `${msg.cleanContent.slice(0, 97)}...` : msg.cleanContent;
      const summary = `user=${msg.author.username} channel=${msg.channel.name} content=${truncated}`;

      try {
        await msg.delete();
        deleted++;
        log.info(`deleted message: ${summary}`);
        msg.attachments.forEach(att => {
          log.info(`  attachment: ${att.name}: ${att.contentType} (${att.size}): ${att.url}`);
        });
        msg.stickers.forEach(st => {
          log.info(`  sticker: ${st.name}: ${st.id}`);
        });
        deletedCache.set(msg.id, true);
      } catch (err) {
        failed++;
        log.error(`failed to delete message: ${summary}`);

        if (err instanceof DiscordAPIError) {
          log.error(err.message);
        } else {
          log.error(err);
        }
      }
    }

    const prev = timers.get(group.hash);
    if (prev) clearTimeout(prev.timer);
    const dn = {
      count: (prev?.count ?? 0) + deleted,
      failed: (prev?.failed ?? 0) + failed,
      timer: setTimeout(() => {
        timers.delete(group.hash);

        let notice = `Deleted ${dn.count} messages from ${member}`;
        if (dn.failed > 0) {
          notice += ` (failed=${dn.failed})`;
        }
        notice += `\nSample: ${sample}`;
        for (const att of sampleAtts ?? []) {
          notice += `\nAttachment: ${att.name}: ${att.contentType} (${att.size}): ${att.url}`;
        }
        for (const st of sampleSts ?? []) {
          notice += `\nSticker: ${st.name}: ${st.id} ${st.url}`;
        }

        notify(notice);
      }, 10_000),
    };
    timers.set(group.hash, dn);
  };

  const pushMessage = async (message: Message) => {
    const channel = message.channel;
    if (channel.isDMBased()) return;

    const group = MessageGroup.get(message);
    group.push(message);

    const numRepeatMessages = group.count();
    const numRepeatChannels = group.channelCount();

    log.info(
      `[${group.hash}:${numRepeatMessages}:${numRepeatChannels}] <${message.author.username}:${channel.name}>: ${message.cleanContent}`
    );
    message.attachments.forEach(att => {
      log.info(`  ${att.name}: ${att.contentType} (${att.size}): ${att.url}`);
    });
    message.stickers.forEach(st => {
      log.info(`  ${st.name}: ${st.id}`);
    });

    const member = await guild.members.fetch(message.author);
    // const joinedAt = member.joinedAt;

    // let threshold = 2;

    // const desc: string[] = [`threshold=${threshold} (initial)`];

    // if (joinedAt !== null) {
    //   // give a lot more leeway to users who've been around for some time
    //   const numDaysPresent = (now - joinedAt.getTime()) / 86400_000;
    //   if (numDaysPresent > 7) {
    //     log.info(`no action: member for ${Math.round(numDaysPresent)} days`);
    //     return;
    //   }
    //   // let leeway = 0;
    //   // if (numDaysPresent > 7) leeway += 1;
    //   // else if (numDaysPresent > 30) leeway += 2;
    //   // threshold += leeway;
    //   // desc.push(`threshold+=${threshold} (numDaysPresent: ${numDaysPresent})`);
    // }

    // if (numRepeatChannels === 1) {
    //   // go a little easier on spam in a single channel
    //   threshold += 2;
    //   desc.push(`threshold+=2 (numRepeatChannels === 1)`);
    // }

    // let score = numRepeatChannels + (message.attachments.size > 0 ? 1 : 0);
    // desc.push(`score=${score} (numRepeatChannels: ${numRepeatChannels}; numAttachments: ${message.attachments.size})`);
    // if (message.cleanContent.length > 50) {
    //   // be harsher on long messages
    //   score += 2;
    //   desc.push(`score+=2 (cleanContent.length > 50)`);
    // }

    // const rateSecs = (group.latestTimestamp - group.earliestTimestamp) / 1000 / numRepeatMessages;
    // if (numRepeatMessages > 1 && rateSecs < numRepeatMessages) {
    //   // be harsher on fast spam
    //   score += 2;
    //   desc.push(`score+=2 (rateSecs: ${rateSecs} < numRepeatMessages: ${numRepeatMessages})`);
    // }

    // if (score > threshold) {
    //   log.info(`score: ${score} > threshold: ${threshold} = ${score > threshold}`, desc);
    //   log.error('*** BAN ***', desc);
    // }

    if (message.channelId === honeypot.id) {
      log.info(`ban user: message sent to honeypot channel ${honeypot.name}`);
      await banUser(member, group);
    } else if (numRepeatChannels > 2) {
      log.info(`ban user: repeat message sent to ${numRepeatChannels} channels`);
      await banUser(member, group);
    }
  };

  client.on(Events.MessageCreate, message => {
    pushMessage(message);
  });

  return {
    shutdown: async (): Promise<void> => {
      await client.destroy();
    },
  };
};
