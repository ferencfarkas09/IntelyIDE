import plainReply from './scenarios/plain-reply.jsonl';
import toolPermission from './scenarios/tool-permission.jsonl';
import askQuestion from './scenarios/ask-question.jsonl';
import errorScenario from './scenarios/error.jsonl';
import throttle from './scenarios/throttle.jsonl';
import interrupt from './scenarios/interrupt.jsonl';
import subagentTree from './scenarios/subagent-tree.jsonl';
import hardStop from './scenarios/hard-stop.jsonl';
import delegateRoles from './scenarios/delegate-roles.jsonl';
import planApproval from './scenarios/plan-approval.jsonl';
import bashTwice from './scenarios/bash-twice.jsonl';
import mcpTools from './scenarios/mcp-tools.jsonl';
import notes from './scenarios/notes.jsonl';

export const SCENARIOS: Record<string, string> = {
  'plain-reply': plainReply,
  'tool-permission': toolPermission,
  'ask-question': askQuestion,
  error: errorScenario,
  throttle,
  interrupt,
  'subagent-tree': subagentTree,
  'hard-stop': hardStop,
  'delegate-roles': delegateRoles,
  'plan-approval': planApproval,
  'bash-twice': bashTwice,
  'mcp-tools': mcpTools,
  notes,
};
