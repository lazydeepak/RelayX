import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkNativeApiCompatibility } from '../src/relay/providers/nativeApiCompatibility';

const string = { type: 'string' };
const array = (items: unknown) => ({ type: 'array', items });
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties) });
const response = (schema: unknown, media = 'application/json') => ({ responses: { '200': { content: { [media]: { schema } } } } });
const parameter = (name: string) => ({ name, in: 'path', required: true, schema: string });
function document() {
  const message = object({ id: string, sessionID: string, role: { type: 'string', enum: ['user', 'assistant'] } });
  return {
    openapi: '3.1.0', info: { version: '1' },
    components: { schemas: { Session: object({ id: string, directory: string }), Message: message } },
    paths: {
      '/session/{sessionID}': { get: { ...response({ $ref: '#/components/schemas/Session' }), parameters: [parameter('sessionID')] } },
      '/session/{sessionID}/message': { get: { ...response(array(object({ info: { $ref: '#/components/schemas/Message' }, parts: array({ type: 'object' }) }))), parameters: [parameter('sessionID')] } },
      '/session/{sessionID}/prompt_async': { post: { parameters: [parameter('sessionID'), { name: 'directory', in: 'query', required: false, schema: string }],
        requestBody: { content: { 'application/json': { schema: object({ messageID: { type: 'string', pattern: '^msg' }, model: object({ providerID: string, modelID: string }),
          parts: array({ oneOf: [object({ type: { type: 'string', const: 'text' }, text: string }), object({ type: { type: 'string', const: 'file' } })] }) }) } } },
        responses: { '204': { description: 'accepted' } } } },
      '/question': { get: response(array(object({ id: string, sessionID: string, questions: array(object({ question: string, header: string, options: array(object({ label: string, description: string })) })) }))) },
      '/question/{requestID}/reply': { post: { ...response({ type: 'boolean' }), parameters: [parameter('requestID')], requestBody: { content: { 'application/json': { schema: object({ answers: array(array(string)) }) } } } } },
      '/event': { get: response(string, 'text/event-stream') },
    },
  };
}
describe('native API structural compatibility', () => {
  it('accepts implemented response and ordered question-answer contracts', () => {
    assert.deepEqual(checkNativeApiCompatibility(document()), { sessionRead: true, messageRead: true, messageSend: true, executionTerminalRead: false, questionRead: true, questionReply: true, eventStream: true, blockers: ['UNSUPPORTED_CONTRACT:executionTerminalRead'] });
  });
  it('rejects declarations with no schemas and never assumes methods from paths', () => {
    const result = checkNativeApiCompatibility({ openapi: '3.1.0', paths: { '/session/{sessionID}': { post: response(string) }, '/question': { get: {} } } });
    assert.equal(result.blockers.length, 7);
  });
  it('requires exact session identity and project directory', () => {
    const doc = document(); doc.components.schemas.Session.required = ['id'];
    assert.equal(checkNativeApiCompatibility(doc).sessionRead, false);
  });
  it('requires exact path identities for session reads and question replies', () => {
    const doc = document();
    doc.paths['/session/{sessionID}'].get.parameters[0].required = false;
    doc.paths['/question/{requestID}/reply'].post.parameters[0].name = 'sessionID';
    const result = checkNativeApiCompatibility(doc);
    assert.equal(result.sessionRead, false); assert.equal(result.questionReply, false);
  });
  it('rejects pending questions without option labels', () => {
    const doc = document();
    const schema = doc.paths['/question'].get.responses['200'].content['application/json'].schema as { items: { properties: Record<string, unknown> } };
    schema.items.properties.questions = array(object({ question: string, header: string, options: array(object({ description: string })) }));
    assert.equal(checkNativeApiCompatibility(doc).questionRead, false);
  });
  it('rejects messages without exact session correlation', () => {
    const doc = document(); doc.components.schemas.Message.required = ['id', 'role'];
    assert.equal(checkNativeApiCompatibility(doc).messageRead, false);
  });
  it('requires the exact asynchronous text/model/directory/204 send contract', () => {
    const variants = [
      (doc: ReturnType<typeof document>) => { const schema = doc.paths['/session/{sessionID}/prompt_async'].post.requestBody.content['application/json'].schema;
        delete (schema.properties as Record<string, unknown>).messageID; },
      (doc: ReturnType<typeof document>) => { doc.paths['/session/{sessionID}/prompt_async'].post.parameters[1].name = 'workspace'; },
      (doc: ReturnType<typeof document>) => { const schema = doc.paths['/session/{sessionID}/prompt_async'].post.requestBody.content['application/json'].schema;
        (schema.properties as Record<string, unknown>).parts = array(object({ type: { type: 'string', const: 'file' } })); },
      (doc: ReturnType<typeof document>) => { const schema = doc.paths['/session/{sessionID}/prompt_async'].post.requestBody.content['application/json'].schema;
        (schema.properties as Record<string, unknown>).model = object({ modelID: string }); },
      (doc: ReturnType<typeof document>) => { doc.paths['/session/{sessionID}/prompt_async'].post.responses = { '200': { description: 'wrong ack' } } as never; },
    ];
    for (const mutate of variants) { const doc = document(); mutate(doc); assert.equal(checkNativeApiCompatibility(doc).messageSend, false); }
  });
  it('rejects unknown message roles rather than silently assigning an assistant role', () => {
    const doc = document(); (doc.components.schemas.Message.properties.role as { enum: string[] }).enum.push('unknown');
    assert.equal(checkNativeApiCompatibility(doc).messageRead, false);
  });
  it('requires every declared message variant to preserve identity', () => {
    const doc = document();
    const schema = doc.components.schemas as Record<string, unknown>;
    schema.Message = { anyOf: [object({ id: string, sessionID: string, role: { type: 'string', const: 'user' } }), object({ id: string, role: { type: 'string', const: 'assistant' } })] };
    assert.equal(checkNativeApiCompatibility(doc).messageRead, false);
    schema.Message = { oneOf: ['user', 'assistant'].map(role => object({ id: string, sessionID: string, role: { type: 'string', const: role } })) };
    assert.equal(checkNativeApiCompatibility(doc).messageRead, true);
  });
  it('recognizes terminal execution only from a typed assistant completion/error contract', () => {
    const doc = document(); const schema = doc.components.schemas as Record<string, unknown>;
    const error = object({ name: string });
    const assistant = object({ id: string, sessionID: string, role: { type: 'string', const: 'assistant' },
      time: { type: 'object', properties: { created: { type: 'integer' }, completed: { type: 'integer' } }, required: ['created'] },
      parentID: string, providerID: string, modelID: string, finish: string, error: { anyOf: [error] } });
    schema.Message = { oneOf: [object({ id: string, sessionID: string, role: { type: 'string', const: 'user' } }), assistant] };
    assert.equal(checkNativeApiCompatibility(doc).executionTerminalRead, true);
    delete (assistant.properties as Record<string,unknown>).finish;
    assert.equal(checkNativeApiCompatibility(doc).executionTerminalRead, false);
  });
  it('requires question identity and session identity independently', () => {
    const doc = document();
    (doc.paths['/question'].get.responses['200'].content['application/json'].schema as { items: { required: string[] } }).items.required = ['questions'];
    assert.equal(checkNativeApiCompatibility(doc).questionRead, false);
    assert.equal(checkNativeApiCompatibility(doc).questionReply, true);
  });
  it('rejects a generic chat answer body as a question reply', () => {
    const doc = document();
    const content = doc.paths['/question/{requestID}/reply'].post.requestBody.content as Record<string, unknown>;
    content['application/json'] = { schema: object({ text: string }) };
    assert.equal(checkNativeApiCompatibility(doc).questionReply, false);
  });
  it('rejects flat answer arrays and changed acknowledgement types', () => {
    const doc = document(); const reply = doc.paths['/question/{requestID}/reply'].post;
    (reply.requestBody.content['application/json'].schema.properties as Record<string, unknown>).answers = array(string);
    assert.equal(checkNativeApiCompatibility(doc).questionReply, false);
    (reply.requestBody.content['application/json'].schema.properties as Record<string, unknown>).answers = array(array(string));
    (reply.responses['200'].content['application/json'] as { schema: unknown }).schema = string;
    assert.equal(checkNativeApiCompatibility(doc).questionReply, false);
  });
  it('rejects a JSON endpoint as an event stream', () => {
    const doc = document(); (doc.paths['/event'] as { get: unknown }).get = response(string);
    assert.equal(checkNativeApiCompatibility(doc).eventStream, false);
  });
  for (const ref of ['https://remote.example/schema', '#/components/schemas/Missing', '#/components/schemas/Session']) {
    it(`fails closed on external, unresolved or circular reference ${ref}`, () => {
      const doc = document(); (doc.components.schemas as Record<string, unknown>).Session = { $ref: ref };
      assert.equal(checkNativeApiCompatibility(doc).sessionRead, false);
    });
  }
  it('supports escaped local schema references', () => {
    const doc = document(); (doc.components.schemas as Record<string, unknown>)['Session/Record~1'] = doc.components.schemas.Session;
    (doc.paths['/session/{sessionID}'].get.responses['200'].content['application/json'].schema as { $ref: string }).$ref = '#/components/schemas/Session~1Record~01';
    assert.equal(checkNativeApiCompatibility(doc).sessionRead, true);
  });
  it('does not ignore constraints adjacent to a reference or unsupported composition', () => {
    const doc = document();
    (doc.paths['/session/{sessionID}'].get.responses['200'].content['application/json'] as { schema: unknown }).schema = { $ref: '#/components/schemas/Session', type: 'string' };
    assert.equal(checkNativeApiCompatibility(doc).sessionRead, false);
    (doc.paths['/session/{sessionID}'].get.responses['200'].content['application/json'] as { schema: unknown }).schema = { allOf: [{ $ref: '#/components/schemas/Session' }] };
    assert.equal(checkNativeApiCompatibility(doc).sessionRead, false);
  });
  it('does not mutate the document while resolving references', () => {
    const doc = document(); const before = structuredClone(doc);
    checkNativeApiCompatibility(doc); assert.deepEqual(doc, before);
  });
});
