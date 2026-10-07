import { BrowseChannelsDialog } from "./BrowseChannelsDialog";
import { chatDialog, closeChatDialog } from "./dialogs";
import { NewChannelDialog } from "./NewChannelDialog";
import { NewMessageDialog } from "./NewMessageDialog";
import { SearchDialog } from "./SearchDialog";

/** Mount once in ChatTab: renders the new-channel / browse / new-message / search dialogs, bound to the signals of `dialogs.ts`. */
export function ChatDialogs() {
  const is = (kind: NonNullable<ReturnType<typeof chatDialog>>["kind"]) => chatDialog()?.kind === kind;
  return (
    <>
      <NewChannelDialog open={is("newChannel")} onClose={closeChatDialog} />
      <BrowseChannelsDialog open={is("browse")} onClose={closeChatDialog} />
      <NewMessageDialog open={is("newMessage")} onClose={closeChatDialog} />
      <SearchDialog open={is("search")} channelId={chatDialog()?.channelId} onClose={closeChatDialog} />
    </>
  );
}
export default ChatDialogs;
