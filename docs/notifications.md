# Notifications

IntelyIDE tells you when a run needs you, so you can work in another window while agents work. Applies to version 1.2.0.

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

## Notes

- In the installed app the banner is the app's own (its name and icon). A development build is not an app bundle; there macOS shows the banner as the Script Editor, and a click opens the Script Editor.
- The text of a banner is built in the interface from the run's title and a fixed sentence in your language. Nothing is sent anywhere.
