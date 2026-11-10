# Platforms: what works where

The tool is Node.js, Chrome, and files. This page says what was run on which system, and which
optional features belong to one system only.

## What has been tested

| System | Status |
|---|---|
| Ubuntu 26.04 (GNOME on Wayland), Node 24, Google Chrome | The test suite, `doctor`, the dashboard page in a real Chrome, PDF printing, and the Codex writer wrapper were run here |
| macOS | The project this was forked from was built and used on macOS. The macOS-only features below were **not** re-run after the move to the neutral decision and writer interfaces |
| Windows | **Not tested.** The code avoids shell commands and knows the usual Chrome paths, but nothing was run there |

## What every system needs

- **Node.js 22 or newer.**
- **Google Chrome or Chromium.** The tool looks in the usual places for each system. When yours is
  somewhere else, set `CHROME_PATH` in `.env` to the full path. On Linux only the `.deb` build of
  Google Chrome was tested. A Chromium from snap or flatpak runs in its own sandbox and may not be
  able to use the profile folder the tool gives it.
- **A desktop session** for real runs. The tool drives its own Chrome window, which you can watch
  and take over. Only the PDF printing is headless.

`npx job-search doctor` checks all of this offline and prints the next thing to do.

## Optional features, by system

| Feature | macOS | Linux | Without it |
|---|---|---|---|
| Opening a file or link for you (`--open`, the Gmail consent page) | `open` | `xdg-open` (package `xdg-utils`) | The path or link is printed. Open it yourself |
| A notification when a form waits for you | `osascript` | `notify-send` (package `libnotify-bin`) | No notification. The terminal and the dashboard still say so |
| Storing the job-board password | The Keychain, set with `npx job-search accounts password` | No system keychain is used. Put it in `.env` as `JOB_SEARCH_ACCOUNTS_PASSWORD` | Only needed for boards that want an account (`docs/ACCOUNTS.md`) |
| The password dialog | A system dialog | Not available: `.env` is the way | |
| `npx job-search schedule install` | A LaunchAgent | Not built in: use cron or a systemd timer, below | Run `npx job-search daily` yourself |

On Linux, `.env` holds the password in plain text, readable by your user. Keep the file out of
shared folders and backups you do not control. It is in `.gitignore`, and nothing in the tool
prints it or hands it to the writer or to Chrome's command line.

## A daily run on Linux

The daily run needs your desktop session, because Chrome opens a window. Write your standing policy
first (`docs/DAILY.md`), rehearse with `npx job-search daily --dry`, and only then schedule it.

With cron (`crontab -e`), at 09:00 every day. Replace the path, and check your own values with
`echo $DISPLAY $WAYLAND_DISPLAY $XDG_RUNTIME_DIR` in a terminal:

```
0 9 * * * cd /home/you/job-search && XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 /usr/bin/node bin/job-search.js daily >> data/runs/daily.log 2>&1
```

With a systemd user timer, which starts inside your session and needs no display variables.
`~/.config/systemd/user/job-search-daily.service`:

```
[Unit]
Description=job-search daily run

[Service]
Type=oneshot
WorkingDirectory=/home/you/job-search
ExecStart=/usr/bin/node bin/job-search.js daily
```

`~/.config/systemd/user/job-search-daily.timer`:

```
[Unit]
Description=job-search daily run, every day at 09:00

[Timer]
OnCalendar=*-*-* 09:00:00
Persistent=false

[Install]
WantedBy=timers.target
```

Then `systemctl --user daemon-reload` and `systemctl --user enable --now job-search-daily.timer`.
To stop it: `systemctl --user disable --now job-search-daily.timer`. To ask a run that is working
to stop after its current application: `npx job-search daily --stop`.

These two examples were written for this page and were **not run as scheduled jobs**. Run the
command by hand once from the same folder before you rely on a schedule.

A scheduled run uses the settings in `.env`. It needs your writer to be signed in already, since
nobody is there to sign in, and it stops by itself at the decision limits in `.env` and in your
policy.
