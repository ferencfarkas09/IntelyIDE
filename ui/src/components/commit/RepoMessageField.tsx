import { IconButton, Sparkles, TextArea } from "../../ui-kit";
import "./commit.css";
import { draftingRepo, draftRepoMessage, generateRepoTooltip } from "./generate";
import { t } from "../../i18n";
import { checkedFiles } from "../../store/selection";
import { MessageHistory } from "./MessageHistory";
import { invalidFields, repoMessage, setRepoMessage } from "./messageState";
import { repoName } from "../../store/actions";

/** Message field shown inside a repo row of the Changes tree in per-repo mode. */
export function RepoMessageField(props: { repoId: string }) {
  let field: HTMLTextAreaElement | undefined;
  const name = () => repoName(props.repoId);
  return (
    <div class="repo-message" data-repo-id={props.repoId}>
      <TextArea
        class="repo-message__field"
        ref={(el) => (field = el)}
        aria-label={t("commit.messageFor", { name: name() })}
        placeholder={t("commit.messageForPh", { name: name() })}
        minRows={1}
        maxRows={5}
        spellcheck={false}
        value={repoMessage(props.repoId)}
        invalid={invalidFields().has(props.repoId)}
        onInput={(e) => setRepoMessage(props.repoId, e.currentTarget.value)}
      />
      <div class="repo-message__tools">
        <MessageHistory onPick={(m) => setRepoMessage(props.repoId, m)} field={() => field} />
        <IconButton
          icon={Sparkles}
          label={t("commit.generate")}
          tooltip={checkedFiles(props.repoId).length ? generateRepoTooltip(name()) : t("changes.generateNothing")}
          size="sm"
          loading={draftingRepo(props.repoId)}
          disabled={checkedFiles(props.repoId).length === 0}
          onClick={() => void draftRepoMessage(props.repoId)}
        />
      </div>
    </div>
  );
}
