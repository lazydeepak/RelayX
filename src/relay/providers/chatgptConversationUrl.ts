/** Browser-safe parser for authoritative ChatGPT project-conversation URLs. */
export function parseChatGPTConversationUrl(url: string): {
  projectId: string;
  conversationId: string;
} | null {
  if (!url || typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!(parsed.hostname === 'chatgpt.com' || parsed.hostname.endsWith('.chatgpt.com'))) return null;
  const match = parsed.pathname.match(/^\/g\/(g-p-[^/]+)\/c\/([^/?#]+)$/);
  if (!match?.[2]) return null;
  return { projectId: match[1], conversationId: match[2] };
}
