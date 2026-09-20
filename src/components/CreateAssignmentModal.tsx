import React, { useState } from 'react';
import { X, Send, ListTodo } from 'lucide-react';
import { UIPair } from '../types/ui.ts';

interface CreateAssignmentModalProps {
  pairs: UIPair[];
  isOpen: boolean;
  onClose: () => void;
  onCreate: (pairId: string, title: string, instruction: string) => void;
}

export const CreateAssignmentModal: React.FC<CreateAssignmentModalProps> = ({
  pairs,
  isOpen,
  onClose,
  onCreate,
}) => {
  const [selectedPairId, setSelectedPairId] = useState<string>(pairs[0]?.id || '');
  const [title, setTitle] = useState<string>('');
  const [instruction, setInstruction] = useState<string>('');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !instruction.trim()) return;
    onCreate(selectedPairId || pairs[0]?.id, title, instruction);
    setTitle('');
    setInstruction('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <ListTodo className="w-5 h-5 text-blue-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Create New Assignment</h3>
              <p className="text-xs text-slate-400">Delegate work through Relay Engine</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          <div>
            <label className="block text-slate-300 font-medium mb-1">Target Pair</label>
            <select
              value={selectedPairId}
              onChange={(e) => setSelectedPairId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500"
            >
              {pairs.map((pair) => (
                <option key={pair.id} value={pair.id}>
                  {pair.name} ({pair.workerName})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-slate-300 font-medium mb-1">Assignment Title</label>
            <input
              type="text"
              required
              placeholder="e.g. Implement retry exponential backoff"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-slate-300 font-medium mb-1">Detailed Instruction</label>
            <textarea
              required
              rows={4}
              placeholder="Provide exact instructions to be delivered into the worker runtime composer..."
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Create & Dispatch</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
