import { Leaf } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

export function AuthLayout({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="hidden flex-col justify-between bg-primary p-10 text-primary-foreground lg:flex">
        <Link to="/" className="flex items-center gap-2 text-lg font-semibold">
          <span className="flex size-9 items-center justify-center rounded-lg bg-white/15">
            <Leaf className="size-5" aria-hidden="true" />
          </span>
          FWRP
        </Link>
        <div className="max-w-md">
          <p className="text-3xl font-semibold leading-tight">Good food should feed people, not landfills.</p>
          <p className="mt-4 text-primary-foreground/85">
            Restaurants and hotels list surplus food, verified shelters and food banks claim it, and volunteers deliver it — before it expires.
          </p>
        </div>
        <p className="text-sm text-primary-foreground/70">Food Waste Redistribution Platform</p>
      </aside>

      <main className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <Link to="/" className="mb-8 flex items-center gap-2 font-semibold lg:hidden">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Leaf className="size-5" aria-hidden="true" />
            </span>
            FWRP
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1.5 text-muted-foreground">{description}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 text-center text-sm text-muted-foreground">{footer}</div>}
        </div>
      </main>
    </div>
  );
}
