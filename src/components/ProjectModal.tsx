import React, { useState, useEffect } from 'react';
import { X, FolderPlus, Edit3, Trash2, Archive, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { UIProject } from '../types/ui.ts';
import { relayBridge } from '../services/relayBridge.ts';

export type ProjectModalMode = 'create' | 'edit';

interface ProjectModalProps {
  isOpen: boolean;
  mode: ProjectModalMode;
  project?: UIProject | null;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

export const ProjectModal: React.FC<ProjectModalProps> = ({
  isOpen,
  mode,
  project,
  onClose,
  onSuccess,
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [canonicalPath, setCanonicalPath] = useState('');
  const [gitRoot, setGitRoot] = useState('');
  const [plannerProjectUrl, setPlannerProjectUrl] = useState('');
  const [workerWorkspacePath, setWorkerWorkspacePath] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setErrorMessage(null);
      if (mode === 'edit' && project) {
        setName(project.name);
        setDescription(project.description || '');
        setCanonicalPath(project.canonicalPath || '');
        setGitRoot(project.gitRoot || '');
        setPlannerProjectUrl(project.plannerProjectUrl || '');
        setWorkerWorkspacePath(project.workerWorkspacePath || '');
      } else if (mode === 'create') {
        setName('');
        setDescription('');
        setCanonicalPath('');
        setGitRoot('');
        setPlannerProjectUrl('');
        setWorkerWorkspacePath('');
      }
    }
  }, [isOpen, mode, project]);

  if (!isOpen) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMessage('Project name is required');
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      if (mode === 'create') {
        await relayBridge.createProject(name.trim(), description.trim());
        onSuccess(`Project "${name}" created successfully`);
      } else if (mode === 'edit' && project) {
        await relayBridge.updateProject(project.id, {
          name: name.trim(),
          description: description.trim(),
          canonicalPath: canonicalPath.trim() || undefined,
          gitRoot: gitRoot.trim() || undefined,
          plannerProjectUrl: plannerProjectUrl.trim() || undefined,
          workerWorkspacePath: workerWorkspacePath.trim() || undefined,
        });
        onSuccess(`Project "${name}" configuration updated`);
      }
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || 'An unexpected error occurred');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            {mode === 'create' && <FolderPlus className="w-5 h-5 text-blue-400" />}
            {mode === 'edit' && <Edit3 className="w-5 h-5 text-blue-400" />}
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                {mode === 'create' && 'Create New Project'}
                {mode === 'edit' && 'Edit Project Details'}
              </h3>
              <p className="text-xs text-slate-400">
                {mode === 'create' && 'Organize session pairs and assignments'}
                {mode === 'edit' && `Update metadata for "${project?.name}"`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSave} className="p-5 space-y-4 text-xs">
            {errorMessage && (
              <div className="p-3 rounded-lg bg-red-950/40 border border-red-500/40 text-red-300 text-xs">
                {errorMessage}
              </div>
            )}

            <div>
              <label className="block text-slate-300 font-medium mb-1.5">Project Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Core App Architecture"
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500"
                required
              />
            </div>

            <div>
              <label className="block text-slate-300 font-medium mb-1.5">Description (Optional)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Describe project purpose and architectural goals..."
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500 resize-none"
              />
            </div>

            {/* Architectural & Destination Configuration */}
            <div className="pt-2 border-t border-slate-800 space-y-3">
              <span className="text-[11px] font-semibold uppercase text-slate-400 block">
                Repository &amp; Destination Configuration
              </span>

              <div>
                <label className="block text-slate-300 font-medium mb-1">
                  Canonical Workspace Path
                </label>
                <input
                  type="text"
                  value={canonicalPath}
                  onChange={(e) => setCanonicalPath(e.target.value)}
                  placeholder="/Users/username/src/my-project"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 font-mono text-xs focus:outline-none focus:border-blue-500"
                />
                <span className="text-[10px] text-slate-500 block mt-0.5">
                  Changing path will invalidate stale session associations.
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-medium mb-1">
                    Git Root (Optional)
                  </label>
                  <input
                    type="text"
                    value={gitRoot}
                    onChange={(e) => setGitRoot(e.target.value)}
                    placeholder="/Users/username/src/my-project"
                    className="w-full px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 font-mono text-xs focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-300 font-medium mb-1">
                    Worker Workspace Path
                  </label>
                  <input
                    type="text"
                    value={workerWorkspacePath}
                    onChange={(e) => setWorkerWorkspacePath(e.target.value)}
                    placeholder="Defaults to Canonical Path if empty"
                    className="w-full px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 font-mono text-xs focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">
                  Planner Destination URL (ChatGPT Project / GPT)
                </label>
                <input
                  type="text"
                  value={plannerProjectUrl}
                  onChange={(e) => setPlannerProjectUrl(e.target.value)}
                  placeholder="https://chatgpt.com/g/g-p-67... or https://chatgpt.com"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 font-mono text-xs focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !name.trim()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium shadow-md transition-colors"
              >
                {mode === 'create' ? (
                  <>
                    <FolderPlus className="w-3.5 h-3.5" />
                    <span>Create Project</span>
                  </>
                ) : (
                  <>
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>Save Changes</span>
                  </>
                )}
              </button>
            </div>
          </form>
      </div>
    </div>
  );
};
