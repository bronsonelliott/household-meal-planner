# Operations

What to check, what the alerts mean, and what to do about them. For setting the bot up to run on its
own, see [deployment.md](deployment.md).

## The watchdog: `bun run check-health`

A dead bridge cannot tell you it is dead, so a second, small program watches from outside. Run it
about once a minute from something that is not the bot: a systemd timer, a launchd job, cron, or
Docker's health check (all set up in [deployment.md](deployment.md)).

It only **reads** the files the bot leaves in its state folder. It is designed not to start the bot's message handling or take the bot's lock, so running it at any
time, even by hand, is safe.

What it looks for:

| Check | It fires when |
| --- | --- |
| Heartbeat | The bridge has not had a healthy check of your chat app for more than 60 minutes, or has never had one. |
| Unanswered message | A household member's message has waited more than 15 minutes with no reply (and no deliberate silence was logged). |
| Draft not posted | The weekly draft is still not posted `lateAfterMinutes` (30 by default) after your configured draft time. It uses your own schedule and time zone from `config.toml`. |
| Week skipped | The bot gave up at the catch-up deadline and skipped the week. One alert per week. |
| Send failures | New entries in the send-failure record, apart from messages that are only waiting for a WhatsApp 24-hour window (those are delays, not failures). |

Each problem is reported **once** when it starts. The watchdog then stays quiet about it until it
clears, and if it comes back, it reports it again. An alert that could not be sent is tried again on
the next run.

**Exit code.** `0` means healthy. `1` means something is wrong right now, or an alert could not be
sent. `2` means it could not read `config.toml`. Run it by hand to see:

```
bun run check-health
```

**Where alerts go.** Always to the error output (the journal, the launchd log, `docker logs`). If
you set `[alerts] channel = "telegram"` in `config.toml`, also to a Telegram chat of your choice.
That works whichever chat app your household uses, because it is its own little bot just for alerts
([configuration.md](configuration.md)). With `channel = "none"` you will only see alerts if you look
at the logs, so set up the Telegram channel if you want your phone to buzz. The bot is designed not to say an
admin was notified unless the send went through.

## What each alert means

### "Heartbeat is stale"

The text starts "no healthy chat-app check for N minutes" (or "there is no heartbeat file").

The bridge touches a file every time it successfully checks that it can reach your chat app. If the
file is old, either the bridge is not running or it cannot reach the chat app.

1. Is it running? `docker ps`, `systemctl status household-meal-planner`, or
   `launchctl list | grep household-meal-planner`. If not, start it and read the last lines of its
   log for why it stopped.
2. If it is running, read its log. Typical causes:
   - **Signal:** signal-cli is out of date and Signal rejects it, or the bot's number was
     de-registered. Update signal-cli, or register again
     ([platforms/signal.md](platforms/signal.md)).
   - **Telegram:** the token was revoked or a second copy of the bot is running.
   - **WhatsApp:** the access token expired, or Meta cannot reach your tunnel.
   - **iMessage:** the Mac or BlueBubbles server is off, asleep, or its address changed.
   - The machine has no internet.
3. Restart the bridge after fixing the cause. The alert clears on its own once the heartbeat is
   fresh.

A brand-new install shows "there is no heartbeat file" until the bot has started successfully once.

### "A member's message has had no reply"

Someone wrote to the bot more than 15 minutes ago and nothing came back. The most likely causes are
the model (your Anthropic key is out of credit or rejected, or the service is down or rate-limited)
or a stuck bridge. Look at the log. If the key is the problem, the bot also stops its model calls,
posts one line in the chat, and rechecks every 30 minutes by itself; fix the key or add credit
([model.md](model.md)) and restart the bot if you changed the key. The held messages are
answered once the model works again; after 3 hours the bot asks the person to send theirs again.

### "The draft for the week of ... has not posted"

The bot should have posted the draft by your draft time plus the grace period, and has not. The
alert includes the last error the bot recorded (or says no try is recorded, which usually means the
bridge is not running). The bot keeps retrying until the catch-up deadline, so first fix what the
error says (usually the model key or the chat app) and let it retry. You can always plan the week
by talking to the bot once it is back.

### "The week of ... was skipped"

The catch-up deadline passed with no draft, so the bot skipped that week and will draft the next one
at the normal time. The message names the last error. Fix the cause (see the two alerts above) so it
does not happen again.

### "N send problems"

The bot tried to send something and it did not go through, or may not have. Each line says which
conversation or member and what happened:

- **a send failed after several tries:** the message was not delivered. Check the chat app is
  reachable, then ask the bot for the week again if you need it.
- **send-unknown:** the bot cannot tell whether it went out (for example the connection dropped at
  the wrong moment, or the chat service answered a send with a server error such as 502 or 503), so
  it did not send it again, to avoid a double. Look in the chat. Only "could not connect at all"
  (connection refused, name not found) is retried, because then nothing can have gone out.
