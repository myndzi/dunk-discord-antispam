# dunk-discord-bot

Simple bot to implement a couple Discord features for [DunkOrSlam](https://twitch.tv/DunkOrSlam)'s Twitch stream.

# Configuration

Create a file, `config.json`, in the project root, with the following structure:

```json
{
  "twitch": {
    "channel": "twitch login"
  },
  "discord": {
    "server": "server snowflake id",
    "onlinePing": {
      "channel": "notification channel snowflake id",
      "role": "notification ping role NAME"
    },
    "reacjiRoles": {
      "messageSnowflake": "message snowflake id to watch for reactions",
      "bindings": {
        "reacji NAME": "role NAME"
      }
    }
  }
}
```

Create a file, `secrets.json`, in the project root, with the following structure:

```json
{
  "twitch": {
    "app": {
      "clientId": "twitch app client id",
      "clientSecret": "twitch app client secret",
    },
    "user": {
      "accessToken": "oauth user access token",
      "refreshToken": "oauth user refresh token",
      "scope": [],
      "obtainmentTimestamp": 0,
      "expiresIn": 0
    }
  },
  "discord": {
    "token": "discord app api token"
  }
}
```

The secrets file will need to be persisted, since it will be updated as the user access token expires and gets refreshed. So, if you're running in Docker, use a volume or mount.

## Twitch setup

You'll need to create a Twitch app, and use it to fetch an initial [User access token](https://dev.twitch.tv/docs/authentication/#user-access-tokens). Use the "Authorization code grant flow". No scopes are required, and no access is required; this is currently only used for EventSub subscriptions and stream status checking, neither of which require permission from the target streamer.

The user of the access token does not need to be the same user as the target streamer, but can be.

Add the login (e.g. the name in the URL) of the stream to watch in `config.json`'s `twitch.channel` property.

## Discord setup

You'll need to create a Discord app, generate an API token for it, and invite it to the target server. It should have at least the permissions "View Channels", "Manage Roles", and "View Message History".

Identify the server snowflake and the channel snowflake for the online notification channel (e.g. from the url when viewing the channel, the url should be something like `https://https://discord.com/channels/<server snowflake>/<channel snowflake>`)

Add the server snowflake to `config.json`'s `discord.server` property. Add the notification channel's snowflake to `discord.onlinePing.channel`.

Decide the role name to ping with notifications and add it to `discord.onlinePing.role`.

Create a post for reacji roles in some channel, and identify the message snowflake. You can get these via "copy message url" on the target message, it should be something like `https://discord.com/channels/<server snowflake>/<channel snowflake>/<message snowflake>`.

Add or assign emojis to trigger role add/remove, and add them to `config.json`'s `discord.reacjiRoles.bindings` property as an object with the emoji name as the key and the target role as the value.

# Docker quickstart

```sh
docker build -t IMAGE_NAME .
docker run --init --rm \
  -v "$PWD/config.json:/bot/config.json" \
  -v "$PWD/secrets.json:/bot/secrets.json" \
  -it IMAGE_NAME
```

