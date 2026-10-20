# Notifications

IntelyIDE tells you when a run needs you, so you can work in another window while agents work. Applies to version 1.11.0.

## What notifies you

| Event | Banner |
|---|---|
| An agent asks for a permission (a tool, a plan) | An agent needs your permission |
| An agent asks you a question | An agent has a question |
| A run finishes (the turn ended and the answer is there) | Run finished |
| A run fails | Run failed |

Each banner has a fixed sentence and the title of the run underneath. It never carries a command, a file name or a part of the answer, so it is fine to leave it on a screen others can see.

## When a banner appears

- Only while the IDE window is **in the background**. In front, the run itself shows what it needs.
- Once per kind and run within the gap you choose in Settings > Notifications (5 to 60 seconds), and at most twelve banners a minute over all runs, so ten agents on three servers do not bury your desktop.
- A state has to last for about a second: a request that a saved rule or a hard stop answers at once never needed you and does not notify.
- Banners do not depend on the menu-bar item. Switching the menu-bar item on or off changes nothing here.

## Click and the Dock

- A click on a banner brings the IDE forward, and the run that notified you opens. (macOS activates the app on a click; the IDE opens the run when its window gets focus within 90 seconds of a banner.)
- The Dock icon shows how many runs wait for you (permissions, questions, plan approvals), added to the count of the Happy integration if you use it. Switch it off in Settings > Notifications.

## Settings

Settings > Notifications has a master switch, one switch for each of the four events, the gap, a sound (off by default) and the Dock count. macOS has the last word: allow the app in System Settings > Notifications, and Focus modes silence banners as usual.

## Happy notifications by category

With the Happy integration on (Settings > Integrations > Happy), the inbox lists what the Happy server sends you: new orders, delivery news, invoices, chat and task items, and so on. Under **Notification categories** in the same screen you choose, for each kind, how it reaches you:

| Choice | In the inbox | In the count (status bar, Dock) | As a toast |
|---|---|---|---|
| **Alert** (the default) | yes | yes | yes |
| **Quiet** | yes, marked Quiet | no | no |
| **Off** | no | no | no |

- The kind of a notification is the `type` the server sends (else the first part of its event key, like `order` in `order.created`). The names for orders (`order...`), delivery (`deliver...`, `shipping`, `shipment`) and invoices (`invoice...`, `billing`) are folded into one row each; any other kind gets a row when its first notification arrives, and a row stays while it is set.
- The choices live in this app only (`happy.notificationKinds` in `settings.json`, at most 64 kinds). The notifications stay on the Happy server and in the Happy apps, and **Mark all read** in the inbox works on the server, so it marks the hidden ones too.
- The count is the server's own total, lowered by the unread notifications of the quiet and off kinds in the list the IDE has loaded (the newest 30, plus what arrived live). Notifications of a quiet or off kind that are older than that list are still in the total until the server's count moves.
- Chat messages in an open chat follow the level of each channel (the chat's own settings), not this table; this table decides what the inbox lists and counts.

### For the Happy admin app

The same choices fit a setting that is kept on the server, so that every app shows the same. The contract this app follows: a notification has a `type` (`order`, `delivery`, `invoice`, `chat`, `task`, `mention`, `deploy`, `error`, `warning` or a new lowercase word of letters, digits, `.`, `_` and `-`, at most 64 characters), a person has one mode for each type (`alert`, `quiet`, `off`; absent means `alert`), and `quiet` keeps an item in the list without counting or announcing it. If the Happy API gets such a per-person setting, this app can read it instead of its own.

## Notes

- In the installed app the banner is the app's own (its name and icon). A development build is not an app bundle; there macOS shows the banner as the Script Editor, and a click opens the Script Editor.
- The text of a banner is built in the interface from the run's title and a fixed sentence in your language. Nothing is sent anywhere.
