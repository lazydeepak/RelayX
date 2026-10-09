/** Conservative structural compatibility for the implemented SDK contract.
 * Declaration is evidence, never proof of runtime behavior or dispatch authority.
 */
export interface NativeApiCompatibility {
  sessionRead: boolean;
  messageRead: boolean;
  messageSend: boolean;
  executionTerminalRead: boolean;
  questionRead: boolean;
  questionReply: boolean;
  eventStream: boolean;
  blockers: string[];
}
type ObjectMap = Record<string, unknown>;
function object(value: unknown): value is ObjectMap {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function checkNativeApiCompatibility(document: unknown): NativeApiCompatibility {
  const blockers: string[] = [];
  const root = object(document) ? document : {};
  if (typeof root.openapi !== 'string' || !root.openapi.startsWith('3.')) return {
    sessionRead: false, messageRead: false, messageSend: false, executionTerminalRead: false, questionRead: false, questionReply: false, eventStream: false,
    blockers: ['UNSUPPORTED_OPENAPI_VERSION'],
  };
  const resolve = (schema: unknown, seen = new Set<string>()): ObjectMap | undefined => {
    if (!object(schema)) return undefined;
    if (typeof schema.$ref !== 'string') return schema;
    const ref = schema.$ref;
    if (!ref.startsWith('#/') || seen.has(ref) || seen.size >= 32) return undefined;
    let target: unknown = root;
    for (const key of ref.slice(2).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (!object(target) || !Object.hasOwn(target, key)) return undefined;
      target = target[key];
    }
    // Sibling constraints are not interpreted by this subset adapter.
    if (Object.keys(schema).some(key => !['$ref', 'description', 'summary'].includes(key))) return undefined;
    return resolve(target, new Set([...seen, ref]));
  };
  const type = (schema: unknown, expected: string): boolean => {
    const value = resolve(schema);
    return !!value && !value.allOf && !value.anyOf && !value.oneOf && value.type === expected;
  };
  const field = (schema: unknown, name: string, required: boolean): unknown => {
    const value = resolve(schema);
    if (!value || !type(value, 'object') || !object(value.properties)
      || (required && (!Array.isArray(value.required) || !value.required.includes(name)))) return undefined;
    return value.properties[name];
  };
  const items = (schema: unknown): unknown => type(schema, 'array') ? resolve(schema)?.items : undefined;
  const messageInfo = (schema: unknown): boolean => {
    const value = resolve(schema);
    if (!value) return false;
    const variants = value.oneOf ?? value.anyOf;
    if (Array.isArray(variants)) return variants.length > 0 && variants.every(branch => {
      // Prevent recursive unions from looping indefinitely.
      const resolved = resolve(branch);
      return !!resolved && !resolved.oneOf && !resolved.anyOf && messageInfo(resolved);
    });
    const role = resolve(field(value, 'role', true));
    const roles = role?.enum ?? (role?.const === undefined ? undefined : [role.const]);
    return type(field(value, 'id', true), 'string') && type(field(value, 'sessionID', true), 'string')
      && type(role, 'string') && Array.isArray(roles) && roles.length > 0
      && roles.every(role => role === 'user' || role === 'assistant');
  };
  const operation = (path: string, method: string): ObjectMap | undefined => {
    const paths = object(root.paths) ? root.paths : {};
    const item = resolve(paths[path]);
    return item && object(item[method]) ? item[method] as ObjectMap : undefined;
  };
  const pathParameter = (path: string, method: string, name: string): boolean => {
    const paths = object(root.paths) ? root.paths : {};
    const item = resolve(paths[path]);
    const op = operation(path, method);
    const parameters = [...(Array.isArray(item?.parameters) ? item.parameters : []), ...(Array.isArray(op?.parameters) ? op.parameters : [])];
    const matches = parameters.map(parameter => resolve(parameter)).filter(parameter => parameter?.in === 'path' && parameter.name === name);
    return matches.length === 1 && matches[0]?.required === true && type(matches[0]?.schema, 'string');
  };
  const parameter = (path: string, method: string, name: string, location: string, required?: boolean): boolean => {
    const paths = object(root.paths) ? root.paths : {};
    const item = resolve(paths[path]); const op = operation(path, method);
    const parameters = [...(Array.isArray(item?.parameters) ? item.parameters : []), ...(Array.isArray(op?.parameters) ? op.parameters : [])];
    const matches = parameters.map(candidate => resolve(candidate)).filter(candidate => candidate?.in === location && candidate.name === name);
    return matches.length === 1 && (required === undefined || matches[0]?.required === required) && type(matches[0]?.schema, 'string');
  };
  const response = (path: string, method: string, status: string): ObjectMap | undefined => {
    const op = operation(path, method);
    const responses = op && object(op.responses) ? op.responses : {};
    return resolve(responses[status]);
  };
  const responseSchema = (path: string, method = 'get', media = 'application/json', status = '200'): unknown => {
    const result = response(path, method, status);
    const content = result && object(result.content) ? result.content : {};
    return object(content[media]) ? content[media].schema : undefined;
  };
  const session = responseSchema('/session/{sessionID}');
  const sessionRead = pathParameter('/session/{sessionID}', 'get', 'sessionID')
    && type(field(session, 'id', true), 'string') && type(field(session, 'directory', true), 'string');
  const message = items(responseSchema('/session/{sessionID}/message'));
  const rawMessageInfo = field(message, 'info', true);
  const messageRead = pathParameter('/session/{sessionID}/message', 'get', 'sessionID')
    && messageInfo(rawMessageInfo) && type(field(message, 'parts', true), 'array');
  const resolvedMessageInfo = resolve(rawMessageInfo); const declaredMessageVariants = resolvedMessageInfo?.oneOf ?? resolvedMessageInfo?.anyOf;
  const messageVariants = Array.isArray(declaredMessageVariants) ? declaredMessageVariants.map(branch => resolve(branch)).filter(Boolean) : [resolvedMessageInfo];
  const assistantVariants = messageVariants.filter(candidate => {
    const role = resolve(field(candidate, 'role', true)); const values = role?.const === undefined ? role?.enum : [role.const];
    return Array.isArray(values) && values.length === 1 && values[0] === 'assistant';
  });
  const executionTerminalRead = messageRead && assistantVariants.length === 1 && assistantVariants.every(assistant => {
    const assistantTime = field(assistant, 'time', true); const error = resolve(field(assistant, 'error', false));
    const errorVariants = error?.oneOf ?? error?.anyOf;
    return type(field(assistantTime, 'completed', false), 'integer') && type(field(assistant, 'finish', false), 'string')
      && Array.isArray(errorVariants) && errorVariants.length > 0
      && errorVariants.every(branch => type(field(resolve(branch), 'name', true), 'string'));
  });
  const promptPath = '/session/{sessionID}/prompt_async'; const promptOperation = operation(promptPath, 'post');
  const promptRequest = resolve(promptOperation?.requestBody); const promptContent = promptRequest && object(promptRequest.content) ? promptRequest.content : {};
  const promptBody = object(promptContent['application/json']) ? promptContent['application/json'].schema : undefined;
  const promptParts = resolve(items(field(promptBody, 'parts', true))); const promptVariants = Array.isArray(promptParts?.oneOf) ? promptParts.oneOf : Array.isArray(promptParts?.anyOf) ? promptParts.anyOf : [promptParts];
  const acceptsText = promptVariants.some(candidate => {
    const part = resolve(candidate); const discriminator = resolve(field(part, 'type', true));
    const values = discriminator?.const === undefined ? discriminator?.enum : [discriminator.const];
    return Array.isArray(values) && values.length === 1 && values[0] === 'text' && type(field(part, 'text', true), 'string');
  });
  const promptModel = field(promptBody, 'model', false); const promptMessageId = resolve(field(promptBody, 'messageID', false));
  const ack = response(promptPath, 'post', '204');
  const messageSend = pathParameter(promptPath, 'post', 'sessionID')
    && parameter(promptPath, 'post', 'directory', 'query', false)
    && type(promptMessageId, 'string') && typeof promptMessageId?.pattern === 'string' && promptMessageId.pattern.startsWith('^msg')
    && type(field(promptBody, 'parts', true), 'array') && acceptsText
    && type(field(promptModel, 'providerID', true), 'string') && type(field(promptModel, 'modelID', true), 'string')
    && !!ack && (!object(ack.content) || Object.keys(ack.content).length === 0);
  const question = items(responseSchema('/question'));
  const questionInfo = items(field(question, 'questions', true));
  const option = items(field(questionInfo, 'options', true));
  const questionRead = type(field(question, 'id', true), 'string') && type(field(question, 'sessionID', true), 'string')
    && type(field(questionInfo, 'question', true), 'string') && type(field(questionInfo, 'header', true), 'string')
    && type(field(option, 'label', true), 'string') && type(field(option, 'description', true), 'string');
  const replyOperation = operation('/question/{requestID}/reply', 'post');
  const requestBody = resolve(replyOperation?.requestBody);
  const requestContent = requestBody && object(requestBody.content) ? requestBody.content : {};
  const replyBody = object(requestContent['application/json']) ? requestContent['application/json'].schema : undefined;
  const answers = field(replyBody, 'answers', true);
  const questionReply = pathParameter('/question/{requestID}/reply', 'post', 'requestID')
    && type(answers, 'array') && type(items(answers), 'array') && type(items(items(answers)), 'string')
    && type(responseSchema('/question/{requestID}/reply', 'post'), 'boolean');
  const eventStream = type(responseSchema('/event', 'get', 'text/event-stream'), 'string');
  const report = { sessionRead, messageRead, messageSend, executionTerminalRead, questionRead, questionReply, eventStream };
  for (const [capability, supported] of Object.entries(report)) if (!supported) blockers.push(`UNSUPPORTED_CONTRACT:${capability}`);
  return { ...report, blockers };
}
