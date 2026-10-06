import type { DesignEditor, EditRequest, EditorResponse } from '../types.js';

type Step = unknown | ((request: EditRequest) => unknown);

/**
 * Test editor that replays a fixed list of raw responses (or functions of the request), so
 * loop behavior like rollback and retries can be tested without any API. Once the script runs
 * out, it returns no edits. `requests` records what the loop sent, for assertions.
 */
export function createScriptedEditor(steps: Step[]): DesignEditor & { requests: EditRequest[] } {
  const requests: EditRequest[] = [];
  let next = 0;
  return {
    name: 'scripted',
    requests,
    async proposeEdits(request): Promise<EditorResponse> {
      requests.push(request);
      const step = steps[next++];
      const raw =
        step === undefined
          ? { summary: 'Nothing left to do.', edits: [] }
          : typeof step === 'function'
            ? (step as (r: EditRequest) => unknown)(request)
            : step;
      return { raw, model: 'scripted' };
    },
  };
}
