/** Only the currently mounted editor can flush its own inputs before assistant handoff. */
let editor: { projectId: string; actorId: string; flush: () => Promise<boolean> } | undefined;
export function registerAssistantFlush(
  projectId: string,
  actorId: string,
  flush: () => Promise<boolean>,
) {
  const registration = { projectId, actorId, flush };
  editor = registration;
  return () => {
    if (editor === registration) editor = undefined;
  };
}
export async function flushAssistantInput(projectId: string, actorId: string) {
  return editor?.projectId === projectId && editor.actorId === actorId ? editor.flush() : true;
}