- **A restart in the middle of a send:** the bot finishes what it never started. People or parts of a
  message it had not yet tried to send are sent when it starts again. A part it was in the middle of
  sending when it stopped may have gone out, so that one is not sent again and shows up as
  "send-unknown".
- **partial-send:** a group message did not reach one person. Check they are still in the group.
- **rate-limited (Signal):** Signal temporarily blocked sending. Follow "Rate limits" in
  [platforms/signal.md](platforms/signal.md).

A WhatsApp message held because the person has not written to the bot in 24 hours is **not** reported
here. It is delivered the next time they write.

### Model call alert ("model calls are stopped")

This one comes from the bridge, not the watchdog. Your Anthropic key was rejected or the account is
out of credit. See [model.md](model.md). The bot rechecks every 30 minutes and resumes by itself.

## House-rules setup in the chat

With no `data/profile.md` the bot interviews the adults in the chat when it starts (the first
setup), and writes the profile once an adult says "save it". These words work in the chat:

- **`set up house rules`** starts the interview, or picks it up again after "cancel setup". If a
  profile already exists this is a **redo**: the old rules stay in use until you approve new ones,
  and until the redo is saved or cancelled the bot reads your messages as interview answers, not as
  meal requests (recipe commands such as `sources` still work). After a redo is saved, "undo"
  within 30 minutes puts the old file back. The first setup has nothing to go back to, so it has no
  undo.
- **`cancel setup`** stops the interview. What you had answered is kept. A first setup that is
  cancelled stays cancelled across restarts, and drafting waits.
- **`use the sample`** loads the example rules as a proposal. It still has to be approved with
  "save it", and you can change it first.
- **`looks good`, `save it`, `save`, `yes save`** approve. Replying directly to the bot's read-back
  saves at once; any other "save it" gets one question first ("Save these rules: ...?", listing
  every rule with its check and the dishes, dislikes, never-agains and staples), so what you
  approve is exactly what you were shown. A "save it" only counts from an adult who received the
  whole read-back or question, and only if it was sent after that went out. If the profile file
  was edited by hand in the meantime, nothing is overwritten. A practice run (dry run) keeps its
  own journal, `state/batches.dry-run.jsonl`.

**"Awaiting profile"** is what the bot is doing when it has no profile and the first setup is not
finished (not started, cancelled or half done). It makes no draft attempts, writes no failed-draft
or skipped-week records, and sends one reminder per week, once draft time has passed
(`state/awaiting-profile-<week>.json` is its note that the reminder went out). The watchdog does
not alert about the missing draft while the setup's state file (`state/onboarding.json`) is
readable. Once you save, the bot looks at the schedule again from that moment: if the draft window
is open it drafts at once (marked late); otherwise it tells the chat when the next draft will be.
Weeks that went by are never drafted afterwards. A damaged `state/onboarding.json` is an alert
and stops the bridge from starting: fix it or move it aside. In a dry run the interview uses
`state/onboarding.dry-run.json` and never writes the profile.

## Pausing the bot

To stop the bot (a holiday, or while you change settings):

1. Stop the bot: `docker compose -f deploy/compose.yaml stop`, `sudo systemctl stop household-meal-planner`,
   `launchctl bootout gui/$(id -u)/com.example.household-meal-planner`, or Ctrl-C.
2. **Also stop the watchdog**, or it will correctly tell you the bridge is down every hour:
   stop the timer (`sudo systemctl stop household-meal-planner-check.timer`), the check job
   (`launchctl bootout gui/$(id -u)/com.example.household-meal-planner-check`), or in Docker the
   container's stop covers both.

While it is stopped, messages sent to it wait at your chat provider (how long depends on the
provider; Telegram keeps them for about a day). When it starts again it replays what it kept, and
catches up the weekly draft if the draft time passed (marked "late") up to the catch-up deadline.

To keep the bot running but make it send nothing (to test a change), start it with
`HMP_DRY_RUN=1 bun start`; what it would have sent appears in the log on lines starting `DRY RUN`
(those lines include the message text, which normal log lines do not) and in
`state/dry-run-sends.jsonl`.

To skip a single week from chat, ask the bot ("skip next week").

## Log, state and data folders

- **Logs:** whatever your service manager captures (`docker logs`, `journalctl`, the launchd log
  file). The bot's log lines are designed not to contain secrets or your message text (covered by the test
  suite).
- **`state/`:** the heartbeat file, the message journal, the house-rules interview's notes (`onboarding.json`), per-week draft markers
  (`friday-posted-<week>.json`, `friday-error-<week>.json`), the alert-state folder the watchdog uses
  to remember what it has already reported, and the send-failure record. To make the watchdog report
  something again, delete its file in `state/alert-state/`.
- **`data/`:** your profile, weekly plans, recipe catalog and log. See backups in
  [deployment.md](deployment.md).
