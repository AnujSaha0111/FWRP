import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Page } from '@/api/types';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Dialog } from './dialog';
import { Field, Textarea } from './form-controls';

/** Underlined tabs; the selected tab's panel is rendered by the caller. */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  items: Array<{ value: T; label: string; count?: number }>;
  label: string;
}) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label={label}>
      {items.map((t) => (
        <button
          key={t.value}
          role="tab"
          type="button"
          aria-selected={t.value === value}
          onClick={() => onChange(t.value)}
          className={cn(
            '-mb-px flex min-h-11 cursor-pointer items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors duration-200',
            t.value === value ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="tabular rounded-full bg-muted px-2 text-xs text-muted-foreground">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Pagination({ page, onChange }: { page: Pick<Page<unknown>, 'page' | 'totalPages' | 'hasNext' | 'hasPrev'>; onChange: (page: number) => void }) {
  if (page.totalPages <= 1) return null;
  return (
    <nav className="mt-4 flex items-center justify-between" aria-label="Pages">
      <Button variant="secondary" size="sm" disabled={!page.hasPrev} onClick={() => onChange(page.page - 1)}>
        <ChevronLeft aria-hidden="true" /> Previous
      </Button>
      <span className="tabular text-sm text-muted-foreground">
        Page {page.page} of {page.totalPages}
      </span>
      <Button variant="secondary" size="sm" disabled={!page.hasNext} onClick={() => onChange(page.page + 1)}>
        Next <ChevronRight aria-hidden="true" />
      </Button>
    </nav>
  );
}

/** Horizontally scrollable on small screens instead of breaking the layout. */
export function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-sm" aria-label={label}>
        {children}
      </table>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th scope="col" className={cn('border-b border-border bg-muted/60 px-4 py-2.5 font-medium text-muted-foreground', className)}>{children}</th>;
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn('border-b border-border px-4 py-3 align-top', className)}>{children}</td>;
}

/**
 * Confirmation for consequential actions. With `reasonLabel`, a reason is
 * required (min 3 characters) and passed to `onConfirm`.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  reasonLabel,
  reasonRequired = true,
  loading,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  reasonLabel?: string;
  reasonRequired?: boolean;
  loading?: boolean;
  onConfirm: (reason: string) => void;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const invalid = Boolean(reasonLabel) && reasonRequired && reason.trim().length < 3;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setReason('');
          setTouched(false);
        }
        onOpenChange(next);
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            loading={loading}
            onClick={() => {
              setTouched(true);
              if (!invalid) onConfirm(reason.trim());
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {reasonLabel && (
        <Field label={reasonLabel} required={reasonRequired} error={touched && invalid ? 'Give a short reason (3+ characters)' : undefined} className={children ? 'mt-4' : undefined}>
          {({ id, describedBy, invalid: inv }) => (
            <Textarea id={id} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={describedBy} aria-invalid={inv} />
          )}
        </Field>
      )}
    </Dialog>
  );
}
