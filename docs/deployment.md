# Deployment

How to keep the bot running day to day.

**The default recommendation:** on a home computer (a Mac or a Linux machine that stays on), run
plain `bun start` under your operating system's service manager: [launchd](#launchd-mac) on a Mac,
[systemd](#systemd-linux) on Linux. That is the same thing you ran while setting up, kept alive and
restarted after a reboot. On a server or small cloud machine, use [Docker Compose](#docker-compose)
instead.

| Way | Good for | You need |
| --- | --- | --- |
| [launchd](#launchd-mac) | A Mac that stays on. **Default for a home Mac.** | Bun (already installed). |
| [systemd](#systemd-linux) | A Linux machine. **Default for a home Linux computer.** | Bun (already installed). |
| [Docker Compose](#docker-compose) | A server or small cloud machine. The easiest to update and move. **Default for a server.** | Docker with the Compose plugin, installed first (https://docs.docker.com/get-docker/). |
| [Plain `bun start`](#plain-bun-start) | Trying it out. It stops when you close the terminal. | Bun. |

Whichever you choose, do the setup in the [README](../README.md) first (`config.toml`, `.env`,
`data/profile.md`, `bun run doctor`). All deployment files are in the `deploy/` folder.

**Secrets work the same way everywhere:** they live in the `.env` file in the project folder. Bun
reads it by itself when the bot starts in that folder; Docker and systemd are also pointed at it
(below). Run the commands in this guide **in the project folder** unless it says otherwise.

The bot is one process, and **only one copy may run at a time** per chat app account. It also needs
a second thing: the **watchdog** (`bun run check-health`), run about once a minute by something
other than the bot, so you hear about it when the bot itself is down. Each option below sets that up.
What the watchdog checks is in [operations.md](operations.md).

## Docker Compose

Needs Docker and the Compose plugin installed (`docker compose version` should print a version).

1. In the project folder, make your files (they are not baked into the image):

   ```
   cp config.example.toml config.toml        # and edit it
   cp .env.example .env                      # and fill in your secrets
   mkdir -p data state
   cp data.example/profile.md data/profile.md   # and edit it
   ```

   The container runs as an ordinary user (user ID 1000). If your `data` and `state` folders belong
   to someone else, give them to that user: `sudo chown -R 1000:1000 data state`.
2. Check the setup inside the image, which uses the same files as the real run:

   ```
   docker compose -f deploy/compose.yaml run --rm planner bun run doctor
   ```

3. Start it:

   ```
   docker compose -f deploy/compose.yaml up -d --build
   docker compose -f deploy/compose.yaml logs -f
   ```

How it is wired: `config.toml` is mounted read-only at `/app/config.toml`; `data/` and `state/` are
mounted at `/app/data` and `/app/state`; secrets come from `.env` (compose.yaml has `env_file: ../.env`, which is the `.env` in the project folder); the container restarts
automatically (`unless-stopped`). The image's **health check** runs `check-health` every minute, so
`docker ps` shows `healthy` or `unhealthy`. (Docker marks a container unhealthy but does not
restart it for that; the bot's own failures end the process, and Docker restarts that.)

**Signal** needs `deploy/Dockerfile.signal`: change `dockerfile:` in `compose.yaml` and add the two
build arguments (a signal-cli version and its checksum). The file's header explains how to get the
checksum, and [platforms/signal.md](platforms/signal.md) covers registering the number inside the
container's state folder.

**WhatsApp** needs a published port for Meta's webhook calls. Uncomment the `ports:` lines in
`compose.yaml` and set `host = "0.0.0.0"` under `[messaging.whatsapp.webhook]` in `config.toml`.
Keep the published address on `127.0.0.1` and put your tunnel or reverse proxy in front of it.

**Alerts to your phone.** The Docker health check only changes a label. To be told, set
`[alerts] channel = "telegram"` in `config.toml` (see [configuration.md](configuration.md)); the
watchdog sends that message itself.

## systemd (Linux)

1. Put the code somewhere (the examples use `/opt/household-meal-planner`), run `bun install` there
   as the user that will run it (the examples use a user called `mealplanner`), and do the README
   setup. Make `.env` readable only by that user: `chmod 600 .env`. In `.env`, write
   `NAME=value` lines with no `export` and no quotes. The service files point `EnvironmentFile=` at
   this same `.env` and set `WorkingDirectory=` to the project folder.
2. Open the three files in `deploy/systemd/` and change the user, the folder, and the full path to
   `bun` (find it with `which bun`).
3. Install and start (as root):

   ```
   cp deploy/systemd/household-meal-planner.service \
      deploy/systemd/household-meal-planner-check.service \
      deploy/systemd/household-meal-planner-check.timer /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now household-meal-planner.service household-meal-planner-check.timer
   ```

4. Watch it: `journalctl -u household-meal-planner -f`. The watchdog's output is in
   `journalctl -u household-meal-planner-check`. Its service shows as "failed" while something is
   wrong; that is on purpose.

## launchd (Mac)

1. Run `bun install` in the code folder and do the README setup.
2. Copy the two files in `deploy/launchd/` to `~/Library/LaunchAgents/`, and replace every
   `/path/to/...` in them with real paths (`which bun` gives the path to bun). launchd does not read
   your shell profile, but it does not need to: the plist starts `bun` with the project folder as
   its working directory, and Bun reads the `.env` file there by itself. So your secrets stay in
   `.env` only (`chmod 600 .env`), and you do not copy them into the plist. (The comments inside
   the example plist mention putting keys in it; with `.env` in the project folder that is not
   needed.)
3. Load them:

   ```
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.household-meal-planner.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.household-meal-planner-check.plist
   ```

   Rename the `com.example` prefix first if you like; the file name and the `Label` inside should
   match.
4. Logs are in `state/bridge.log` and `state/check-health.log`.

A Mac that sleeps does not run the bot. Turn off sleep for the machine (System Settings, Energy).

## Plain `bun start`

```
bun start
```

runs the bot in the terminal and logs there. Stop it with Ctrl-C (it shuts down cleanly). Run
`bun run check-health` from another terminal to see what the watchdog thinks.

## Backups

Back up these, and nothing else is irreplaceable:

- `data/`: your profile, weekly plans, recipe catalog, and the log. This is your household's
  knowledge.
- `state/signal-cli/` (Signal only): the bot account's keys. Without it you must register the
  number again. **Keep backups of it private.**
- `config.toml` and `.env`: so you can rebuild. `.env` holds secrets, so store it as carefully as
  you would a password.

The rest of `state/` is the message journal, locks and markers. It is safe to lose while the bot is
stopped, but a bot restored from an old copy of it may repeat or skip an in-progress message (parts it never attempted are sent on restart; a part cut off mid-send is not resent), so
prefer not to restore it from long ago.

Stop the bot before copying, or copy while it is idle, so files are not caught half-written. The
bot writes plan files in a way that avoids half-written files, so a copy taken at any time is
normally fine.

## Updating

```
git pull
bun install
bun test              # optional
bun run doctor
```

then restart: `docker compose -f deploy/compose.yaml up -d --build`, or
`sudo systemctl restart household-meal-planner`, or for launchd
`launchctl kickstart -k gui/$(id -u)/com.example.household-meal-planner`.

Read the commit messages for anything marked as a change to `config.toml`; `bun run doctor` tells
you if your file no longer fits. For Signal, update signal-cli itself every few months too
([platforms/signal.md](platforms/signal.md)).

## Uninstalling

1. Stop and remove the services: `docker compose -f deploy/compose.yaml down`, or
   `systemctl disable --now household-meal-planner.service household-meal-planner-check.timer` and
   delete the files from `/etc/systemd/system/`, or `launchctl bootout` both launchd jobs and delete
   their plists.
2. Take the bot out of your chat group (and for Telegram, send `/revoke` to BotFather so the old
   token stops working).
3. Delete the folders: the code, and `data/` and `state/` when you are sure you do not want them
   (keep a backup of `data/` if there is any doubt).
4. Revoke the Anthropic API key in the Anthropic Console, and any other tokens you made for it.
