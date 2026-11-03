import { Compass } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/surface';

export function NotFoundPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <EmptyState
        icon={<Compass />}
        title="Page not found"
        action={
          <Button asChild>
            <Link to="/">Go to your home page</Link>
          </Button>
        }
      >
        The page you opened does not exist or has moved.
      </EmptyState>
    </div>
  );
}
