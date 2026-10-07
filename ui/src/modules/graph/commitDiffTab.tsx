import { DiffView } from "../../components/diff/DiffView";
import type { TabInstance } from "../../platform/tabs";

interface CommitFileParams extends Record<string, unknown> {
  repoId: string;
  oid: string;
  path: string;
  origPath?: string;
}

/** Tab type `commitdiff`: the read-only diff of a file as it changed in a commit. */
export default function CommitDiffTab(props: { tab: TabInstance }) {
  const p = () => props.tab.params as CommitFileParams;
  return <DiffView target={{ repoId: p().repoId, path: p().path, origPath: p().origPath }} source={{ kind: "commit", oid: p().oid }} />;
}
