import { read } from './api.ts';
import { JiraError } from './jira.ts';
import { object, type Runtime } from './rest.ts';

// Jira allows duplicate field names, so the checkbox type tells the board flag apart from a same-named field.
const CHECKBOXES = 'com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes';

export async function flaggedField(runtime: Runtime): Promise<string | undefined> {
  const raw = await read('/rest/api/3/field', new URLSearchParams(), runtime);
  if (!Array.isArray(raw))
    throw new JiraError('Malformed field list', 'bad_response');
  const matches: string[] = [];
  for (const entry of raw) {
    const field = object(entry);
    if (field.name !== 'Flagged' || field.schema == null || object(field.schema).custom !== CHECKBOXES)
      continue;
    if (typeof field.id !== 'string' || !field.id)
      throw new JiraError('Malformed Flagged field', 'bad_response');
    matches.push(field.id);
  }
  if (matches.length > 1)
    throw new JiraError(`Ambiguous Flagged field: ${matches.join(', ')}`, 'ambiguous_field');
  return matches[0];
}
