import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { ChatGPTProvider } from '../src/relay/providers/adapters.ts';
import { Project } from '../src/relay/domain/entities.ts';
import { ProjectId } from '../src/relay/domain/types.ts';

async function runRealCreationAttempt() {
  const db = new MemoryRelayDatabase();
  const engine = new RelayEngine(db);

  // Register REAL production ChatGPTProvider
  const realProvider = new ChatGPTProvider();
  engine.registerProvider(realProvider);

  const api = new RelayApiService(db, engine);

  const projectId = 'proj-real-attempt' as ProjectId;
  const projectSlug = 'g-p-6a9d699a8a488191a554385d74bb9422';
  const plannerProjectUrl = `https://chatgpt.com/g/${projectSlug}/project`;

  await db.projects.save(
    new Project({
      id: projectId,
      name: 'Real Attempt Project',
      description: 'Project for testing live ChatGPT creation',
      canonicalPath: '/workspaces/real-attempt',
      plannerProjectUrl,
      workerWorkspacePath: '/workspaces/real-attempt',
      gitRoot: '/workspaces/real-attempt',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  console.log('=== REAL CREATION ATTEMPT EVIDENCE ===');
  console.log('Environment Platform:', process.platform);
  console.log('Project ID:', projectId);
  console.log('Configured Planner Project URL:', plannerProjectUrl);

  const knownBefore = await api.enumerateChatGPTConversations(projectId);
  const knownConvs = knownBefore.conversations ?? [];
  console.log('Conversations known before creation count:', knownConvs.length);
  console.log('Known IDs before creation:', knownConvs.map((c) => c.conversationId));

  const startTime = Date.now();
  const res = await api.createChatGPTPlannerSession(projectId, 'Real Attempt Planner');
  const elapsedMs = Date.now() - startTime;

  console.log('Elapsed ms:', elapsedMs);
  console.log('Creation Result Success/Adopted:', res.adopted);
  console.log('Conversation ID returned:', res.conversationId || '(none)');
  console.log('Conversation URL returned:', res.conversationUrl || '(none)');
  console.log('Partial flag:', res.partial ?? false);
  console.log('Error returned:', res.error ?? '(none)');
  console.log('Session ID returned:', res.runtime?.id ?? '(none)');
  console.log('External identity persisted:', res.runtime?.externalSessionId ?? '(none)');

  const reloaded = res.runtime?.id ? await db.runtimes.findById(res.runtime.id as any) : null;
  console.log('Persisted RuntimeSession in DB:', reloaded ? reloaded.id : '(none)');

  const associations = res.runtime?.id ? await db.associations.findBySessionId(res.runtime.id as any) : [];
  console.log('Association count:', associations.length);
  if (associations[0]) {
    console.log('Association provenance:', associations[0].provenance);
    console.log('Association verification state:', associations[0].verificationState);
  }
}

runRealCreationAttempt().catch((err) => {
  console.error('Fatal execution error:', err);
});
