import { ShieldX } from "lucide-react";

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

import { UnauthorizedSessionAction } from "./_components/unauthorized-session-action";

export default function UnauthorizedPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-4">
      <Empty className="max-w-md border bg-background">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldX aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle role="heading" aria-level={1}>
            Unauthorized Access
          </EmptyTitle>
          <EmptyDescription>
            You do not have permission to view the requested content. Please contact the site administrator if you
            believe this is an error.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <UnauthorizedSessionAction />
        </EmptyContent>
      </Empty>
    </main>
  );
}
