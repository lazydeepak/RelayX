import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import type { DetailField } from './detailViewModels.ts';

export const formatDateTime = (ts?: number): string =>
  ts ? new Date(ts).toLocaleString() : 'Not available';

export const CopyButton: React.FC<{ value: string }> = ({ value }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        if (navigator?.clipboard?.writeText) {
          navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => undefined,
          );
        }
      }}
      className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors shrink-0"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
};

export const FieldRow: React.FC<{ field: DetailField }> = ({ field }) => (
  <div className="flex items-start justify-between gap-3 py-1.5">
    <span className="text-slate-400 shrink-0">{field.label}</span>
    <span className="flex items-center gap-1 min-w-0 justify-end">
      <span
        className={`text-right break-all ${field.mono ? 'font-mono text-xs' : ''} ${
          field.state === 'value' ? 'text-slate-200 select-text' : 'text-slate-500 italic'
        }`}
        title={field.state === 'value' ? field.value : undefined}
      >
        {field.value}
      </span>
      {field.copyable && <CopyButton value={field.value} />}
    </span>
  </div>
);

export const DetailSection: React.FC<{
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  className?: string;
}> = ({ icon, title, children, className }) => (
  <section className={`rounded-lg bg-slate-950 border border-slate-800 p-4 ${className ?? ''}`}>
    <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-300 mb-2">
      {icon}
      {title}
    </h4>
    {children}
  </section>
);
